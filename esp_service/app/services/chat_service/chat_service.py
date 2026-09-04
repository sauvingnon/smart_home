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

# Превью фото для ленты кодирует клиент (тем же canvas, что и сам кадр —
# сервер медиа не транскодирует). Потолок нужен только чтобы под видом превью
# не заливали второй полноразмерный файл: 400px JPEG весит десятки килобайт.
CHAT_THUMB_MAX_BYTES = 512 * 1024

# Крошка-заглушка лежит в самом сообщении и уезжает по WS в каждую ленту и в
# каждую страницу истории, поэтому она именно крошка: 16px JPEG в data-URI —
# это меньше килобайта base64. Потолок — защита от клиента, решившего положить
# в это поле целую картинку.
CHAT_PREVIEW_MAX_CHARS = 2048

# Разумный предел на присланные клиентом размеры кадра: числа идут в вёрстку
# ленты, и мусор в них не должен её ломать.
MEDIA_DIMENSION_MAX = 20000

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

# Базовый набор реакций — тот же на клиенте (REACTION_EMOJI в api/client.ts).
# Список закрытый: без него в Redis приехала бы любая строка, которую клиент
# решит прислать. Порядок здесь — только порядок кнопок в пикере; порядок
# чипсов под сообщением задаётся не им, а тем, кто отреагировал раньше (см.
# _aggregate_reactions).
ALLOWED_REACTIONS = ("👍", "❤️", "🔥", "😁", "😢", "👎")

# Как часто один человек может разбудить телефон другого реакциями. Не «раз в
# минуту на сообщение», а раз в минуту на пару людей — обоснование срока и
# выбранной гранулярности см. в cache.take_reaction_push_slot.
REACTION_PUSH_COOLDOWN_SECONDS = 60

