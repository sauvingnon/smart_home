import redis.asyncio as redis
from typing import Optional
from app.schemas.weather_data import WeatherData
from app.utils.time import IZHEVSK_TZ as _IZHEVSK_TZ
from datetime import timedelta, datetime, timezone
import json
from logger import logger
import asyncio
import secrets
import os
from config import MEDIA_RETENTION_DAYS, CAMERA_ID

KEYS_BACKUP_PATH = "/app/data/access_keys.json"

# =================== КЭШ МЕНЕДЖЕР ===================
class CacheManager:
    """Управление кэшированием данных"""
    
    def __init__(self, redis_url: str):
        self.redis_client = None
        self.redis_url = redis_url
        self.key_prefix = "access_key:"
        self.key_ttl = timedelta(days=180)  # 180 дней жизни ключа
        self.user_keys_prefix = "user_keys:"  # user_id -> set ключей, для revoke_all_keys_for_user

        # Токены для просмотра видео
        self.video_token_prefix = "video_token:"   # token -> video_key
        self.video_token_ttl = 3600                # 1 час

        # Для дедупликации видео (хранить ID уже обработанных видео)
        self.video_dedup_prefix = "video_dedup:"
        self.video_dedup_ttl = timedelta(days=MEDIA_RETENTION_DAYS)

        
    async def connect(self, max_retries: int = 5, retry_delay: int = 2):
        for attempt in range(max_retries):
            try:
                logger.info(f"🔌 Подключаемся к Redis (попытка {attempt + 1}/{max_retries})...")
                
                # Создаем асинхронный клиент
                self.redis_client = redis.from_url(
                    self.redis_url, 
                    decode_responses=True,
                    health_check_interval=30,
                    socket_connect_timeout=5,
                    socket_keepalive=True
                )
                
                # Проверяем подключение (С await!)
                response = await self.redis_client.ping()
                logger.info(f"✅ Подключен к Redis, ответ: {response}")
                
                return True
                
            except Exception as e:
                logger.error(f"❌ Ошибка подключения к Redis: {e}")
                self.redis_client = None
                await asyncio.sleep(retry_delay)
                retry_delay *= 2
        
        return False
    
    async def disconnect(self):
        """Корректное отключение от Redis"""
        if self.redis_client:
            try:
                await self.redis_client.close()
                # Некоторые реализации redis-клиента могут не иметь wait_closed
                if hasattr(self.redis_client, "wait_closed"):
                    try:
                        await self.redis_client.wait_closed()
                    except Exception:
                        # Игнорируем ошибки ожидания закрытия
                        pass
                logger.info("✅ Redis соединение закрыто")
            except Exception as e:
                logger.error(f"Ошибка при отключении от Redis: {e}")
            finally:
                self.redis_client = None
    
    async def __aenter__(self):
        """Для использования с async context manager"""
        await self.connect()
        return self
    
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Автоматическое закрытие при выходе из контекста"""
        await self.disconnect()

    async def is_connected(self) -> bool:
        """Проверка что соединение с Redis активно"""
        if not self.redis_client:
            return False
        try:
            return await self.redis_client.ping()
        except:
            return False
        
    async def _ensure_connection(self) -> bool:
        """Проверка и восстановление соединения при необходимости"""
        if not await self.is_connected():
            logger.warning("Соединение с Redis потеряно, переподключаемся...")
            success = await self.connect(max_retries=3, retry_delay=1)
            if not success:
                logger.error("Не удалось восстановить соединение с Redis")
                return False
        
        return self.redis_client is not None
    
    async def get_video_dedup(self, camera_id: str, start_timestamp: int) -> Optional[str]:
        """Проверяет дубликат видео по camera_id + start_timestamp.
        Возвращает video_id если дубликат найден, иначе None."""
        if not await self._ensure_connection():
            return None
        
        try:
            key = f"{self.video_dedup_prefix}{camera_id}:{start_timestamp}"
            video_id = await self.redis_client.get(key)
            
            if video_id:
                logger.warning(f"⚠️ Дубликат видео: camera={camera_id}, start={start_timestamp}, ID={video_id}")
            
            return video_id
            
        except Exception as e:
            logger.error(f"❌ Ошибка проверки дубликата видео: {e}")
            return None

    async def save_video_dedup(self, camera_id: str, start_timestamp: int, video_id: str) -> bool:
        """Сохраняет связку camera_id + start_timestamp -> video_id для защиты от дублей."""
        if not await self._ensure_connection():
            return False
        
        try:
            key = f"{self.video_dedup_prefix}{camera_id}:{start_timestamp}"
            await self.redis_client.setex(key, self.video_dedup_ttl, video_id)
            logger.debug(f"💾 Dedup сохранён: camera={camera_id}, start={start_timestamp}, ID={video_id}")
            return True
            
        except Exception as e:
            logger.error(f"❌ Ошибка сохранения dedup видео: {e}")
            return False
    
    async def get_cached_weather(self) -> Optional[WeatherData]:
        """Получение данных из кэша"""
        if not self.redis_client:
            return None
        
        if not await self._ensure_connection():
            return None
        
        try:
            data = await self.redis_client.get(f"weather:Izhevsk")
            if data:
                # ПРОВЕРЬ, ЧТО ХРАНИШЬ В REDIS
                parsed = json.loads(data)
                # Если уже WeatherData в JSON
                return WeatherData(**parsed)
        except Exception as e:
            logger.error(f"Ошибка чтения из кэша: {e}")
            # traceback removed for cleaner logs
        return None
    
    async def save_weather(self, weather: WeatherData):
        """Сохранение данных в кэш"""
        if not self.redis_client:
            return
        
        if not await self._ensure_connection():
            return
            
        try:
            await self.redis_client.setex(
                f"weather:Izhevsk",
                timedelta(minutes=60),
                weather.model_dump_json()
            )
            
            # Обновляем счетчик вызовов за день (TTL 2 дня — старые ключи не нужны)
            today = datetime.now().strftime("%Y-%m-%d")
            pipe = self.redis_client.pipeline()
            pipe.incr(f"api_calls:{today}")
            pipe.expire(f"api_calls:{today}", 60 * 60 * 24 * 2)
            await pipe.execute()
        except Exception as e:
            logger.exception(f"Ошибка сохранения в кэш: {e}")
    
    async def get_api_calls_today(self) -> int:
        """Получение количества вызовов API за сегодня"""
        if not self.redis_client:
            return 0
        
        if not await self._ensure_connection():
            return 0
            
        today = datetime.now().strftime("%Y-%m-%d")
        calls = await self.redis_client.get(f"api_calls:{today}")
        return int(calls) if calls else 0
    
    async def should_sync_time(self, device_id: str, sync_interval_days: int = 2) -> bool:
        """
        Проверяет, нужно ли синхронизировать время устройства.
        """
        if not self.redis_client:
            logger.warning("Redis не подключен, считаем что синхронизация нужна")
            return True
        
        if not await self._ensure_connection():
            logger.warning("Redis не подключен, считаем что синхронизация нужна")
            return True
        
        try:
            # Получаем время последней синхронизации
            last_sync_str = await self.redis_client.get(f"time_sync:last:{device_id}")
            
            if not last_sync_str:
                logger.info(f"📅 Устройство {device_id} никогда не синхронизировалось")
                return True
            
            last_sync_ts = float(last_sync_str)
            current_ts = datetime.now().timestamp()
            interval_seconds = sync_interval_days * 24 * 3600
            
            # Проверяем, прошло ли достаточно времени
            time_since_sync = current_ts - last_sync_ts
            need_sync = time_since_sync > interval_seconds
            
            if need_sync:
                logger.info(f"🕐 Устройство {device_id} нуждается в синхронизации "
                           f"(последняя: {time_since_sync/86400:.1f} дней назад)")
            else:
                logger.debug(f"Устройство {device_id} синхронизировано недавно "
                           f"({time_since_sync/3600:.1f} часов назад)")
            
            return need_sync
            
        except Exception as e:
            logger.error(f"Ошибка проверки синхронизации для {device_id}: {e}")
            return True
        
    async def mark_sync_completed(self, device_id: str) -> None:
        """
        Отмечает успешную синхронизацию времени устройства.
        """
        if not self.redis_client:
            logger.warning("Redis не подключен, не могу сохранить время синхронизации")
            return
        
        if not await self._ensure_connection():
            logger.warning("Redis не подключен, не могу сохранить время синхронизации")
            return
        
        try:
            current_ts = datetime.now().timestamp()
            
            # Сохраняем время последней синхронизации
            await self.redis_client.set(
                f"time_sync:last:{device_id}",
                str(current_ts)
            )
            
            # Удаляем флаг ожидания подтверждения если есть
            await self.redis_client.delete(f"time_sync:pending:{device_id}")
            
            logger.info(f"✅ Время синхронизации обновлено для {device_id}")
            
        except Exception as e:
            logger.error(f"Ошибка сохранения времени синхронизации для {device_id}: {e}")

    def _load_keys_backup(self) -> dict:
        try:
            if os.path.exists(KEYS_BACKUP_PATH):
                with open(KEYS_BACKUP_PATH, "r") as f:
                    return json.load(f)
        except Exception as e:
            logger.error(f"❌ Ошибка чтения бэкапа ключей: {e}")
        return {}

    def _save_keys_backup(self, data: dict):
        try:
            os.makedirs(os.path.dirname(KEYS_BACKUP_PATH), exist_ok=True)
            with open(KEYS_BACKUP_PATH, "w") as f:
                json.dump(data, f, indent=2)
        except Exception as e:
            logger.error(f"❌ Ошибка записи бэкапа ключей: {e}")

    async def restore_keys_from_backup(self):
        """При старте: восстановить ключи из файла в Redis если их нет."""
        backup = self._load_keys_backup()
        if not backup:
            return
        if not await self._ensure_connection():
            return
        restored = 0
        now_ts = datetime.now(tz=timezone.utc).timestamp()
        for key, entry in backup.items():
            expires_at = entry.get("expires_at", 0)
            if expires_at and expires_at < now_ts:
                continue  # ключ истёк — не восстанавливаем
            user_id = entry.get("user_id")
            if not user_id:
                continue
            remaining = int(expires_at - now_ts) if expires_at else int(self.key_ttl.total_seconds())
            redis_key = f"{self.key_prefix}{key}"
            try:
                await self.redis_client.setex(redis_key, remaining, str(user_id))
                restored += 1
            except Exception as e:
                logger.error(f"❌ Ошибка восстановления ключа {key[:8]}…: {e}")
        logger.info(f"🔑 Восстановлено {restored}/{len(backup)} ключей из бэкапа")

    async def generate_key(self, user_id: int) -> str:
        """Генерирует новый ключ для пользователя."""
        if not self.redis_client:
            return

        if not await self._ensure_connection():
            return

        key = secrets.token_urlsafe(32)
        redis_key = f"{self.key_prefix}{key}"
        expires_at = (datetime.now(tz=timezone.utc) + self.key_ttl).timestamp()

        try:
            await self.redis_client.setex(redis_key, self.key_ttl, str(user_id))
            await self.redis_client.sadd(f"{self.user_keys_prefix}{user_id}", key)

            backup = self._load_keys_backup()
            backup[key] = {"user_id": user_id, "expires_at": expires_at}
            self._save_keys_backup(backup)

            return key
        except Exception as e:
            logger.exception(f"Ошибка сохранения в кэш ключа: {e}")

    async def validate_key(self, key: str) -> Optional[int]:
        """Проверяет ключ, возвращает user_id если валиден"""
        if not self.redis_client:
            return
        
        if not await self._ensure_connection():
            return
        
        redis_key = f"{self.key_prefix}{key}"
        user_id = await self.redis_client.get(redis_key)

        if user_id:
            # Продлеваем жизнь ключа при каждом использовании
            await self.redis_client.expire(redis_key, self.key_ttl)
            return int(user_id)
        
        return None
    
    async def check_login_rate_limit(self, ip: str, max_attempts: int = 10, window_seconds: int = 300) -> bool:
        """Фиксированное окно на попытки логина по IP. Ключ 256-бит случайный —
        перебором его не угадать, это скорее защита от долбёжки эндпоинта,
        чем от реального брутфорса. Возвращает True, если можно пробовать
        дальше, False — лимит исчерпан."""
        if not await self._ensure_connection():
            return True  # Redis лёг — не блокируем логин из-за этого

        redis_key = f"login_attempts:{ip}"
        count = await self.redis_client.incr(redis_key)
        if count == 1:
            await self.redis_client.expire(redis_key, window_seconds)
        return count <= max_attempts

    async def revoke_key(self, key: str) -> bool:
        """Отзывает ключ"""
        redis_key = f"{self.key_prefix}{key}"
        result = bool(await self.redis_client.delete(redis_key))
        backup = self._load_keys_backup()
        if key in backup:
            del backup[key]
            self._save_keys_backup(backup)
        return result
    
    # Ровно та же зона, что и у app.utils.time._get_izhevsk_time, а не своя
    # копия смещения: время сообщения (ts) ставит один источник, время
    # прочтения (read_at) — другой, и лежат они рядом в одном UI. Смещение
    # совпадало и раньше (Самара — UTC+4 без перевода часов), но два
    # независимых определения одного и того же — это то, что расходится молча.
    IZHEVSK_TZ = _IZHEVSK_TZ

    # ───────────────────── ЮЗЕРЫ ─────────────────────
    # Конечный, фиксированный набор людей — новые не добавляются через UI,
    # поэтому сидирование хардкодом при старте безопаснее отдельной админки.
    USER_KEY_PREFIX = "user:"
    USERS_INDEX_KEY = "users:index"

    SEED_USERS: list = [
        {"user_id": 1245, "username": "grisha", "display_name": "Гриша", "role": "admin"},
        {"user_id": 61327489, "username": "kamelia", "display_name": "Камелия", "role": "user"},
        {"user_id": 4382099, "username": "liliya", "display_name": "Лилия", "role": "user"},
        {"user_id": 987654, "username": "andrey", "display_name": "Андрей", "role": "user"},
    ]

    async def get_user(self, user_id: int) -> Optional[dict]:
        """Получить юзера по ID. None если не существует."""
        if not await self._ensure_connection():
            return None
        data = await self.redis_client.hgetall(f"{self.USER_KEY_PREFIX}{user_id}")
        if not data:
            return None
        return {"user_id": user_id, **data}

    async def list_users(self) -> list:
        """Все юзеры, отсортированные по имени."""
        if not await self._ensure_connection():
            return []
        ids = await self.redis_client.smembers(self.USERS_INDEX_KEY)
        users = []
        for uid in ids:
            user = await self.get_user(int(uid))
            if user:
                users.append(user)
        return sorted(users, key=lambda u: u["display_name"])

    async def create_user(self, user_id: int, username: str, display_name: str, role: str = "user") -> bool:
        """Создать (или перезаписать) юзера."""
        if not await self._ensure_connection():
            return False
        key = f"{self.USER_KEY_PREFIX}{user_id}"
        await self.redis_client.hset(key, mapping={
            "username": username,
            "display_name": display_name,
            "role": role,
        })
        await self.redis_client.sadd(self.USERS_INDEX_KEY, user_id)
        return True

    async def delete_user(self, user_id: int) -> bool:
        """Удаляет юзера (hash + запись в индексе). Ключи не трогает — это
        отдельный шаг, см. revoke_all_keys_for_user."""
        if not await self._ensure_connection():
            return False
        await self.redis_client.delete(f"{self.USER_KEY_PREFIX}{user_id}")
        await self.redis_client.srem(self.USERS_INDEX_KEY, user_id)
        return True

    async def revoke_all_keys_for_user(self, user_id: int) -> int:
        """Отзывает все ключи конкретного юзера. Обратный маппинг user_id -> ключи
        живёт в Redis (user_keys:{id}) — это авторитетный источник, а не файловый
        бэкап: если бэкап на диске отстанет или потеряется (запись в него не
        атомарна с записью ключа в Redis), отзыв по одному только бэкапу тихо
        пропустит ключ, и удалённый юзер останется с рабочей сессией-призраком.
        Бэкап всё равно подчищаем заодно — он используется отдельно для
        restore_keys_from_backup при холодном старте."""
        if not await self._ensure_connection():
            return 0
        index_key = f"{self.user_keys_prefix}{user_id}"
        indexed_keys = await self.redis_client.smembers(index_key)

        backup = self._load_keys_backup()
        backup_keys = {k for k, entry in backup.items() if entry.get("user_id") == user_id}

        keys_to_revoke = set(indexed_keys) | backup_keys
        for key in keys_to_revoke:
            await self.redis_client.delete(f"{self.key_prefix}{key}")
            backup.pop(key, None)
        await self.redis_client.delete(index_key)
        if backup_keys:
            self._save_keys_backup(backup)
        return len(keys_to_revoke)

    async def seed_users_if_missing(self) -> None:
        """При старте сервиса досоздаёт недостающих юзеров из SEED_USERS. Идемпотентно —
        существующих не трогает, безопасно вызывать при каждом запуске."""
        if not await self._ensure_connection():
            logger.warning("⚠️ Не удалось засеять юзеров: нет соединения с Redis")
            return
        for seed in self.SEED_USERS:
            if await self.get_user(seed["user_id"]):
                continue
            await self.create_user(seed["user_id"], seed["username"], seed["display_name"], seed["role"])
            logger.info(f"👤 Создан юзер {seed['display_name']} ({seed['user_id']})")

    # ───────────────────── ЧАТ ─────────────────────
    # Один общий чат на всех — без сущности "conversation". Сообщения нумеруются
    # сквозным инкрементным seq (а не Stream ID): тем же числом адресуются
    # позиции прочтения, и сравнивать их надо простым "<=" (см. set_chat_read).
    CHAT_SEQ_KEY = "chat:seq"
    CHAT_MESSAGES_ZSET = "chat:messages"
    CHAT_MSG_PREFIX = "chat:msg:"
    CHAT_READ_PREFIX = "chat:read:"
    # История сдвигов фронтира: ZSET на юзера, score = seq, до которого дочитал,
    # member = "<seq>|<iso>". Отдельной записи на каждое прочитанное сообщение
    # тут нет намеренно: читают не по одному, а диапазонами — одно событие read
    # переносит фронтир сразу через все накопившиеся сообщения, и время у них
    # общее, других времён просто не существует. Поэтому храним сам сдвиг, а
    # время конкретного сообщения восстанавливаем поиском первого чекпоинта не
    # левее него (см. get_chat_read_at). Размер — по числу событий read внутри
    # retention-окна, а не по числу сообщений.
    CHAT_READ_HIST_PREFIX = "chat:read_hist:"
    CHAT_PINNED_KEY = "chat:pinned"

    async def chat_next_seq(self) -> int:
        """Инкрементирует и возвращает новый seq для сообщения."""
        if not await self._ensure_connection():
            raise RuntimeError("Redis недоступен")
        return await self.redis_client.incr(self.CHAT_SEQ_KEY)

    async def chat_current_seq(self) -> int:
        """Текущий seq (= общее количество отправленных сообщений)."""
        if not await self._ensure_connection():
            return 0
        val = await self.redis_client.get(self.CHAT_SEQ_KEY)
        return int(val) if val else 0

    async def save_chat_message(self, seq: int, message: dict) -> bool:
        """Сохраняет сообщение по его seq и добавляет в ленту."""
        if not await self._ensure_connection():
            return False
        key = f"{self.CHAT_MSG_PREFIX}{seq}"
        await self.redis_client.hset(key, mapping=self._encode_chat_message(message))
        await self.redis_client.zadd(self.CHAT_MESSAGES_ZSET, {str(seq): seq})
        return True

    async def update_chat_message(self, seq: int, fields: dict) -> Optional[dict]:
        """Точечно обновляет поля существующего сообщения (правка текста) и
        возвращает его целиком. None, если сообщения нет — например, автор
        редактирует то, что параллельно удалили."""
        if not await self._ensure_connection():
            return None
        key = f"{self.CHAT_MSG_PREFIX}{seq}"
        if not await self.redis_client.exists(key):
            return None
        await self.redis_client.hset(key, mapping=self._encode_chat_message(fields))
        return await self.get_chat_message(seq)

    @staticmethod
    def _encode_chat_message(message: dict) -> dict:
        """Redis-хэш хранит только строки. None бьём в "" отдельно: str(None)
        дал бы литерал "None", и пустой reply_to читался бы как заполненный."""
        return {k: "" if v is None else str(v) for k, v in message.items()}

    @staticmethod
    def _decode_chat_message(data: dict) -> dict:
        """Обратное преобразование: числа из строк, отсутствующие поля — в
        дефолты. Отдельным методом, потому что в Redis лежат и сообщения,
        записанные до появления ответов/правок, у них этих полей просто нет."""
        data["seq"] = int(data["seq"])
        data["user_id"] = int(data["user_id"])
        data["reply_to"] = int(data["reply_to"]) if data.get("reply_to") else None
        data["reply_to_username"] = data.get("reply_to_username", "")
        data["reply_to_preview"] = data.get("reply_to_preview", "")
        data["edited_at"] = data.get("edited_at") or None
        # Геометрия и крошка-превью фото. 0/"" не только у старых записей, но и
        # у любого сообщения, где клиент не смог декодировать картинку — фронт
        # в обоих случаях откатывается на рамку фиксированного размера.
        data["media_w"] = int(data.get("media_w") or 0)
        data["media_h"] = int(data.get("media_h") or 0)
        data["media_preview"] = data.get("media_preview", "")
        return data

    async def get_chat_messages(self, before_seq: Optional[int] = None, limit: int = 50) -> list:
        """История чата, новые сначала внутри страницы, но список возвращается
        в хронологическом порядке (старые сверху) — готов для рендера ленты."""
        if not await self._ensure_connection():
            return []
        max_score = f"({before_seq}" if before_seq is not None else "+inf"
        seqs = await self.redis_client.zrevrangebyscore(
            self.CHAT_MESSAGES_ZSET, max_score, "-inf", start=0, num=limit
        )
        messages = []
        for s in seqs:
            data = await self.redis_client.hgetall(f"{self.CHAT_MSG_PREFIX}{s}")
            if not data:
                continue
            messages.append(self._decode_chat_message(data))
        messages.reverse()
        return messages

    async def get_chat_message(self, seq: int) -> Optional[dict]:
        """Одно сообщение по seq — нужно для баннера закреплённого сообщения."""
        if not await self._ensure_connection():
            return None
        data = await self.redis_client.hgetall(f"{self.CHAT_MSG_PREFIX}{seq}")
        if not data:
            return None
        return self._decode_chat_message(data)

    async def set_chat_pinned(self, seq: int) -> bool:
        """Закрепляет сообщение — один слот, новое закрепление заменяет старое."""
        if not await self._ensure_connection():
            return False
        await self.redis_client.set(self.CHAT_PINNED_KEY, seq)
        return True

    async def get_chat_pinned_seq(self) -> Optional[int]:
        if not await self._ensure_connection():
            return None
        val = await self.redis_client.get(self.CHAT_PINNED_KEY)
        return int(val) if val else None

    async def clear_chat_pinned(self) -> bool:
        if not await self._ensure_connection():
            return False
        await self.redis_client.delete(self.CHAT_PINNED_KEY)
        return True

    async def get_expired_chat_messages(self, older_than_days: int = 30) -> list:
        """Сообщения старше N дней (seq растёт вместе с временем — как только
        встретили ещё не протухшее, дальше можно не проверять)."""
        if not await self._ensure_connection():
            return []
        cutoff = datetime.now(tz=self.IZHEVSK_TZ) - timedelta(days=older_than_days)
        seqs = await self.redis_client.zrange(self.CHAT_MESSAGES_ZSET, 0, -1)
        expired = []
        for s in seqs:
            data = await self.redis_client.hgetall(f"{self.CHAT_MSG_PREFIX}{s}")
            if not data:
                continue
            try:
                ts = datetime.fromisoformat(data["ts"])
            except (KeyError, ValueError):
                continue
            if ts >= cutoff:
                break
            data["seq"] = int(s)
            expired.append(data)
        return expired

    async def delete_chat_messages(self, seqs: list) -> int:
        """Удаляет сообщения по seq (из hash'ей и из ленты). Не трогает S3 — файлы
        медиа удаляет вызывающая сторона (ChatService), у CacheManager нет доступа к S3."""
        if not seqs or not await self._ensure_connection():
            return 0
        removed = 0
        for s in seqs:
            await self.redis_client.delete(f"{self.CHAT_MSG_PREFIX}{s}")
            await self.redis_client.zrem(self.CHAT_MESSAGES_ZSET, s)
            removed += 1
        return removed

    async def set_chat_read(self, user_id: int, seq: int) -> Optional[str]:
        """Отмечает, что юзер прочитал чат по последнее сообщение seq.
        read_at фиксируется только при первом достижении этого seq — повторный
        вызов с тем же (или меньшим) seq, например просто открыл чат заново
        без новых сообщений, не должен сдвигать "прочитано" на текущее время.
        Возвращает актуальный read_at (при повторном вызове — сохранённый ранее),
        чтобы вызывающая сторона рассылала именно его, а не текущее время.

        Каждый реальный сдвиг фронтира дописывается чекпоинтом в историю: сам
        хэш помнит только последнюю позицию, а вопрос "когда прочитано вот это
        сообщение" задаётся про любое место ленты (см. get_chat_read_at)."""
        if not await self._ensure_connection():
            return None
        key = f"{self.CHAT_READ_PREFIX}{user_id}"
        existing = await self.redis_client.hgetall(key)
        prev_seq = int(existing.get("last_read_seq", 0)) if existing else 0
        if existing and prev_seq >= seq:
            return existing.get("read_at")
        now_iso = datetime.now(tz=self.IZHEVSK_TZ).isoformat()
        mapping = {"last_read_seq": seq, "read_at": now_iso}
        # Граница истории. Всё, что <= hist_from, юзер прочитал до того, как мы
        # начали писать чекпоинты, — точного времени для этих сообщений нет и
        # никогда не будет. Без этой границы поиск "первый чекпоинт не левее
        # сообщения" ответил бы на них ПОЗДНЕЙШИМ чекпоинтом, то есть заявил бы,
        # что прочитанное месяц назад прочитано сегодня: ровно та ошибка в
        # большую сторону, из-за которой в карточке и появилось "раньше".
        if not existing or "hist_from" not in existing:
            mapping["hist_from"] = prev_seq
        await self.redis_client.hset(key, mapping=mapping)
        await self.redis_client.zadd(
            f"{self.CHAT_READ_HIST_PREFIX}{user_id}", {f"{seq}|{now_iso}": seq}
        )
        return now_iso

    async def get_chat_read(self, user_id: int) -> Optional[dict]:
        """Последняя прочитанная юзером позиция. None если юзер ещё не открывал чат."""
        if not await self._ensure_connection():
            return None
        data = await self.redis_client.hgetall(f"{self.CHAT_READ_PREFIX}{user_id}")
        if not data:
            return None
        return {"last_read_seq": int(data["last_read_seq"]), "read_at": data["read_at"]}

    async def get_all_chat_reads(self) -> list:
        """Read-состояние всех юзеров разом — фронт сам считает по нему 'кем и когда
        прочитано' для каждого сообщения (сравнением seq с last_read_seq)."""
        users = await self.list_users()
        reads = []
        for u in users:
            r = await self.get_chat_read(u["user_id"])
            reads.append({
                "user_id": u["user_id"],
                "display_name": u["display_name"],
                "last_read_seq": r["last_read_seq"] if r else 0,
                "read_at": r["read_at"] if r else None,
            })
        return reads

    async def get_chat_read_at(self, user_id: int, seq: int) -> Optional[str]:
        """Когда юзер прочитал именно это сообщение.

        Фронтир движется скачками, поэтому время сообщения — это время того
        сдвига, который через него перешагнул: первый чекпоинт со score >= seq.
        None означает "точного времени нет" и бывает в трёх случаях: юзер до
        сообщения ещё не дочитал; сообщение старше границы истории (hist_from);
        истории нет вовсе (юзер не открывал чат после появления чекпоинтов).
        Все три на UI одинаковы — честное "раньше" вместо выдуманной минуты."""
        if not await self._ensure_connection():
            return None
        data = await self.redis_client.hgetall(f"{self.CHAT_READ_PREFIX}{user_id}")
        if not data or seq <= int(data.get("hist_from", 0)):
            return None
        found = await self.redis_client.zrangebyscore(
            f"{self.CHAT_READ_HIST_PREFIX}{user_id}", seq, "+inf", start=0, num=1
        )
        if not found:
            return None
        # member = "<seq>|<iso>": seq в ключе только ради уникальности члена —
        # два чекпоинта с одинаковым временем иначе схлопнулись бы в один.
        _, _, iso = found[0].partition("|")
        return iso or None

    async def get_all_chat_read_at(self, seq: int) -> list:
        """Время прочтения одного сообщения всеми юзерами — под карточку
        "Прочитали" в меню сообщения. Отдельным запросом, а не полем в
        /chat/read_states: снимок отдаёт позиции всех и приезжает на каждый вход
        в чат, а этот вопрос задаётся про одно сообщение и только по тапу."""
        if not await self._ensure_connection():
            return []
        return [
            {"user_id": u["user_id"], "read_at": await self.get_chat_read_at(u["user_id"], seq)}
            for u in await self.list_users()
        ]

    async def trim_chat_read_history(self) -> None:
        """Выбрасывает чекпоинты, которые уже никому не ответят: те, что левее
        самого старого живого сообщения. Строго левее — чекпоинт со score,
        равным его seq, как раз и есть ответ для этого сообщения."""
        if not await self._ensure_connection():
            return
        oldest = await self.redis_client.zrange(self.CHAT_MESSAGES_ZSET, 0, 0)
        if not oldest:
            return
        min_seq = int(oldest[0])
        for u in await self.list_users():
            await self.redis_client.zremrangebyscore(
                f"{self.CHAT_READ_HIST_PREFIX}{u['user_id']}", "-inf", f"({min_seq}"
            )

    async def get_chat_unread_count(self, user_id: int) -> int:
        """Непрочитанные — это реально лежащие в ленте чужие сообщения новее
        последнего прочитанного.

        Раньше тут была разность счётчиков (chat:seq - last_read_seq), и она
        врала сразу тремя способами, потому что chat:seq только растёт и ничего
        не знает ни об авторстве, ни о том, живо ли ещё сообщение:

          * удалённое сообщение продолжало считаться непрочитанным навсегда;
          * то же самое после чистки по retention — юзер, не заходивший месяц,
            получал бейдж на пустом чате, и погасить его можно было только
            зайдя в чат;
          * системные плашки ("закрепил(а)") и собственные сообщения юзера
            считались наравне с чужими, хотя фронт их в бейдж не берёт (см.
            ветку 'message' в ChatContext) — из-за чего локальный счётчик и
            серверный расходились на каждой пересинхронизации.

        Цена — проход по непрочитанному хвосту вместо вычитания. Хвост ограничен
        сверху всей историей чата (retention 30 дней), а поля берём двумя
        значениями через hmget одним пайплайном, а не hgetall на сообщение.
        """
        if not await self._ensure_connection():
            return 0
        read = await self.get_chat_read(user_id)
        last_read_seq = read["last_read_seq"] if read else 0
        seqs = await self.redis_client.zrangebyscore(
            self.CHAT_MESSAGES_ZSET, f"({last_read_seq}", "+inf"
        )
        if not seqs:
            return 0
        pipe = self.redis_client.pipeline()
        for s in seqs:
            pipe.hmget(f"{self.CHAT_MSG_PREFIX}{s}", "user_id", "type")
        rows = await pipe.execute()
        count = 0
        for author, msg_type in rows:
            # Сообщение исчезло между zrangebyscore и hmget — считать нечего.
            if author is None:
                continue
            if msg_type == "system":
                continue
            try:
                if int(author) == user_id:
                    continue
            except (TypeError, ValueError):
                continue
            count += 1
        return count

    CHAT_LAST_SEEN_PREFIX = "chat:last_seen:"

    async def set_chat_last_seen(self, user_id: int, at: str) -> bool:
        """Момент, когда юзер последним ушёл из чата (переход онлайн->офлайн,
        не каждый heartbeat) — для 'был(а) в сети' в шапке."""
        if not await self._ensure_connection():
            return False
        await self.redis_client.set(f"{self.CHAT_LAST_SEEN_PREFIX}{user_id}", at)
        return True

    async def get_chat_last_seen(self, user_id: int) -> Optional[str]:
        if not await self._ensure_connection():
            return None
        return await self.redis_client.get(f"{self.CHAT_LAST_SEEN_PREFIX}{user_id}")

    # ───────────────────── WEB PUSH ─────────────────────
    # Одна подписка на юзера (последняя выигрывает) — как и с video_token,
    # усложнять до "подписка на устройство" незачем при 4 юзерах.
    PUSH_SUB_PREFIX = "push_sub:"

    async def save_push_subscription(self, user_id: int, subscription: dict) -> bool:
        if not await self._ensure_connection():
            return False
        await self.redis_client.set(f"{self.PUSH_SUB_PREFIX}{user_id}", json.dumps(subscription))
        return True

    async def get_push_subscription(self, user_id: int) -> Optional[dict]:
        if not await self._ensure_connection():
            return None
        raw = await self.redis_client.get(f"{self.PUSH_SUB_PREFIX}{user_id}")
        return json.loads(raw) if raw else None

    async def delete_push_subscription(self, user_id: int) -> bool:
        if not await self._ensure_connection():
            return False
        await self.redis_client.delete(f"{self.PUSH_SUB_PREFIX}{user_id}")
        return True

    # По каким видео-темам юзер хочет пуш (посещение конкретных людей,
    # недоступность платы) — сам PushSubscription общий с чатом, тут
    # только предпочтения.
    VIDEO_NOTIFY_PREFS_PREFIX = "video_notify_prefs:"

    async def save_video_notify_prefs(self, user_id: int, prefs: dict) -> bool:
        if not await self._ensure_connection():
            return False
        await self.redis_client.set(f"{self.VIDEO_NOTIFY_PREFS_PREFIX}{user_id}", json.dumps(prefs))
        return True

    async def get_video_notify_prefs(self, user_id: int) -> Optional[dict]:
        if not await self._ensure_connection():
            return None
        raw = await self.redis_client.get(f"{self.VIDEO_NOTIFY_PREFS_PREFIX}{user_id}")
        return json.loads(raw) if raw else None

    # Ключ раздела (шлёт сам фронт при реальном монтировании страницы) →
    # отображаемое название, для статистики "кто что открывал". Раньше это
    # был prefix-match по пути ЛЮБОГО запроса — ловил и фоновые фетчи
    # глобальных провайдеров (например чат синкает историю/unread на
    # холодном старте приложения для всех, не только зашедших на /chat),
    # так что лента врала про разделы, которые юзер не открывал. Теперь
    # запись бьёт только explicit-визит с самой страницы.
    SECTION_LABELS: dict = {
        "home": "Главная",
        "camera": "Камера",
        "video": "Видео",
        "settings": "Настройки",
        "chat": "Чат",
    }

    VISIT_COOLDOWN_SECONDS = 3600  # один "визит" в час, как и раньше — просто теперь у визита есть свои разделы

    async def record_activity(self, user_id: int, section: str) -> bool:
        """
        Один визит в час на пользователя (как и раньше). Но пока визит активен
        (тот же час), каждый новый раздел, который открыл пользователь,
        дописывается в его же запись — вместо отдельной записи на каждый переход.
        Итог в activity_log: [{"time": "15:34", "routes": ["Настройки", "Камера"]}, ...]
        """
        label = self.SECTION_LABELS.get(section)
        if not label:
            logger.debug(f"record_activity: неизвестный раздел {section}, пропускаю")
            return False
        if not await self._ensure_connection():
            logger.info(f"👁️ record_activity: нет соединения с Redis, пропускаю [{user_id}, {path}]")
            return False
        try:
            now = datetime.now(tz=self.IZHEVSK_TZ)
            today = now.strftime("%Y-%m-%d")
            log_key = f"activity_log:{user_id}:{today}"
            # Кулдаун привязан к дате: иначе если последний визит был в прошлый
            # час до полуночи, первый визит нового дня попадёт в "кулдаун ещё
            # активен" и попытается дописаться в запись today, которой ещё нет —
            # ничего не запишется, хотя функция вернёт True.
            cooldown_key = f"visit_cooldown:{user_id}:{today}"

            if await self.redis_client.exists(cooldown_key):
                # тот же визит — дописываем раздел в последнюю запись, если его там ещё нет
                last_raw = await self.redis_client.lindex(log_key, -1)
                if last_raw:
                    entry = json.loads(last_raw)
                    if label not in entry["routes"]:
                        entry["routes"].append(label)
                        await self.redis_client.lset(log_key, -1, json.dumps(entry))
                        logger.info(f"👁️ record_activity: новый раздел в текущем визите [{user_id}, {label}, {log_key}]")
                return True

            # новый визит
            await self.redis_client.setex(cooldown_key, self.VISIT_COOLDOWN_SECONDS, "1")
            entry = json.dumps({"time": now.strftime("%H:%M"), "routes": [label]})
            await self.redis_client.rpush(log_key, entry)
            await self.redis_client.expire(log_key, timedelta(days=8))
            logger.info(f"👁️ record_activity: новый визит записан [{user_id}, {label}, {log_key}]")
            return True
        except Exception as e:
            logger.error(f"❌ Ошибка записи активности [{user_id}, {path}]: {e}")
            return False

    async def get_visit_stats(self, exclude_user_id: int, days: int = 7) -> list:
        """Вернуть статистику визитов за последние N дней, кроме exclude_user_id."""
        if not await self._ensure_connection():
            return []
        try:
            today = datetime.now(tz=self.IZHEVSK_TZ).date()
            date_range = {
                (today - timedelta(days=i)).strftime("%Y-%m-%d")
                for i in range(days)
            }

            keys = await self.redis_client.keys("activity_log:*")
            user_data: dict = {}

            for key in keys:
                parts = key.split(":")
                if len(parts) != 3:
                    continue
                uid = int(parts[1])
                date = parts[2]
                if uid == exclude_user_id or date not in date_range:
                    continue

                raw_entries = await self.redis_client.lrange(key, 0, -1)
                visits = [json.loads(e) for e in raw_entries]

                if uid not in user_data:
                    user = await self.get_user(uid)
                    user_data[uid] = {
                        "name": user["display_name"] if user else f"ID {uid}",
                        "days": {}
                    }

                user_data[uid]["days"][date] = visits

            return sorted(user_data.values(), key=lambda u: u["name"])
        except Exception as e:
            logger.error(f"❌ Ошибка получения статистики визитов: {e}")
            return []

    async def get_video_list_for_day(self, camera_id: Optional[str], date) -> Optional[list]:
        """Вернуть закэшированный список видео за день. None — cache miss."""
        if not await self._ensure_connection():
            return None
        try:
            cam_key = camera_id or "all"
            key = f"video_list:{cam_key}:{date.strftime('%Y-%m-%d')}"
            data = await self.redis_client.get(key)
            return json.loads(data) if data else None
        except Exception as e:
            logger.error(f"❌ Ошибка чтения кэша видео за {date}: {e}")
            return None

    async def set_video_list_for_day(self, camera_id: Optional[str], date, videos: list, ttl: timedelta) -> bool:
        """Сохранить список видео за день в кэш."""
        if not await self._ensure_connection():
            return False
        try:
            cam_key = camera_id or "all"
            key = f"video_list:{cam_key}:{date.strftime('%Y-%m-%d')}"
            await self.redis_client.setex(key, ttl, json.dumps(videos, default=str))
            logger.debug(f"💾 Кэш видео за {date} сохранён (TTL {ttl})")
            return True
        except Exception as e:
            logger.error(f"❌ Ошибка сохранения кэша видео за {date}: {e}")
            return False

    async def invalidate_video_list_for_day(self, camera_id: Optional[str], date) -> bool:
        """Инвалидировать кэш списка видео за конкретный день."""
        if not await self._ensure_connection():
            return False
        try:
            cam_key = camera_id or "all"
            key = f"video_list:{cam_key}:{date.strftime('%Y-%m-%d')}"
            await self.redis_client.delete(key)
            logger.debug(f"🗑️ Кэш видео за {date.strftime('%Y-%m-%d')} инвалидирован")
            return True
        except Exception as e:
            logger.error(f"❌ Ошибка инвалидации кэша видео за {date}: {e}")
            return False

    async def get_or_create_session_token(self, user_id: int) -> str:
        """Получает существующий токен или создаёт новый"""
        if not await self._ensure_connection():
            raise Exception("Redis not connected")
        
        # Проверяем, есть ли уже токен у пользователя
        token_key = f"user_token:{user_id}"
        existing_token = await self.redis_client.get(token_key)
        
        if existing_token:
            # Продлеваем жизнь существующему токену
            await self.redis_client.expire(f"{self.video_token_prefix}{existing_token}", self.video_token_ttl)
            await self.redis_client.expire(token_key, self.video_token_ttl)
            return existing_token
        
        # Создаём новый токен
        new_token = secrets.token_urlsafe(32)
        
        # video_token:{token} -> user_id
        await self.redis_client.setex(
            f"{self.video_token_prefix}{new_token}",
            self.video_token_ttl,
            str(user_id)
        )
        
        # user_token:{user_id} -> token (для быстрого поиска)
        await self.redis_client.setex(
            token_key,
            self.video_token_ttl,
            new_token
        )
        
        logger.debug(f"Video token created for user {user_id}")
        return new_token

    async def validate_session_token(self, token: str) -> Optional[int]:
        """Проверяет токен, возвращает user_id"""
        if not await self._ensure_connection():
            return None

        user_id = await self.redis_client.get(f"{self.video_token_prefix}{token}")
        if user_id:
            # Продлеваем жизнь токену
            await self.redis_client.expire(f"{self.video_token_prefix}{token}", self.video_token_ttl)
            # Продлеваем и связку user -> token
            await self.redis_client.expire(f"user_token:{int(user_id)}", self.video_token_ttl)
            return int(user_id)
        return None

    # ───────────────────── DOWNTIME TRACKING ─────────────────────

    _startup_grace_until: Optional[datetime] = None

    @classmethod
    def set_startup_grace(cls, seconds: int = 300):
        """Запрещает record_downtime_start на время grace period после старта сервера."""
        cls._startup_grace_until = datetime.now(tz=timezone.utc) + timedelta(seconds=seconds)

    DEVICE_NAMES: dict = {
        "greenhouse_01": "Центральная плата",
        "sensor_door_pir": "Датчик двери",
        "toilet_module": "Туалет",
        "server": "Сервер",
    }

    async def record_downtime_start(self, device_id: str) -> bool:
        """Зафиксировать начало даунтайма устройства."""
        if self._startup_grace_until and datetime.now(tz=timezone.utc) < self._startup_grace_until:
            return False  # Стартовый grace period — игнорируем
        if not await self._ensure_connection():
            return False
        try:
            current_key = f"downtime_current:{device_id}"
            if await self.redis_client.exists(current_key):
                return False  # Уже в даунтайме

            now = datetime.now(tz=self.IZHEVSK_TZ)
            now_iso = now.isoformat()
            today = now.strftime("%Y-%m-%d")

            await self.redis_client.set(current_key, now_iso)

            day_key = f"downtime:{device_id}:{today}"
            raw = await self.redis_client.get(day_key)
            intervals = json.loads(raw) if raw else []
            intervals.append({"start": now_iso, "end": None})
            await self.redis_client.setex(day_key, timedelta(days=8), json.dumps(intervals))

            logger.info(f"🔴 Даунтайм начат: {device_id} в {now.strftime('%H:%M')}")
            return True
        except Exception as e:
            logger.error(f"❌ Ошибка записи начала даунтайма [{device_id}]: {e}")
            return False

    async def record_downtime_end(self, device_id: str) -> bool:
        """Зафиксировать конец даунтайма устройства."""
        if not await self._ensure_connection():
            return False
        try:
            current_key = f"downtime_current:{device_id}"
            start_iso = await self.redis_client.get(current_key)
            if not start_iso:
                return False  # Даунтайма не было

            now = datetime.now(tz=self.IZHEVSK_TZ)
            start_dt = datetime.fromisoformat(start_iso)
            await self.redis_client.delete(current_key)

            start_date = start_dt.strftime("%Y-%m-%d")
            today = now.strftime("%Y-%m-%d")

            if start_date == today:
                # Даунтайм в пределах одного дня
                day_key = f"downtime:{device_id}:{start_date}"
                raw = await self.redis_client.get(day_key)
                intervals = json.loads(raw) if raw else []
                for iv in reversed(intervals):
                    if iv.get("end") is None:
                        iv["end"] = now.isoformat()
                        break
                else:
                    intervals.append({"start": start_iso, "end": now.isoformat()})
                await self.redis_client.setex(day_key, timedelta(days=8), json.dumps(intervals))
            else:
                # Даунтайм пересёк полночь — разбиваем по дням
                current = start_dt
                end_dt = now
                while current.strftime("%Y-%m-%d") <= today:
                    d_str = current.strftime("%Y-%m-%d")
                    next_midnight = (current + timedelta(days=1)).replace(
                        hour=0, minute=0, second=0, microsecond=0
                    )
                    seg_end = min(next_midnight, end_dt)

                    day_key = f"downtime:{device_id}:{d_str}"
                    raw = await self.redis_client.get(day_key)
                    intervals = json.loads(raw) if raw else []
                    if d_str == start_date:
                        # Первый день: закрываем открытый интервал
                        for iv in reversed(intervals):
                            if iv.get("end") is None:
                                iv["end"] = seg_end.isoformat()
                                break
                        else:
                            intervals.append({"start": start_iso, "end": seg_end.isoformat()})
                    else:
                        # Промежуточные/последний день: добавляем полный сегмент
                        intervals.append({"start": current.isoformat(), "end": seg_end.isoformat()})
                    await self.redis_client.setex(day_key, timedelta(days=8), json.dumps(intervals))

                    if seg_end >= end_dt:
                        break
                    current = next_midnight

            duration = now - start_dt
            logger.info(
                f"🟢 Даунтайм закрыт: {device_id}, длился {int(duration.total_seconds() // 60)} мин"
            )
            return True
        except Exception as e:
            logger.error(f"❌ Ошибка записи конца даунтайма [{device_id}]: {e}")
            return False

    async def has_open_downtime(self, device_id: str) -> bool:
        """Есть ли у устройства незакрытый интервал даунтайма прямо сейчас."""
        if not await self._ensure_connection():
            return False
        try:
            return bool(await self.redis_client.exists(f"downtime_current:{device_id}"))
        except Exception as e:
            logger.error(f"❌ Ошибка проверки открытого даунтайма [{device_id}]: {e}")
            return False

    async def _day_intervals_raw(self, device_id: str, day, is_today: bool) -> list:
        """Сырые интервалы даунтайма устройства за день, с дозаполнением текущего
        незакрытого интервала («до сейчас»), если день — сегодня."""
        day_str = day.strftime("%Y-%m-%d")
        raw = await self.redis_client.get(f"downtime:{device_id}:{day_str}")
        intervals = json.loads(raw) if raw else []
        if is_today:
            start_iso = await self.redis_client.get(f"downtime_current:{device_id}")
            if start_iso and not any(iv.get("end") is None for iv in intervals):
                intervals.append({"start": start_iso, "end": None})
        return intervals

    @staticmethod
    def _subtract_intervals(base: list, cut: list, now: datetime) -> list:
        """Вычитает интервалы cut из base (оба — списки {"start": iso, "end": iso|None},
        открытый end=None считается длящимся до now). При частичном пересечении режет
        base на остатки; при полном перекрытии кусок пропадает целиком."""
        def parse(iv):
            s = datetime.fromisoformat(iv["start"])
            open_ended = iv.get("end") is None
            e = now if open_ended else datetime.fromisoformat(iv["end"])
            return s, e, open_ended

        segments = [parse(iv) for iv in base]

        for iv in cut:
            cs, ce, _ = parse(iv)
            new_segments = []
            for s, e, open_ended in segments:
                if ce <= s or cs >= e:
                    new_segments.append((s, e, open_ended))
                    continue
                if cs > s:
                    new_segments.append((s, cs, False))
                if ce < e:
                    new_segments.append((ce, e, open_ended))
            segments = new_segments

        return [
            {"start": s.isoformat(), "end": None if open_ended else e.isoformat()}
            for s, e, open_ended in segments
        ]

    async def get_downtime_stats(self, device_ids: list, days: int = 7) -> dict:
        """Статистика даунтайма за N дней для списка устройств.

        Даунтайм камеры пишется при обрыве её WebSocket-соединения — а обрыв
        происходит в том числе когда сам сервер уходит на рестарт/деплой. В этот
        момент сервер не может знать, была ли камера реально жива: он сам не
        работал и наблюдать не мог. Поэтому из интервалов камеры вычитаем те,
        что пересекаются с даунтаймом сервера — остаётся только время, когда
        камера была недоступна при заведомо живом сервере.
        """
        if not await self._ensure_connection():
            return {}
        try:
            now = datetime.now(tz=self.IZHEVSK_TZ)
            today = now.date()
            result = {}

            for device_id in device_ids:
                day_stats: dict = {}
                total_down = 0

                for i in range(days):
                    day = today - timedelta(days=i)
                    day_str = day.strftime("%Y-%m-%d")
                    is_today = (i == 0)

                    intervals = await self._day_intervals_raw(device_id, day, is_today)

                    if device_id == CAMERA_ID:
                        server_intervals = await self._day_intervals_raw("server", day, is_today)
                        intervals = self._subtract_intervals(intervals, server_intervals, now)

                    # Считаем суммарный даунтайм дня
                    day_seconds = 0.0
                    day_start = datetime(day.year, day.month, day.day, tzinfo=self.IZHEVSK_TZ)
                    day_end = day_start + timedelta(days=1) if i > 0 else now

                    for iv in intervals:
                        try:
                            s = datetime.fromisoformat(iv["start"])
                            e = datetime.fromisoformat(iv["end"]) if iv.get("end") else now
                            # Обрезаем до границ дня
                            s = max(s, day_start)
                            e = min(e, day_end)
                            day_seconds += max(0.0, (e - s).total_seconds())
                        except Exception:
                            pass

                    total_seconds_in_day = (day_end - day_start).total_seconds()
                    uptime_pct = round(
                        max(0.0, (total_seconds_in_day - day_seconds) / total_seconds_in_day * 100), 1
                    )

                    day_stats[day_str] = {
                        "intervals": intervals,
                        "downtime_seconds": int(day_seconds),
                        "uptime_pct": uptime_pct,
                    }
                    total_down += int(day_seconds)

                result[device_id] = {
                    "name": self.DEVICE_NAMES.get(device_id, device_id),
                    "days": day_stats,
                    "total_downtime_seconds": total_down,
                }

            return result
        except Exception as e:
            logger.error(f"❌ Ошибка получения статистики даунтайма: {e}")
            return {}

    async def update_server_heartbeat(self) -> bool:
        """Обновить heartbeat сервера (раз в 5 минут)."""
        if not await self._ensure_connection():
            return False
        try:
            now_iso = datetime.now(tz=self.IZHEVSK_TZ).isoformat()
            await self.redis_client.set("server:heartbeat", now_iso)
            return True
        except Exception as e:
            logger.error(f"❌ Ошибка обновления heartbeat сервера: {e}")
            return False

    async def recover_server_downtime(self) -> bool:
        """
        При старте сервера: восстановить даунтайм сервера по последнему heartbeat.
        Вызывать один раз в initialize_services().
        """
        if not await self._ensure_connection():
            return False
        try:
            last_beat = await self.redis_client.get("server:heartbeat")
            now = datetime.now(tz=self.IZHEVSK_TZ)

            if last_beat:
                last_dt = datetime.fromisoformat(last_beat)
                gap = (now - last_dt).total_seconds()

                if gap > 600:  # > 10 минут — сервер был не онлайн
                    logger.warning(
                        f"🔴 Обнаружен даунтайм сервера: "
                        f"{int(gap // 60)} мин ({last_dt.strftime('%H:%M')} — {now.strftime('%H:%M')})"
                    )
                    # Записываем как даунтайм через тот же механизм
                    current_key = "downtime_current:server"
                    await self.redis_client.set(current_key, last_dt.isoformat())

                    # Добавляем в день-лист начало (чтобы record_downtime_end нашёл)
                    start_date = last_dt.strftime("%Y-%m-%d")
                    day_key = f"downtime:server:{start_date}"
                    raw = await self.redis_client.get(day_key)
                    intervals = json.loads(raw) if raw else []
                    intervals.append({"start": last_dt.isoformat(), "end": None})
                    await self.redis_client.setex(day_key, timedelta(days=8), json.dumps(intervals))

                    await self.record_downtime_end("server")
                    logger.info("✅ Даунтайм сервера зафиксирован")
                else:
                    logger.info(f"✅ Последний heartbeat {int(gap // 60)} мин назад — разрыва нет")
            else:
                logger.info("📡 Первый старт сервера — heartbeat ещё не было")

            await self.update_server_heartbeat()
            return True
        except Exception as e:
            logger.error(f"❌ Ошибка восстановления даунтайма сервера: {e}")
            return False

    async def get_cached_video_key(self, camera_id: str, video_id: str) -> Optional[str]:
        """Получить S3-ключ видео из кэша."""
        if not await self._ensure_connection():
            return None
        try:
            return await self.redis_client.get(f"video_key:{camera_id}:{video_id}")
        except Exception as e:
            logger.error(f"❌ Ошибка чтения ключа видео из кэша: {e}")
            return None

    async def set_video_key(self, camera_id: str, video_id: str, s3_key: str) -> bool:
        """Сохранить S3-ключ видео в кэш."""
        if not await self._ensure_connection():
            return False
        try:
            await self.redis_client.setex(
                f"video_key:{camera_id}:{video_id}",
                timedelta(days=MEDIA_RETENTION_DAYS + 1),
                s3_key
            )
            return True
        except Exception as e:
            logger.error(f"❌ Ошибка сохранения ключа видео в кэш: {e}")
            return False