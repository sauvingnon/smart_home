# app/services/chat_service/chat_service.py
import asyncio
import json
import os
import tempfile
import uuid
from datetime import datetime, timedelta
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
CHAT_MEDIA_MAX_BYTES = 50 * 1024 * 1024  # 50 МБ

# Окно, в течение которого автор может удалить своё сообщение. Проверяется на
# сервере, а не только в UI: клиент может соврать, а удаление необратимо.
CHAT_DELETE_WINDOW = timedelta(hours=1)

# Окно на правку своего сообщения. Держим равным окну удаления — по просьбе
# пользователя: одно правило на все действия над своим сообщением проще, чем
# два разных срока. Константа отдельная, а не алиас: правила разные по смыслу
# и когда-нибудь снова могут разойтись.
CHAT_EDIT_WINDOW = timedelta(hours=1)

# Длина сохраняемой цитаты. Цитату денормализуем в само сообщение-ответ, а не
# резолвим по reply_to на клиенте: исходник может быть за пределами
# подгруженной страницы истории, вычищен по retention или удалён автором —
# ответ на него всё равно должен показывать, на что отвечали.
REPLY_PREVIEW_MAX_CHARS = 120

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
        """Реалтайм-канал чата. Client→server: 'ping' (health-check) и 'typing'
        (индикатор набора, ретранслируется остальным). Server→client: message/
        read/pinned/unpinned/presence/presence_snapshot/typing/ping. Отправка
        сообщений и read-отметки по-прежнему идут через REST."""
        await websocket.accept()
        added = False
        user_id: Optional[int] = None

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

            # Юзер может держать несколько сокетов разом (второй таб, телефон +
            # десктоп, реконнект поверх ещё не закрывшегося старого) — presence
            # шлём только на настоящий переход офлайн→онлайн, а не на каждый
            # новый сокет того же юзера.
            was_online = user_id in self.connected_user_ids()
            self.viewers.add(websocket)
            added = True
            logger.info(f"💬 Юзер {user_id} подключился к чату, всего онлайн: {len(self.viewers)}")

            snapshot = await self.get_presence_snapshot()
            await websocket.send_text(json.dumps({"type": "presence_snapshot", "data": snapshot}, ensure_ascii=False))
            if not was_online:
                await self._broadcast_presence(user_id, online=True)

            while True:
                try:
                    msg = await asyncio.wait_for(websocket.receive_text(), timeout=25.0)
                    if msg == "ping":
                        await websocket.send_text("pong")
                    elif msg == "typing":
                        await self._broadcast_typing(user_id, websocket)
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
                # Тот же юзер может остаться онлайн через другой сокет — офлайн
                # транслируем только когда реально не осталось ни одного его соединения.
                if user_id not in self.connected_user_ids():
                    last_seen = _get_izhevsk_time().isoformat()
                    await self.cache.set_chat_last_seen(user_id, last_seen)
                    await self._broadcast_presence(user_id, online=False, last_seen=last_seen)
            try:
                await websocket.close()
            except Exception:
                pass

    async def broadcast(self, payload: dict, exclude: Optional[WebSocket] = None):
        """Рассылка JSON-события всем подключённым к чату (кроме exclude, если задан)."""
        if not self.viewers:
            return
        data = json.dumps(payload, ensure_ascii=False)
        dead = []
        # Копия — self.viewers мутируется конкурентно (handle_ws добавляет/убирает
        # соединения), а await ws.send_text ниже отдаёт управление event loop'у;
        # итерация напрямую по мутирующемуся множеству роняла бы RuntimeError.
        for ws in list(self.viewers):
            if ws is exclude:
                continue
            try:
                await ws.send_text(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.viewers.discard(ws)

    async def get_presence_snapshot(self) -> list:
        """Онлайн/офлайн + last_seen по каждому юзеру — уходит новому сокету сразу
        после подключения, до того как первое presence-событие могло бы что-то
        поменять, и отдельно по REST для начальной отрисовки шапки чата."""
        users = await self.cache.list_users()
        online_ids = self.connected_user_ids()
        snapshot = []
        for u in users:
            uid = u["user_id"]
            online = uid in online_ids
            last_seen = None if online else await self.cache.get_chat_last_seen(uid)
            snapshot.append({
                "user_id": uid,
                "display_name": u["display_name"],
                "online": online,
                "last_seen": last_seen,
            })
        return snapshot

    async def _broadcast_presence(self, user_id: int, online: bool, last_seen: Optional[str] = None):
        user = await self.cache.get_user(user_id)
        await self.broadcast({
            "type": "presence",
            "data": {
                "user_id": user_id,
                "display_name": user["display_name"] if user else str(user_id),
                "online": online,
                "last_seen": last_seen,
            },
        })

    async def _broadcast_typing(self, user_id: int, sender_ws: WebSocket):
        user = await self.cache.get_user(user_id)
        await self.broadcast(
            {"type": "typing", "data": {"user_id": user_id, "display_name": user["display_name"] if user else str(user_id)}},
            exclude=sender_ws,
        )

    async def send_message(
        self,
        user_id: int,
        msg_type: str,
        text: Optional[str] = None,
        media_bytes: Optional[bytes] = None,
        content_type: Optional[str] = None,
        media_kind: Optional[str] = None,
        reply_to: Optional[int] = None,
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
        thumbnail_key = ""
        if media_bytes:
            ext = _EXT_BY_CONTENT_TYPE.get(content_type, "bin")
            media_key = f"chat/{uuid.uuid4().hex}.{ext}"
            ok = await self.s3.save_chat_media(media_key, media_bytes, content_type)
            if not ok:
                raise RuntimeError("Не удалось сохранить медиафайл")
            if msg_type == "video":
                thumbnail_key = await self._generate_video_thumbnail(media_bytes, ext)

        seq = await self.cache.chat_next_seq()
        return await self._finalize_message(
            seq, user_id, msg_type, text, media_key, media_kind,
            thumbnail_key=thumbnail_key, reply_to=reply_to,
        )

    async def _generate_video_thumbnail(self, video_bytes: bytes, ext: str) -> str:
        """Первый кадр видео, загруженного юзером с телефона — тот же ffmpeg-подход,
        что и для записей с камер (video_service.py), но без -ss: кадр нужен
        с самого начала ролика, а не из середины. Ошибка тут не должна ронять
        отправку сообщения — просто останется без превью."""
        temp_video_path = tempfile.NamedTemporaryFile(delete=False, suffix=f".{ext}").name
        temp_thumb_path = tempfile.NamedTemporaryFile(delete=False, suffix=".jpg").name
        try:
            with open(temp_video_path, "wb") as f:
                f.write(video_bytes)

            cmd = [
                "ffmpeg",
                "-i", temp_video_path,
                "-vframes", "1",
                "-q:v", "2",
                "-y",
                temp_thumb_path,
            ]
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _, stderr = await process.communicate()
            if process.returncode != 0:
                logger.warning(f"⚠️ Не удалось сгенерировать превью видео чата: {stderr.decode()}")
                return ""
            if not os.path.exists(temp_thumb_path) or os.path.getsize(temp_thumb_path) == 0:
                return ""

            with open(temp_thumb_path, "rb") as thumb_file:
                thumb_data = thumb_file.read()

            thumb_key = f"chat/{uuid.uuid4().hex}_thumb.jpg"
            ok = await self.s3.save_chat_media(thumb_key, thumb_data, "image/jpeg")
            return thumb_key if ok else ""
        except Exception as e:
            logger.warning(f"⚠️ Ошибка создания превью видео чата: {e}")
            return ""
        finally:
            for path in (temp_video_path, temp_thumb_path):
                if path and os.path.exists(path):
                    try:
                        os.unlink(path)
                    except Exception:
                        pass

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

    async def _reply_snapshot(self, reply_to: Optional[int]) -> dict:
        """Автор и короткий текст цитируемого сообщения — снимком на момент
        ответа. Ссылка на несуществующий seq молча теряется: ответ на удалённое
        сообщение — не повод отклонять новое."""
        if not reply_to:
            return {"reply_to": None, "reply_to_username": "", "reply_to_preview": ""}
        original = await self.cache.get_chat_message(reply_to)
        if not original:
            return {"reply_to": None, "reply_to_username": "", "reply_to_preview": ""}
        preview = original.get("text") or _PUSH_BODY_BY_TYPE.get(original.get("type", ""), "Сообщение")
        if len(preview) > REPLY_PREVIEW_MAX_CHARS:
            preview = preview[:REPLY_PREVIEW_MAX_CHARS - 1].rstrip() + "…"
        return {
            "reply_to": original["seq"],
            "reply_to_username": original.get("username", ""),
            "reply_to_preview": preview,
        }

    async def _finalize_message(
        self, seq: int, user_id: int, msg_type: str, text: str, media_key: str,
        media_kind: Optional[str], shared: bool = False, thumbnail_key: str = "",
        reply_to: Optional[int] = None,
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
            **await self._reply_snapshot(reply_to),
            # Проставляется только правкой — у нового сообщения его нет.
            "edited_at": None,
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

    async def pin_message(self, user_id: int, seq: int) -> dict:
        """Закрепить сообщение — один слот на весь чат, новое закрепление
        тихо заменяет старое (как в личках Telegram, не стек). Кто и что
        закрепил — отдельным системным сообщением в самой ленте (см.
        _create_system_message), а не только баннером, который просто
        перезапишется следующим пином."""
        message = await self.cache.get_chat_message(seq)
        if not message:
            raise ValueError("Сообщение не найдено")
        await self.cache.set_chat_pinned(seq)
        await self.broadcast({"type": "pinned", "data": message})
        await self._create_system_message(user_id, "pinned", seq)
        return message

    async def unpin_message(self, user_id: Optional[int] = None) -> None:
        # Снимок закреплённого seq — до очистки, иначе будет нечего показать
        # в системном сообщении "открепил(а)". user_id нет у автоматических
        # вызовов (удаление закреплённого сообщения его автором, чистка по
        # retention) — там открепление не чей-то жест, а системный побочный
        # эффект, системное сообщение в этом случае пропускаем.
        pinned_seq = await self.cache.get_chat_pinned_seq()
        await self.cache.clear_chat_pinned()
        await self.broadcast({"type": "unpinned", "data": {}})
        if pinned_seq is not None and user_id is not None:
            await self._create_system_message(user_id, "unpinned", pinned_seq)

    async def _create_system_message(self, user_id: int, system_kind: str, reply_to: Optional[int]) -> dict:
        """Служебное сообщение прямо в ленте (закрепление/открепление) — как в
        Telegram: не тост, а обычная запись с собственным seq, переживающая
        перезагрузку и историю. user_id/username — кто совершил действие,
        reply_to/reply_to_preview (снимок через тот же _reply_snapshot, что и
        у ответов) — какое сообщение затронуто. Без web push: это служебное
        событие, а не повод будить чужой телефон."""
        user = await self.cache.get_user(user_id)
        seq = await self.cache.chat_next_seq()
        message = {
            "seq": seq,
            "user_id": user_id,
            "username": user["display_name"] if user else str(user_id),
            "type": "system",
            "system_kind": system_kind,
            "text": "",
            "media_key": "",
            "media_kind": "",
            "thumbnail_key": "",
            **await self._reply_snapshot(reply_to),
            "edited_at": None,
            "shared": "",
            "ts": _get_izhevsk_time().isoformat(),
        }
        await self.cache.save_chat_message(seq, message)
        await self.broadcast({"type": "message", "data": message})
        return message

    async def edit_message(self, user_id: int, seq: int, text: str) -> dict:
        """Правит текст своего сообщения. Как и у удаления, все условия
        проверяются здесь, а не только в UI — клиент волен прислать любой seq.

        Медиа не редактируем: подписей у них в этом чате нет, а править сам
        файл — это уже новое сообщение, а не правка.
        """
        text = (text or "").strip()
        if not text:
            raise ValueError("Пустой текст — чтобы убрать сообщение, его надо удалить")

        message = await self.cache.get_chat_message(seq)
        if not message:
            raise ValueError("Сообщение не найдено")
        if message["user_id"] != user_id:
            raise PermissionError("Можно править только свои сообщения")
        if message.get("type") != "text":
            raise PermissionError("Править можно только текстовые сообщения")
        try:
            ts = datetime.fromisoformat(message["ts"])
        except (KeyError, ValueError):
            raise PermissionError("У сообщения некорректное время — правка запрещена")
        if _get_izhevsk_time() - ts > CHAT_EDIT_WINDOW:
            raise PermissionError("Сообщение старше часа — править уже нельзя")

        updated = await self.cache.update_chat_message(
            seq, {"text": text, "edited_at": _get_izhevsk_time().isoformat()},
        )
        if not updated:
            raise ValueError("Сообщение не найдено")

        await self.broadcast({"type": "edited", "data": updated})
        # Закреплённое сообщение живёт у клиентов отдельной копией в баннере —
        # без этого там осталась бы старая редакция до перезагрузки страницы.
        if await self.cache.get_chat_pinned_seq() == seq:
            await self.broadcast({"type": "pinned", "data": updated})
        return updated

    async def delete_message(self, user_id: int, seq: int) -> None:
        """Удаляет своё сообщение, если ему меньше часа (как в Telegram).

        Оба условия проверяются здесь, а не только в UI: клиент волен прислать
        любой seq, а удаление необратимо — и сообщения, и медиа в S3.
        """
        message = await self.cache.get_chat_message(seq)
        if not message:
            raise ValueError("Сообщение не найдено")
        if message["user_id"] != user_id:
            raise PermissionError("Можно удалять только свои сообщения")
        try:
            ts = datetime.fromisoformat(message["ts"])
        except (KeyError, ValueError):
            raise PermissionError("У сообщения некорректное время — удаление запрещено")
        if _get_izhevsk_time() - ts > CHAT_DELETE_WINDOW:
            raise PermissionError("Сообщение старше часа — удалить уже нельзя")

        # Порядок тот же, что в trim_old_messages: сначала медиа в S3, потом
        # запись в Redis, потом снять закрепление, если удалили закреплённое.
        media_key = message.get("media_key")
        # shared-сообщения ссылаются на объект архива камеры — он не наш, его
        # удалением распоряжается retention камеры (см. trim_old_messages).
        if media_key and not message.get("shared"):
            try:
                await self.s3.delete_video(media_key)
            except Exception as e:
                logger.warning(f"⚠️ Не удалось удалить медиа чата {media_key}: {e}")

        await self.cache.delete_chat_messages([seq])

        if await self.cache.get_chat_pinned_seq() == seq:
            await self.unpin_message()

        await self.broadcast({"type": "deleted", "data": {"seq": seq}})
        logger.info(f"🗑 Чат: юзер {user_id} удалил своё сообщение {seq}")

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
        # Рассылаем сохранённый read_at, а не текущее время: чат дёргает /read при
        # каждом открытии и каждом новом сообщении, и "прочитано в HH:MM" у уже
        # прочитанных сообщений иначе переписывалось бы на now при каждом вызове.
        read_at = await self.cache.set_chat_read(user_id, seq)
        payload = {"user_id": user_id, "seq": seq, "at": read_at or _get_izhevsk_time().isoformat()}
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
