# app/services/chat_service/chat_service.py
import asyncio
import json
import uuid
from typing import Optional, Set

from fastapi import WebSocket

from app.core.auth import COOKIE_NAME
from app.services.push_service.push_service import send_push, PushSubscriptionExpired
from app.services.redis.cache_manager import CacheManager
from app.services.s3_service.s3_manager import S3Manager
from app.utils.time import _get_izhevsk_time
from logger import logger

# Жёсткие лимиты на аплоад — сервер не транскодирует, кодирование на клиенте,
# поэтому единственная защита от раздутия Garage/трафика — потолок на размер.
CHAT_MEDIA_MAX_BYTES = 25 * 1024 * 1024  # 25 МБ

ALLOWED_MEDIA_TYPES = {
    "image/jpeg", "image/png", "image/webp",
    "audio/webm", "audio/ogg", "audio/mpeg", "audio/mp4",  # audio/mp4 — дефолт MediaRecorder на iOS Safari
    "video/webm", "video/mp4", "video/quicktime",  # .mov — типичный формат iPhone-галереи
}

_EXT_BY_CONTENT_TYPE = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "video/webm": "webm",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
}

_PUSH_BODY_BY_TYPE = {
    "image": "📷 Фото",
    "audio": "🎤 Голосовое сообщение",
    "video": "🎬 Видео",
}


