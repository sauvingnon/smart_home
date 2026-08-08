"""
Долгоживущий воркер: раз в POLL_INTERVAL_SECONDS проверяет очередь в Redis.
Если пусто — ничего не грузит и засыпает дальше. Если есть работа — тянет
видео из S3(Garage) по одному, гонит pipeline, кладёт результат обратно
в S3, разбирает очередь до конца и выгружает модели из памяти до следующей
находки работы (тесно по RAM на VPS, держать их в памяти простаивая смысла нет).

Формат job'а в очереди (кладёт esp_service при сохранении видео):
    "{camera_id}:{video_id}:{start_unix_timestamp}"

Env:
    REDIS_URL, S3_ENDPOINT_URL, S3_BUCKET_NAME,
    AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, POLL_INTERVAL_SECONDS (по умолчанию 60)
"""
import os

# ДО импорта onnxruntime — иначе он по умолчанию хватает все ядра хоста под
# свои thread pool'ы, а тут всего 2 ядра и один из них должен оставаться
# свободным для esp_service (аплоад видео с камеры, ffmpeg).
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")

import gc
import json
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import boto3
import joblib
import redis
from insightface.app import FaceAnalysis

from run_pipeline import process_video
from yolo_onnx import PersonDetectorONNX

QUEUE_KEY = "recognition:queue"
LOCK_KEY = "recognition:lock"
LOCK_TTL_SECONDS = 900  # страховка на случай, если воркер зависнет/упадёт не освободив лок
POLL_INTERVAL_SECONDS = int(os.environ.get("POLL_INTERVAL_SECONDS", "60"))
REFERENCES_PATH = "references.joblib"  # эталонные эмбеддинги людей, см. enroll.py
IZHEVSK_TZ = timezone(timedelta(hours=4))


class PipelineArgs:
    """Дефолты — совпадают с run_pipeline.py, чтобы process_video работал без изменений."""
    sample_interval = 0.05  # секунды между сэмплами; при обычном fps камеры это фактически каждый кадр
    person_conf = 0.4
    face_det_thresh = 0.6
    min_face_px = 50
    min_blur = 30.0
    sim_threshold = 0.38  # минимальная косинусная близость к эталону
    topk = 5              # сколько ближайших эталонов человека усредняем
    margin = 0.05         # отрыв от второго кандидата, иначе решаем что неоднозначно
    track_iou_thresh = 0.3         # порог IoU, чтобы считать bbox продолжением того же трека
    track_max_gap_seconds = 1.0    # сколько трек может быть без детекции, прежде чем считать что закончился


def video_key_for(camera_id: str, video_id: str, start_ts: int) -> str:
    """Тот же формат ключа, что использует esp_service при сохранении (s3_manager.py)."""
    dt = datetime.fromtimestamp(start_ts, tz=IZHEVSK_TZ)
    return f"videos/{camera_id}/{dt.strftime('%Y')}/{dt.strftime('%m')}/{dt.strftime('%d')}/{video_id}.mp4"


def process_queue(r: "redis.Redis") -> None:
    """Разбирает очередь целиком, если в ней есть работа. Модели живут только
    в теле этой функции — как только она возвращается, они выходят из области
    видимости и освобождаются (см. gc.collect() в вызывающем цикле)."""

    if r.llen(QUEUE_KEY) == 0:
        return

    if not os.path.exists(REFERENCES_PATH):
        print(f"⚠️ нет {REFERENCES_PATH} — эталоны людей не заведены (см. enroll.py), очередь не трогаем")
        return

    # Лок против пересечения соседних прогонов (на случай если предыдущий
    # не уложился в интервал опроса) — второй воркер не должен параллельно
    # держать в памяти те же модели на тесной по RAM машине.
    if not r.set(LOCK_KEY, "1", nx=True, ex=LOCK_TTL_SECONDS):
        print("другой воркер уже обрабатывает очередь, пропускаем")
        return

    try:
        s3 = boto3.client(
            "s3",
            endpoint_url=os.environ["S3_ENDPOINT_URL"],
            aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
        )
        bucket = os.environ["S3_BUCKET_NAME"]

        print("есть работа, гружу модели...")
        yolo = PersonDetectorONNX("yolov8n.onnx", conf=PipelineArgs.person_conf)
        face_app = FaceAnalysis(name="buffalo_l", allowed_modules=["detection", "recognition"], providers=["CPUExecutionProvider"])
        face_app.prepare(ctx_id=-1, det_size=(640, 640))
        rec_model = face_app.models["recognition"]
        references = joblib.load(REFERENCES_PATH)
        args = PipelineArgs()

        processed = 0
        while True:
            job = r.rpop(QUEUE_KEY)
            if job is None:
                break

            try:
                camera_id, video_id, start_ts = job.decode().split(":")
                key = video_key_for(camera_id, video_id, int(start_ts))
                print(f"[{video_id}] обрабатываю, ключ={key}")

                with tempfile.NamedTemporaryFile(suffix=".mp4") as tmp:
                    s3.download_fileobj(bucket, key, tmp)
                    tmp.flush()
                    result = process_video(Path(tmp.name), yolo, face_app, rec_model, references, args)
                    result["video"] = f"{video_id}.mp4"  # у process_video тут был бы temp-путь, не настоящее имя

                result_key = f"recognition/{camera_id}/{video_id}.json"
                s3.put_object(
                    Bucket=bucket,
                    Key=result_key,
                    Body=json.dumps(result, ensure_ascii=False).encode(),
                    ContentType="application/json",
                )
                processed += 1
                present = [c for c, info in result["presence"].items() if info["present"]]
                print(f"[{video_id}] готово -> {result_key} | present: {present or '-'}")

            except Exception as e:
                print(f"⚠️ job {job!r} упал: {e}")
                continue

        print(f"очередь пуста, обработано за прогон: {processed}")

    finally:
        r.delete(LOCK_KEY)


def main():
    r = redis.Redis.from_url(os.environ["REDIS_URL"])
    print(f"recognition_worker запущен, опрос очереди каждые {POLL_INTERVAL_SECONDS}с")

    while True:
        try:
            process_queue(r)
        except Exception as e:
            print(f"⚠️ прогон обработки очереди упал: {e}")
        gc.collect()  # выгружаем модели из памяти на время простоя
        time.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