# Цитата в теле пуша заметно короче, чем в цитате ответа (REPLY_PREVIEW_MAX_CHARS):
# там строка живёт в пузыре во всю ширину экрана, а тут — в системной плашке,
# где после имени и эмодзи остаётся строка-полторы, и остальное всё равно
# обрежет сама ОС, только уже без многоточия.
REACTION_PUSH_PREVIEW_MAX_CHARS = 60


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
        thumb_bytes: Optional[bytes] = None,
        thumb_content_type: Optional[str] = None,
        media_w: int = 0,
        media_h: int = 0,
        media_preview: str = "",
    ) -> dict:
        text = (text or "").strip()
        # Браузер иногда шлёт content-type с параметрами (audio/webm;codecs=opus) —
        # сверяем и сохраняем по чистому base type, коды кодеков не проверяем.
        if content_type:
            content_type = content_type.split(";")[0].strip()
        if thumb_content_type:
            thumb_content_type = thumb_content_type.split(";")[0].strip()
        if msg_type == "text" and not text:
            raise ValueError("Пустое текстовое сообщение")
        if msg_type != "text" and not media_bytes:
            raise ValueError("Нет медиафайла")
        if media_bytes and len(media_bytes) > CHAT_MEDIA_MAX_BYTES:
            raise ValueError("Файл слишком большой")
        if media_bytes and content_type not in ALLOWED_MEDIA_TYPES:
            raise ValueError(f"Недопустимый тип файла: {content_type}")

        # Пропорции и крошку-превью считает клиент — он и так держит картинку
        # декодированной, а сервер её не открывает. Но раз числа и строка
        # пришли снаружи, чиним их в разумные рамки: кривые размеры поехали бы
        # прямо в вёрстку ленты, а раздутая строка осела бы в Redis и в каждой
        # выдаче истории. Не отвергаем сообщение целиком — просто отбрасываем
        # негодные поля, фронт для них и так держит запасной вариант.
        if msg_type != "image":
            media_w = media_h = 0
            media_preview = ""
        if not (0 < media_w <= MEDIA_DIMENSION_MAX and 0 < media_h <= MEDIA_DIMENSION_MAX):
            media_w = media_h = 0
        if not media_preview.startswith("data:image/") or len(media_preview) > CHAT_PREVIEW_MAX_CHARS:
            media_preview = ""

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
            elif msg_type == "image" and thumb_bytes:
                thumbnail_key = await self._save_image_thumbnail(thumb_bytes, thumb_content_type)

        seq = await self.cache.chat_next_seq()
        return await self._finalize_message(
            seq, user_id, msg_type, text, media_key, media_kind,
            thumbnail_key=thumbnail_key, reply_to=reply_to,
            media_w=media_w, media_h=media_h, media_preview=media_preview,
        )

    async def _save_image_thumbnail(self, thumb_bytes: bytes, content_type: Optional[str]) -> str:
        """Уменьшенная копия фото для ленты. В отличие от видео (там первый кадр
        достаёт ffmpeg), её кодирует клиент — он уже держит картинку в canvas,
        а сервер медиа не транскодирует. Не сохранилась — не беда: сообщение
        останется без превью, и в ленту, как раньше, поедет сам оригинал."""
        if content_type not in _EXT_BY_CONTENT_TYPE or not content_type.startswith("image/"):
            logger.warning(f"⚠️ Превью фото с недопустимым типом {content_type} — пропускаем")
            return ""
        if len(thumb_bytes) > CHAT_THUMB_MAX_BYTES:
            logger.warning(f"⚠️ Превью фото слишком большое ({len(thumb_bytes)} Б) — пропускаем")
            return ""
        thumb_key = f"chat/{uuid.uuid4().hex}_thumb.{_EXT_BY_CONTENT_TYPE[content_type]}"
        ok = await self.s3.save_chat_media(thumb_key, thumb_bytes, content_type)
        return thumb_key if ok else ""

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

    async def share_video(self, user_id: int, video_key: str, thumbnail_key: str = "", text: str = "") -> dict:
        """Переслать уже существующее видео (из архива камеры) в чат — без
        повторной загрузки байт, просто ссылка на тот же объект в S3. Не
        копируем файл: если камера почистит его по своему retention раньше,
        чем чат — сообщение останется, но отдача медиа вернёт 404 (фронт
        показывает 'видео недоступно' вместо копирования на каждый шаринг).
        text — подпись с именами распознанных на видео людей (пусто, если
        распознавание ещё не готово или никого не нашли)."""
        seq = await self.cache.chat_next_seq()
        return await self._finalize_message(
            seq, user_id, "video", text, video_key, None, shared=True, thumbnail_key=thumbnail_key,
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
        return {
            "reply_to": original["seq"],
            "reply_to_username": original.get("username", ""),
            "reply_to_preview": self._message_preview(original, REPLY_PREVIEW_MAX_CHARS),
        }

    @staticmethod
    def _message_preview(message: dict, max_chars: int) -> str:
        """Короткое «о чём это сообщение» — для цитаты в ответе и для тела пуша
        о реакции. У медиа своего текста нет, поэтому вместо него идёт подпись
        по типу («📷 Фото»): пустая цитата не сказала бы вообще ни о чём."""
        preview = message.get("text") or _PUSH_BODY_BY_TYPE.get(message.get("type", ""), "Сообщение")
        if len(preview) > max_chars:
            preview = preview[:max_chars - 1].rstrip() + "…"
        return preview

    async def _finalize_message(
        self, seq: int, user_id: int, msg_type: str, text: str, media_key: str,
        media_kind: Optional[str], shared: bool = False, thumbnail_key: str = "",
        reply_to: Optional[int] = None,
        media_w: int = 0, media_h: int = 0, media_preview: str = "",
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
            "media_w": media_w,
            "media_h": media_h,
            "media_preview": media_preview,
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
        # Строго после сохранения: хэш сообщения хранит только строки (см.
        # _encode_chat_message), и список, попавший в него до save, лёг бы в
        # Redis литералом "[]". У нового сообщения реакций и так нет — поле
        # нужно лишь затем, чтобы форма сообщения была одинаковой везде.
        message["reactions"] = []
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
            # С seq, а не просто "/chat": тап по пуш-уведомлению открывает чат
            # ровно на том сообщении, о котором оно было (см. deep-link в
            # ChatPage). Без параметра юзер приезжал в конец ленты и искал
            # глазами, что именно ему прилетело.
            "url": f"/chat?seq={message['seq']}",
        }
        for user in users:
            uid = user["user_id"]
            if uid == message["user_id"] or uid in connected:
                continue
            # Тема "сообщения чата" выключается отдельно от самой подписки:
            # подписка на устройство одна на все уведомления, и снимать её
            # целиком ради тишины в чате значило бы заодно убить приходы людей
            # и алерт о плате. Дефолт True — у подписавшихся до появления поля
            # его в Redis нет (см. NotifyPrefs).
            prefs = await self.cache.get_video_notify_prefs(uid)
            if not (prefs or {}).get("chat_messages", True):
                continue
            subscription = await self.cache.get_push_subscription(uid)
            if not subscription:
                continue
            await self._deliver_push(uid, subscription, payload)

    async def _deliver_push(self, user_id: int, subscription: dict, payload: dict) -> None:
        """Отправка одного пуша со штатной уборкой за собой. Push — best-effort
        уведомление, а не часть доставки сообщения: ошибка здесь (скажем, VAPID
        не настроен) не должна ронять ни send_message, ни toggle_reaction —
        сообщение и реакция к этому моменту уже сохранены и разосланы по WS.

        Подписку принимаем готовой, а не читаем сами: вызывающий и так держит её
        в руках, а у реакций порядок проверок важен — кулдаун берётся последним,
        уже после того как выяснилось, что слать вообще есть куда."""
        try:
            await send_push(subscription, payload)
        except PushSubscriptionExpired:
            await self.cache.delete_push_subscription(user_id)
            logger.info(f"🔕 Push-подписка юзера {user_id} протухла, удалена")
        except Exception as e:
            logger.warning(f"⚠️ Не удалось отправить push юзеру {user_id}: {e}")

    async def _push_reaction(self, message: dict, actor_id: int, emoji: str) -> None:
        """Пуш автору сообщения о том, что на него отреагировали.

        Условий много, и каждое отсекает свой случай, поэтому порядок не
        произвольный: сначала бесплатные проверки в памяти, потом Redis, и
        только в самом конце — кулдаун. Взять слот раньше значило бы сжечь его
        на юзера, которому мы всё равно ничего не отправили, и следующая, уже
        доставимая, реакция от того же человека молча утонула бы в кулдауне.
        """
        author_id = message["user_id"]
        # Реакция на собственное сообщение — сам себе новость.
        if author_id == actor_id:
            return
        # Автор сидит в чате — он уже увидел реакцию вживую, событием reaction
        # по WS. Тот же принцип, что и у сообщений (_push_to_offline_users).
        if author_id in self.connected_user_ids():
            return

        prefs = await self.cache.get_video_notify_prefs(author_id) or {}
        if not prefs.get("chat_messages", True) or not prefs.get("chat_reactions", True):
            return

        subscription = await self.cache.get_push_subscription(author_id)
        if not subscription:
            return

        if not await self.cache.take_reaction_push_slot(
            author_id, actor_id, REACTION_PUSH_COOLDOWN_SECONDS,
        ):
            return

        actor = await self.cache.get_user(actor_id)
        preview = self._message_preview(message, REACTION_PUSH_PREVIEW_MAX_CHARS)
        # Свой текст берём в кавычки, подпись типа («📷 Фото») — нет: кавычки
        # вокруг неё выглядели бы цитатой того, чего никто не писал.
        body = f"{emoji} на «{preview}»" if (message.get("text") or "").strip() else f"{emoji} на {preview.lower()}"
        await self._deliver_push(author_id, subscription, {
            "title": actor["display_name"] if actor else str(actor_id),
            "body": body,
            "url": f"/chat?seq={message['seq']}",
            # Тег на пару «сообщение + реагирующий»: передумавший и сменивший
            # эмодзи заменяет собой своё же уведомление, а реакция второго
            # человека приходит отдельной строкой, а не затирает первого.
            "tag": f"chat-reaction-{message['seq']}-{actor_id}",
        })

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
        message = await self._with_reactions(await self.cache.get_chat_message(seq))
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
        message["reactions"] = []
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
        # Клиент по событию edited подменяет объект сообщения целиком — без
        # реакций в этом ответе правка стирала бы их у всех, кто в чате.
        await self._with_reactions(updated)

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
        await self._delete_message_media(message)

        await self.cache.delete_chat_messages([seq])

        if await self.cache.get_chat_pinned_seq() == seq:
            await self.unpin_message()

        await self.broadcast({"type": "deleted", "data": {"seq": seq}})
        logger.info(f"🗑 Чат: юзер {user_id} удалил своё сообщение {seq}")

    async def _delete_message_media(self, message: dict) -> None:
        """Всё, что сообщение занимает в S3: сам файл и превью к нему. Превью
        раньше оставалось висеть — у видео их были единицы, а теперь своё
        превью есть у каждого фото, и мусор копился бы с каждой картинкой.

        shared-сообщение ссылается на запись архива камеры (и на её превью в
        thumbnails/) — этими объектами распоряжается retention камеры, а не мы.
        """
        if message.get("shared"):
            return
        for key in (message.get("media_key"), message.get("thumbnail_key")):
            if not key:
                continue
            try:
                await self.s3.delete_video(key)
            except Exception as e:
                logger.warning(f"⚠️ Не удалось удалить медиа чата {key}: {e}")

    @staticmethod
    def _aggregate_reactions(raw: dict) -> list:
        """{user_id: emoji} → [{emoji, user_ids}] в порядке появления: кто раньше
        отреагировал, тот и левее — и внутри чипса, и среди самих чипсов.

        Ничего не сортируем намеренно. Любой сорт (по user_id, по палитре) —
        это вставка НОВОГО элемента в СЕРЕДИНУ уже нарисованного ряда: чужая
        аватарка, стоявшая первой, уезжает вправо в тот же кадр, в котором
        всплывает твоя. На экране это ровно тот прыжок, ради которого сорт и
        убран. При добавлении в хвост не двигается вообще ничего.

        Опирается на то, что HGETALL маленького хэша отдаёт поля в порядке
        вставки: до hash-max-listpack-entries (128 по умолчанию) хэш лежит
        listpack'ом, то есть буквально массивом в порядке записи, а тут полей
        не больше, чем людей в чате. Если когда-нибудь перевалит и порядок
        станет произвольным — сломается только косметика (аватарки в чипсе
        встанут иначе), а не смысл.

        Клиенту нужны именно user_ids, а не число: по ним он и подсвечивает
        свою реакцию, и печатает, кто отреагировал, — имена у него уже есть из
        presence, так что отдельного запроса за ними не нужно."""
        by_emoji = {}
        for user_id, emoji in raw.items():
            by_emoji.setdefault(emoji, []).append(user_id)
        # dict в Python держит порядок вставки, поэтому эмодзи идут в том
        # порядке, в каком их впервые поставили.
        return [{"emoji": emoji, "user_ids": user_ids} for emoji, user_ids in by_emoji.items()]

    async def _with_reactions(self, message: Optional[dict]) -> Optional[dict]:
        """Подклеивает реакции к одному сообщению. Зовётся на каждом пути, по
        которому сообщение уходит клиенту (история, закреп, правка), потому что
        фронт при событии edited заменяет объект сообщения целиком: не окажись
        там реакций — они пропали бы у всех до перезагрузки чата."""
        if message is None:
            return None
        message["reactions"] = self._aggregate_reactions(
            await self.cache.get_chat_reactions(message["seq"])
        )
        return message

    async def toggle_reaction(self, user_id: int, seq: int, emoji: str) -> list:
        """Ставит/меняет/снимает реакцию (одна на человека на сообщение).
        Рассылаем не дельту, а весь агрегат по этому сообщению: мержить дельты
        на клиенте — лишний источник расхождения, а на четверых участников это
        считанные байты.

        Бейджа непрочитанного тут по-прежнему нет: реакция не создаёт
        сообщения, поэтому в счётчик она сама собой не попадает — и не должна,
        читать в чате после неё нечего.

        А вот пуш автору сообщения — есть, под кулдауном и только на постановку
        реакции (см. _push_reaction). Шлём его после broadcast, а не до: сидящие
        в чате должны увидеть чипс сразу, не дожидаясь похода в чужой push-сервис,
        который в худшем случае отвечает секунду."""
        if emoji not in ALLOWED_REACTIONS:
            raise ValueError("Недопустимая реакция")
        message = await self.cache.get_chat_message(seq)
        if not message:
            raise ValueError("Сообщение не найдено")
        # Системные плашки ("закрепил(а)") — служебная отметка, а не чей-то
        # текст, реагировать там не на что.
        if message.get("type") == "system":
            raise PermissionError("На системные сообщения нельзя реагировать")

        raw = await self.cache.toggle_chat_reaction(seq, user_id, emoji)
        reactions = self._aggregate_reactions(raw)
        await self.broadcast({"type": "reaction", "data": {"seq": seq, "reactions": reactions}})

        # Тоггл — три разных действия под одним вызовом, и пуш заслуживает
        # только одно из них. Отличаем по итоговому состоянию, а не по
        # возвращаемому cache флагу: после снятия своей записи в хэше просто нет,
        # после постановки и смены — есть, и в ней ровно тот эмодзи, который
        # прислали. Снятие не уведомляем принципиально: «я передумал» — не
        # новость, ради которой стоит будить телефон.
        if raw.get(user_id) == emoji:
            await self._push_reaction(message, user_id, emoji)
        return reactions

    async def get_pinned_message(self) -> Optional[dict]:
        seq = await self.cache.get_chat_pinned_seq()
        if seq is None:
            return None
        return await self._with_reactions(await self.cache.get_chat_message(seq))

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
        # display_name прямо в событии, а не только в /read_states. Клиент строит
        # свою таблицу прочтений из двух источников — полного снимка по HTTP и
        # этих событий — и раньше событие, пришедшее раньше снимка (сокет
        # поднимается позже первого запроса истории, а снимок мог и не доехать
        # вовсе), создавало запись с пустым именем. Дальше она копировалась из
        # самой себя при каждом следующем событии, и кружок прочтения так и
        # оставался безымянным "?" до полной пересинхронизации.
        user = await self.cache.get_user(user_id)
        payload = {
            "user_id": user_id,
            "display_name": user["display_name"] if user else str(user_id),
            "seq": seq,
            "at": read_at or _get_izhevsk_time().isoformat(),
        }
        await self.broadcast({"type": "read", "data": payload})
        return payload

    async def get_messages(self, before_seq: Optional[int] = None, limit: int = 50) -> list:
        messages = await self.cache.get_chat_messages(before_seq=before_seq, limit=limit)
        # Реакции ко всей странице одним пайплайном, а не по сообщению: иначе
        # каждая загрузка истории стоила бы ещё полсотни round-trip'ов.
        by_seq = await self.cache.get_chat_reactions_bulk([m["seq"] for m in messages])
        for message in messages:
            message["reactions"] = self._aggregate_reactions(by_seq.get(message["seq"], {}))
        return messages

    async def get_read_states(self) -> list:
        return await self.cache.get_all_chat_reads()

    async def get_read_at(self, seq: int) -> list:
        return await self.cache.get_all_chat_read_at(seq)

    async def get_unread_count(self, user_id: int) -> int:
        return await self.cache.get_chat_unread_count(user_id)

    async def trim_old_messages(self, days: int):
        """Удаляет сообщения (и их медиа в S3) старше `days`. Без дефолта
        нарочно: срок хранения — один MEDIA_RETENTION_DAYS в config.py, общий
        с записями камеры (см. worker._chat_retention_loop), и здесь не
        должно быть второго числа, с которым он может незаметно разойтись."""
        expired = await self.cache.get_expired_chat_messages(older_than_days=days)
        if not expired:
            return
        for msg in expired:
            await self._delete_message_media(msg)
        expired_seqs = [m["seq"] for m in expired]
        removed = await self.cache.delete_chat_messages(expired_seqs)

        pinned_seq = await self.cache.get_chat_pinned_seq()
        if pinned_seq is not None and pinned_seq in expired_seqs:
            await self.unpin_message()

        # История прочтений живёт по тому же сроку, что и лента: чекпоинты
        # левее самого старого уцелевшего сообщения отвечать больше не на что.
        await self.cache.trim_chat_read_history()

        logger.info(f"🧹 Чат: удалено {removed} сообщений старше {days} дней")
