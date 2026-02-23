import redis.asyncio as redis
from typing import Optional
from app.schemas.weather_data import WeatherData
from datetime import timedelta, datetime
import json
from logger import logger
import asyncio
import secrets

# =================== КЭШ МЕНЕДЖЕР ===================
class CacheManager:
    """Управление кэшированием погодных данных"""
    
    def __init__(self, redis_url: str):
        self.redis_client = None
        self.redis_url = redis_url
        self.key_prefix = "access_key:"
        self.key_ttl = timedelta(days=180)  # 180 дней жизни ключа

        
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
            
            # Обновляем счетчик вызовов за день
            today = datetime.now().strftime("%Y-%m-%d")
            await self.redis_client.incr(f"api_calls:{today}")
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