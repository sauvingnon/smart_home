#!/usr/bin/env python3
"""
Ручная чистка старых сообщений чата.

Сообщения чата больше не удаляются сами по себе по времени (текст решили
хранить вечно — см. project_chat_attachments) — это единственный способ
стереть старую историю, и то только руками, когда сам решишь, что пора.
Удаляет сообщение целиком (текст + медиа в S3), не только файл — в отличие
от ротации по 10-ГБ квоте (ChatService._enforce_media_quota), которая трогает
только файлы, не трогая текст.

Запуск (на сервере, внутри контейнера esp_service):
    docker exec -it esp_service python chat_cleanup.py --older-than-days 365
    docker exec -it esp_service python chat_cleanup.py --older-than-days 365 --yes

Без --yes — только dry-run: считает и печатает, ничего не удаляет.
С --yes — второе подтверждение прямо в терминале перед реальным удалением.

Если в момент запуска у кого-то открыт чат — его лента обновится только
после перезахода: скрипт удаляет отдельным процессом и рассылку по
WebSocket живым клиентам сделать не может.
"""
import argparse
import asyncio
from datetime import datetime, timedelta

from app.services.chat_service.chat_service import ChatService
from app.services.redis.cache_manager import CacheManager
from app.services.s3_service.s3_manager import S3Manager
from app.utils.time import _get_izhevsk_time
from config import REDIS_URL


async def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--older-than-days", type=int, required=True, help="удалить сообщения старше N дней")
    parser.add_argument("--yes", action="store_true", help="реально удалить (без флага — только посчитать)")
    args = parser.parse_args()

    if args.older_than_days < 30:
        print("❌ Меньше 30 дней — похоже на опечатку, отменено.")
        return

    cache = CacheManager(REDIS_URL)
    if not await cache.connect():
        print("❌ Не удалось подключиться к Redis.")
        return

    # Те же креды, что в main.py (garage/S3) — держать в синхроне при ротации.
    s3 = S3Manager(
        endpoint_url="http://garage:3900",
        access_key="GK39eb72624df14cf0b66afa79",
        secret_key="b607bde5e96a7f99175f9945441bd059d366e404655394e44f4bbc835b5accd7",
        bucket_name="video-bucket",
    )
    await s3.connect()
    chat = ChatService(cache, s3)

    try:
        cutoff = _get_izhevsk_time() - timedelta(days=args.older_than_days)
        print(f"Ищу сообщения старше {cutoff.date()} ({args.older_than_days} дн.)...")

        seqs = await cache.get_all_chat_seqs()
        to_delete = []
        bytes_freed = 0
        for seq in seqs:
            message = await cache.get_chat_message(seq)
            if not message:
                continue
            try:
                ts = datetime.fromisoformat(message["ts"])
            except (KeyError, ValueError):
                continue
            # seq растёт вместе со временем — как только дошли до свежего
            # сообщения, дальше все будут только свежее, дальше можно не идти.
            if ts >= cutoff:
                break
            to_delete.append(seq)
            bytes_freed += int(message.get("file_size") or 0)

        if not to_delete:
            print("✅ Нечего чистить — всё свежее указанного срока.")
            return

        print(f"Найдено сообщений на удаление: {len(to_delete)}")
        print(f"Освободится места в S3 (файлы этих сообщений): ~{bytes_freed / (1024 * 1024):.1f} МБ")

        if not args.yes:
            print("\nЭто был dry-run — ничего не удалено. Повтори с флагом --yes, чтобы удалить.")
            return

        confirm = input(f"\nТочно удалить {len(to_delete)} сообщений безвозвратно? Напиши 'да': ").strip().lower()
        if confirm not in ("да", "yes", "y"):
            print("Отменено.")
            return

        deleted = 0
        for seq in to_delete:
            if await chat.admin_delete_message(seq):
                deleted += 1
        print(f"✅ Удалено сообщений: {deleted}")
    finally:
        await cache.disconnect()
        await s3.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
