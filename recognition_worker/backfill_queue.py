"""
Разовый скрипт: находит в S3 видео, для которых ещё нет результата
распознавания (recognition/{camera_id}/{video_id}.json), и докидывает их
в очередь recognition:queue. Нужен специально для видео, загруженных ДО
того как upload_chunk начал сам ставить видео в очередь (6 августа) —
такие видео никогда не попадали в обработку и сами по себе туда не попадут.

Usage:
    python backfill_queue.py --dry-run   # сначала посмотреть, что найдётся
    python backfill_queue.py             # реально поставить в очередь

Env: REDIS_URL, S3_ENDPOINT_URL, S3_BUCKET_NAME, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
"""
import argparse
import os
import sys
from datetime import datetime

import boto3
import redis
from botocore.exceptions import ClientError

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

QUEUE_KEY = "recognition:queue"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="только показать что было бы поставлено в очередь, не трогать Redis")
    args = ap.parse_args()

    r = redis.Redis.from_url(os.environ["REDIS_URL"])
    s3 = boto3.client(
        "s3",
        endpoint_url=os.environ["S3_ENDPOINT_URL"],
        aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
    )
    bucket = os.environ["S3_BUCKET_NAME"]

    paginator = s3.get_paginator("list_objects_v2")
    checked = 0
    queued = 0
    already_done = 0
    skipped_no_meta = 0

    for page in paginator.paginate(Bucket=bucket, Prefix="videos/"):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            if not key.endswith(".mp4"):
                continue
            checked += 1

            head = s3.head_object(Bucket=bucket, Key=key)
            meta = head.get("Metadata", {})
            camera_id = meta.get("camera-id")
            video_id = meta.get("video-id")
            start_time_iso = meta.get("start-time")

            if not camera_id or not video_id or not start_time_iso:
                skipped_no_meta += 1
                print(f"  ⚠️ {key}: нет нужных метаданных, пропускаю")
                continue

            result_key = f"recognition/{camera_id}/{video_id}.json"
            try:
                s3.head_object(Bucket=bucket, Key=result_key)
                already_done += 1
                continue  # результат уже есть, трогать не нужно
            except ClientError as e:
                if e.response["Error"]["Code"] not in ("404", "NoSuchKey"):
                    raise

            start_ts = int(datetime.fromisoformat(start_time_iso).timestamp())
            job = f"{camera_id}:{video_id}:{start_ts}"

            if args.dry_run:
                print(f"[dry-run] поставил бы: {job}")
            else:
                r.lpush(QUEUE_KEY, job)
                print(f"поставлено: {job}")
            queued += 1

    print(f"\nПроверено видео: {checked}")
    print(f"Уже обработано: {already_done}")
    print(f"Без метаданных (пропущено): {skipped_no_meta}")
    print(f"{'Было бы поставлено' if args.dry_run else 'Поставлено'} в очередь: {queued}")


if __name__ == "__main__":
    main()
