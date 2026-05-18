import redis.asyncio as redis
from typing import Optional
from app.schemas.weather_data import WeatherData
from datetime import timedelta, datetime, timezone
import json
from logger import logger
import asyncio
import secrets
from config import DEFAULT_RECORDING_DAYS

# =================== КЭШ МЕНЕДЖЕР ===================
class CacheManager:
    """Управление кэшированием данных"""
    
    def __init__(self, redis_url: str):
        self.redis_client = None
        self.redis_url = redis_url
        self.key_prefix = "access_key:"
        self.key_ttl = timedelta(days=180)  # 180 дней жизни ключа

        # Токены для просмотра видео
        self.video_token_prefix = "video_token:"   # token -> video_key
        self.video_token_ttl = 3600                # 1 час

        # Для дедупликации видео (хранить ID уже обработанных видео)
        self.video_dedup_prefix = "video_dedup:"
        self.video_dedup_ttl = timedelta(days=DEFAULT_RECORDING_DAYS)

        
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
            # Сохраняем на 10 минут
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

    async def generate_key(self, user_id: int) -> str:
        """Генерирует новый ключ для пользователя."""
        if not self.redis_client:
            return
        
        if not await self._ensure_connection():
            return
        
        # Генерируем случайный ключ
        key = secrets.token_urlsafe(32)
        redis_key = f"{self.key_prefix}{key}"
            
        try:
            # Сохраняем на 10 минут
            await self.redis_client.setex(
                redis_key,
                self.key_ttl,
                str(user_id)
            )
            
            # Обновляем счетчик вызовов за день
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
    
    async def revoke_key(self, key: str) -> bool:
        """Отзывает ключ"""
        redis_key = f"{self.key_prefix}{key}"
        return bool(await self.redis_client.delete(redis_key))
    
    async def cache_daily_report(self, report_text: str, report_date: str, now: datetime) -> bool:
        """
        Сохранить дневной отчёт в кэш до конца текущего дня.
        report_date: дата отчёта в формате YYYY-MM-DD
        """
        if not self.redis_client:
            return False
        
        if not await self._ensure_connection():
            return False
        
        try:
            # Считаем, сколько секунд осталось до конца дня
            end_of_day = now.replace(hour=23, minute=59, second=59, microsecond=999999)
            seconds_until_end = int((end_of_day - now).total_seconds())
            
            # Если вдруг уже после 23:59 (маловероятно, но вдруг)
            if seconds_until_end < 0:
                seconds_until_end = 60  # кэш на минуту, чтобы не сломаться
            
            # Сохраняем отчёт
            await self.redis_client.setex(
                f"report:daily:{report_date}",
                seconds_until_end,
                report_text
            )
            
            logger.info(f"📅 Дневной отчёт за {report_date} сохранён в кэш на {seconds_until_end}с")
            return True
            
        except Exception as e:
            logger.exception(f"❌ Ошибка сохранения дневного отчёта в кэш: {e}")
            return False

    async def get_cached_daily_report(self, report_date: str) -> Optional[str]:
        """
        Получить дневной отчёт из кэша.
        report_date: дата отчёта в формате YYYY-MM-DD
        """
        if not self.redis_client:
            return None
        
        if not await self._ensure_connection():
            return None
        
        try:
            report = await self.redis_client.get(f"report:daily:{report_date}")
            
            if report:
                logger.info(f"📅 Дневной отчёт за {report_date} получен из кэша")
            else:
                logger.info(f"📅 Дневной отчёт за {report_date} в кэше не найден")
            
            return report
            
        except Exception as e:
            logger.exception(f"❌ Ошибка получения дневного отчёта из кэша: {e}")
            return None
        
    async def cache_weekly_report(self, report_text: str, week_key: str, now: datetime) -> bool:
        """
        Сохранить недельный отчёт в кэш до конца текущего дня.
        week_key: ключ недели в формате YYYY-MM-DD (последний день недели)
        """
        if not self.redis_client:
            return False
        
        if not await self._ensure_connection():
            return False
        
        try:
            # Считаем, сколько секунд осталось до конца дня
            end_of_day = now.replace(hour=23, minute=59, second=59, microsecond=999999)
            seconds_until_end = int((end_of_day - now).total_seconds())
            
            if seconds_until_end < 0:
                seconds_until_end = 60
            
            # Сохраняем отчёт
            await self.redis_client.setex(
                f"report:weekly:{week_key}",
                seconds_until_end,
                report_text
            )
            
            logger.info(f"📆 Недельный отчёт за неделю {week_key} сохранён в кэш на {seconds_until_end}с")
            return True
            
        except Exception as e:
            logger.exception(f"❌ Ошибка сохранения недельного отчёта в кэш: {e}")
            return False

    async def get_cached_weekly_report(self, week_key: str) -> Optional[str]:
        """
        Получить недельный отчёт из кэша.
        week_key: ключ недели в формате YYYY-MM-DD (последний день недели)
        """
        if not self.redis_client:
            return None
        
        if not await self._ensure_connection():
            return None
        
        try:
            report = await self.redis_client.get(f"report:weekly:{week_key}")
            
            if report:
                logger.info(f"📆 Недельный отчёт за неделю {week_key} получен из кэша")
            else:
                logger.info(f"📆 Недельный отчёт за неделю {week_key} в кэше не найден")
            
            return report
            
        except Exception as e:
            logger.exception(f"❌ Ошибка получения недельного отчёта из кэша: {e}")
            return None
        
    USER_NAMES: dict = {
        61327489: "Камелия",
        4382099: "Лилия",
        987654: "Андрей",
    }
    IZHEVSK_TZ = timezone(timedelta(hours=4))

    async def record_visit(self, user_id: int) -> bool:
        """Записать визит пользователя (не чаще раза в час на пользователя)."""
        if not await self._ensure_connection():
            return False
        try:
            cooldown_key = f"visit_cooldown:{user_id}"
            if await self.redis_client.exists(cooldown_key):
                return False

            await self.redis_client.setex(cooldown_key, 3600, "1")

            now = datetime.now(tz=self.IZHEVSK_TZ)
            today = now.strftime("%Y-%m-%d")
            time_str = now.strftime("%H:%M")

            visits_key = f"login_visits:{user_id}:{today}"
            visits_raw = await self.redis_client.get(visits_key)
            visits = json.loads(visits_raw) if visits_raw else []
            visits.append(time_str)
            await self.redis_client.setex(visits_key, timedelta(days=8), json.dumps(visits))
            logger.debug(f"👁️ Визит записан: user={user_id} в {time_str}")
            return True
        except Exception as e:
            logger.error(f"❌ Ошибка записи визита: {e}")
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

            keys = await self.redis_client.keys("login_visits:*")
            user_data: dict = {}

            for key in keys:
                parts = key.split(":")
                if len(parts) != 3:
                    continue
                uid = int(parts[1])
                date = parts[2]
                if uid == exclude_user_id or date not in date_range:
                    continue

                visits_raw = await self.redis_client.get(key)
                visits = json.loads(visits_raw) if visits_raw else []

                if uid not in user_data:
                    user_data[uid] = {
                        "name": self.USER_NAMES.get(uid, f"ID {uid}"),
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

    DEVICE_NAMES: dict = {
        "greenhouse_01": "Центральная плата",
        "sensor_door_pir": "Датчик двери",
        "toilet_module": "Туалет",
        "server": "Сервер",
    }

    async def record_downtime_start(self, device_id: str) -> bool:
        """Зафиксировать начало даунтайма устройства."""
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

    async def get_downtime_stats(self, device_ids: list, days: int = 7) -> dict:
        """Статистика даунтайма за N дней для списка устройств."""
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

                    raw = await self.redis_client.get(f"downtime:{device_id}:{day_str}")
                    intervals = json.loads(raw) if raw else []

                    # Если сегодня и есть незакрытый даунтайм — дополняем «до сейчас»
                    if i == 0:
                        start_iso = await self.redis_client.get(f"downtime_current:{device_id}")
                        if start_iso:
                            has_open = any(iv.get("end") is None for iv in intervals)
                            if not has_open:
                                intervals.append({"start": start_iso, "end": None})

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
                timedelta(days=DEFAULT_RECORDING_DAYS + 1),
                s3_key
            )
            return True
        except Exception as e:
            logger.error(f"❌ Ошибка сохранения ключа видео в кэш: {e}")
            return False