class ChatService:
    """Общий групповой чат — один канал на всех, без списка чатов и личных сообщений."""

    def __init__(self, cache_manager: CacheManager, s3_manager: S3Manager):
        self.cache = cache_manager
        self.s3 = s3_manager
        self.viewers: Set[WebSocket] = set()

    def connected_user_ids(self) -> Set[int]:
        """Юзеры, у кого сейчас открыт /chat/ws (используется для Web Push — пушим
        только тем, кого здесь нет)."""
        return {ws.state.user_id for ws in self.viewers if hasattr(ws.state, "user_id")}

    async def handle_ws(self, websocket: WebSocket):
        """Реалтайм-канал чата. Только server→client (message/read/ping) — отправка
        сообщений и read-отметки идут через REST, WS тут как у зрителя камеры."""
        await websocket.accept()
        added = False

        try:
            access_key = websocket.cookies.get(COOKIE_NAME)
            if not access_key:
                await websocket.send_text("ERROR: Not authenticated")
                return

            # Именно cache.validate_key, а не auth_manager.verify_access_key —
            # тот при невалидном ключе кидает HTTPException вместо None, и ветка
            # "ERROR: Invalid session" ниже была бы мертва: исключение улетало бы
            # в except-блок и просто рвало соединение без внятного сообщения,
            # из-за чего фронт трактовал бы протухшую сессию как обрыв связи и
            # уходил в бесконечный реконнект.
            user_id = await self.cache.validate_key(access_key)
            if not user_id:
                await websocket.send_text("ERROR: Invalid session")
                return

            websocket.state.user_id = user_id
            await websocket.send_text("AUTH_OK")

            self.viewers.add(websocket)
            added = True
            logger.info(f"💬 Юзер {user_id} подключился к чату, всего онлайн: {len(self.viewers)}")

            while True:
                try:
                    msg = await asyncio.wait_for(websocket.receive_text(), timeout=60.0)
                    if msg == "ping":
                        await websocket.send_text("pong")
                except asyncio.TimeoutError:
                    try:
                        await websocket.send_text("ping")
                    except Exception:
                        break

        except Exception as e:
            logger.error(f"❌ Ошибка WS-соединения чата: {e}")

        finally:
            if added:
                self.viewers.discard(websocket)
                logger.info(f"💬 Юзер отключился от чата, осталось онлайн: {len(self.viewers)}")
            try:
                await websocket.close()
            except Exception:
                pass

    async def broadcast(self, payload: dict):
        """Рассылка JSON-события всем подключённым к чату."""
        if not self.viewers:
            return
        data = json.dumps(payload, ensure_ascii=False)
        dead = []
        # Копия — self.viewers мутируется конкурентно (handle_ws добавляет/убирает
        # соединения), а await ws.send_text ниже отдаёт управление event loop'у;
        # итерация напрямую по мутирующемуся множеству роняла бы RuntimeError.
        for ws in list(self.viewers):
            try:
                await ws.send_text(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.viewers.discard(ws)

    async def send_message(
        self,
        user_id: int,
        msg_type: str,
        text: Optional[str] = None,
        media_bytes: Optional[bytes] = None,
        content_type: Optional[str] = None,
        media_kind: Optional[str] = None,
    ) -> dict:
        text = (text or "").strip()
        # Браузер иногда шлёт content-type с параметрами (audio/webm;codecs=opus) —
        # сверяем и сохраняем по чистому base type, коды кодеков не проверяем.
        if content_type:
            content_type = content_type.split(";")[0].strip()
        if msg_type == "text" and not text:
            raise ValueError("Пустое текстовое сообщение")
        if msg_type != "text" and not media_bytes:
            raise ValueError("Нет медиафайла")
        if media_bytes and len(media_bytes) > CHAT_MEDIA_MAX_BYTES:
            raise ValueError("Файл слишком большой")
        if media_bytes and content_type not in ALLOWED_MEDIA_TYPES:
            raise ValueError(f"Недопустимый тип файла: {content_type}")

        # Аплоад — до INCR seq: если save_chat_media упадёт, seq не тратится
        # впустую (ключ файла не зависит от seq, поэтому порядок можно
        # поменять местами без побочных эффектов).
        media_key = ""
        if media_bytes:
            ext = _EXT_BY_CONTENT_TYPE.get(content_type, "bin")
            media_key = f"chat/{uuid.uuid4().hex}.{ext}"
            ok = await self.s3.save_chat_media(media_key, media_bytes, content_type)
            if not ok:
                raise RuntimeError("Не удалось сохранить медиафайл")

        seq = await self.cache.chat_next_seq()
        return await self._finalize_message(seq, user_id, msg_type, text, media_key, media_kind)

    async def share_video(self, user_id: int, video_key: str, thumbnail_key: str = "") -> dict:
        """Переслать уже существующее видео (из архива камеры) в чат — без
        повторной загрузки байт, просто ссылка на тот же объект в S3. Не
        копируем файл: если камера почистит его по своему retention раньше,
        чем чат — сообщение останется, но отдача медиа вернёт 404 (фронт
        показывает 'видео недоступно' вместо копирования на каждый шаринг)."""
        seq = await self.cache.chat_next_seq()
        return await self._finalize_message(
            seq, user_id, "video", "", video_key, None, shared=True, thumbnail_key=thumbnail_key,
        )

    async def _finalize_message(
        self, seq: int, user_id: int, msg_type: str, text: str, media_key: str,
        media_kind: Optional[str], shared: bool = False, thumbnail_key: str = "",
    ) -> dict:
        user = await self.cache.get_user(user_id)
        message = {
            "seq": seq,
            "user_id": user_id,
            "username": user["display_name"] if user else str(user_id),
            "type": msg_type,
            "text": text,
            "media_key": media_key,
            "media_kind": media_kind or "",
            "thumbnail_key": thumbnail_key,
            # shared — сообщение ссылается на чужой объект в S3 (архив камеры), а не
            # на свою загрузку. Нужно, чтобы trim_old_messages не удалял по истечении
            # чатового retention файл, которым всё ещё владеет и распоряжается камера.
            "shared": "1" if shared else "",
            "ts": _get_izhevsk_time().isoformat(),
        }

        await self.cache.save_chat_message(seq, message)
        await self.broadcast({"type": "message", "data": message})
        await self._push_to_offline_users(message)

        return message

    async def _push_to_offline_users(self, message: dict):
        """Web Push только тем, у кого сейчас не открыт /chat/ws — если WS открыт,
        уведомление (тихое обновление или in-app тост) уже доставлено через него."""
        connected = self.connected_user_ids()
        users = await self.cache.list_users()
        payload = {
            "title": message["username"],
            "body": message["text"] or _PUSH_BODY_BY_TYPE.get(message["type"], "Новое сообщение"),
            "url": "/chat",
        }
        for user in users:
            uid = user["user_id"]
            if uid == message["user_id"] or uid in connected:
                continue
            subscription = await self.cache.get_push_subscription(uid)
            if not subscription:
                continue
            try:
                await send_push(subscription, payload)
            except PushSubscriptionExpired:
                await self.cache.delete_push_subscription(uid)
                logger.info(f"🔕 Push-подписка юзера {uid} протухла, удалена")
            except Exception as e:
                # Push — best-effort уведомление, а не часть доставки сообщения:
                # ошибка здесь (например, VAPID не настроен) не должна ронять send_message.
                logger.warning(f"⚠️ Не удалось отправить push юзеру {uid}: {e}")

    async def send_test_push(self) -> bool:
        """Тестовый пуш админу напрямую, в обход сообщений/подписчиков —
        специально хардкожено на role=='admin', а не на произвольный user_id,
        чтобы даже без авторизации на эндпоинте (сделано намеренно, для
        прогона через Swagger) им нельзя было дёрнуть пуш кому-то ещё."""
        users = await self.cache.list_users()
        admin = next((u for u in users if u["role"] == "admin"), None)
        if not admin:
            raise ValueError("Админ не найден")

        subscription = await self.cache.get_push_subscription(admin["user_id"])
        if not subscription:
            raise ValueError("Админ ещё не подписан на push (нажми колокольчик в чате)")

        payload = {"title": "Тестовый пуш", "body": "Если видишь это — доставка работает", "url": "/chat"}
        try:
            return await send_push(subscription, payload)
        except PushSubscriptionExpired:
            await self.cache.delete_push_subscription(admin["user_id"])
            raise ValueError("Подписка протухла и удалена, подпишись заново")

    async def pin_message(self, seq: int) -> dict:
        """Закрепить сообщение — один слот на весь чат, новое закрепление
        тихо заменяет старое (как в личках Telegram, не стек)."""
        message = await self.cache.get_chat_message(seq)
        if not message:
            raise ValueError("Сообщение не найдено")
        await self.cache.set_chat_pinned(seq)
        await self.broadcast({"type": "pinned", "data": message})
        return message

    async def unpin_message(self) -> None:
        await self.cache.clear_chat_pinned()
        await self.broadcast({"type": "unpinned", "data": {}})

    async def get_pinned_message(self) -> Optional[dict]:
        seq = await self.cache.get_chat_pinned_seq()
        if seq is None:
            return None
        return await self.cache.get_chat_message(seq)

    async def get_push_status(self) -> list:
        """Кто из юзеров сейчас подписан на Web Push — для UI 'кто получит
        уведомление, если закроет приложение'."""
        users = await self.cache.list_users()
        status = []
        for user in users:
            subscription = await self.cache.get_push_subscription(user["user_id"])
            status.append({
                "user_id": user["user_id"],
                "display_name": user["display_name"],
                "subscribed": subscription is not None,
            })
        return status

    async def mark_read(self, user_id: int) -> dict:
        seq = await self.cache.chat_current_seq()
        await self.cache.set_chat_read(user_id, seq)
        payload = {"user_id": user_id, "seq": seq, "at": _get_izhevsk_time().isoformat()}
        await self.broadcast({"type": "read", "data": payload})
        return payload

    async def get_messages(self, before_seq: Optional[int] = None, limit: int = 50) -> list:
        return await self.cache.get_chat_messages(before_seq=before_seq, limit=limit)

    async def get_read_states(self) -> list:
        return await self.cache.get_all_chat_reads()

    async def get_unread_count(self, user_id: int) -> int:
        return await self.cache.get_chat_unread_count(user_id)

    async def trim_old_messages(self, days: int = 30):
        """Удаляет сообщения (и их медиа в S3) старше `days`."""
        expired = await self.cache.get_expired_chat_messages(older_than_days=days)
        if not expired:
            return
        for msg in expired:
            media_key = msg.get("media_key")
            # shared-сообщения ссылаются на объект, которым владеет архив камеры —
            # его удаление им не принадлежит, об этом заботится retention камеры.
            if media_key and not msg.get("shared"):
                try:
                    await self.s3.delete_video(media_key)
                except Exception as e:
                    logger.warning(f"⚠️ Не удалось удалить медиа чата {media_key}: {e}")
        expired_seqs = [m["seq"] for m in expired]
        removed = await self.cache.delete_chat_messages(expired_seqs)

        pinned_seq = await self.cache.get_chat_pinned_seq()
        if pinned_seq is not None and pinned_seq in expired_seqs:
            await self.unpin_message()

        logger.info(f"🧹 Чат: удалено {removed} сообщений старше {days} дней")
