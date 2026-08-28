from typing import Dict, List, Optional
import shutil
from fastapi import Request, HTTPException, WebSocket
from starlette.status import HTTP_401_UNAUTHORIZED, HTTP_403_FORBIDDEN
from app.services.redis.cache_manager import CacheManager
from app.services.weather_service.yandex_weather import WeatherService
import asyncio
from datetime import datetime, timedelta
from logger import logger
from app.services.mqtt_service.mqtt import MQTTService, BoardData
from app.services.s3_service.s3_manager import S3Manager
from app.schemas.telemetry import TelemetryData, GeneralResponse, DiskUsage
from app.schemas.weather_data import WeatherData
from app.schemas.settings import SettingsData
from app.schemas.device_status import DeviceStatus
from app.services.video_service.video_service import VideoService
from app.services.chat_service.chat_service import ChatService
from app.services.monitor_db.telemetry_storage import TelemetryStorage
from app.utils.time import _get_izhevsk_time
from app.core.auth import init_auth_manager, get_auth_manager

# Константы и тайминги по умолчанию
DEFAULT_WEATHER_UPDATE_INTERVAL = 1800  # 30 минут (в секундах)
DEFAULT_TIME_UPDATE_INTERVAL = 43200  # 12 часов
DEFAULT_HEARTBEAT_INTERVAL = 60
DEFAULT_DEVICE_ID = "greenhouse_01"
DEFAULT_SENSOR_ID = "sensor_door_pir"
DEFAULT_TOILET_ID = "toilet_module"

# =================== ФОНОВЫЙ ВОРКЕР ===================
class BackgroundWorker:
    """Фоновый воркер для взаимодействия с платой"""
    
    _instance: Optional['BackgroundWorker'] = None
    _lock = asyncio.Lock()
    
    def __init__(
            self,
            cache_manager: CacheManager,
            weather_service: WeatherService,
            video_service: VideoService,
            mqtt_service: MQTTService,
            storage: TelemetryStorage,
            chat_service: ChatService,
            ):
        if BackgroundWorker._instance is not None:
            raise RuntimeError("Используйте BackgroundWorker.get_instance()")

        self.cache = cache_manager
        self.mqtt_service = mqtt_service
        self.service = weather_service
        self.storage = storage
        self.video_service = video_service
        self.chat_service = chat_service
        self.is_running = False
        self.update_board_weather_interval = DEFAULT_WEATHER_UPDATE_INTERVAL 
        self.update_time_interval = DEFAULT_TIME_UPDATE_INTERVAL
        self.heartbeat_interval = DEFAULT_HEARTBEAT_INTERVAL
        self.device_id = DEFAULT_DEVICE_ID
        self.sensor_id = DEFAULT_SENSOR_ID
        self.toilet_id = DEFAULT_TOILET_ID
        self.current_telemetry: Optional[TelemetryData] = None
        startup_time = _get_izhevsk_time()
        self.last_activity_timestamp: Optional[datetime] = startup_time
        self.device_status: DeviceStatus = DeviceStatus.ONLINE
        self.last_activity_timestamp_sensor: Optional[datetime] = startup_time
        self.sensor_status: DeviceStatus = DeviceStatus.ONLINE
        self.last_activity_timestamp_toilet: Optional[datetime] = startup_time
        self.toilet_status: DeviceStatus = DeviceStatus.ONLINE
        self.counter_for_telemetry = 0
        init_auth_manager(cache_manager)
        self._initialization_complete = False  # Флаг: сервис полностью инициализирован
        
    @classmethod
    def get_instance(
        cls,
        cache_manager: CacheManager = None,
        weather_service: WeatherService = None,
        video_service: VideoService = None,
        mqtt_service: MQTTService = None,
        storage: TelemetryStorage = None,
        chat_service: ChatService = None,
    ) -> 'BackgroundWorker':
        """Получить единственный экземпляр воркера"""
        if cls._instance is None:
            if cache_manager is None or weather_service is None or mqtt_service is None or storage is None or video_service is None or chat_service is None:
                raise ValueError("При первом создании нужно передать все зависимости")

            cls._instance = cls(cache_manager, weather_service, video_service, mqtt_service, storage, chat_service)
        return cls._instance

    @classmethod
    async def get_instance_async(
        cls,
        cache_manager: CacheManager = None,
        weather_service: WeatherService = None,
        video_service: VideoService = None,
        mqtt_service: MQTTService = None,
        storage: TelemetryStorage = None,
        chat_service: ChatService = None,
    ) -> 'BackgroundWorker':
        """Асинхронная версия получения инстанса (с блокировкой)"""
        async with cls._lock:
            return cls.get_instance(cache_manager, weather_service, video_service, mqtt_service, storage, chat_service)
    
    @property
    def auth(self):
        """Свойство для доступа к AuthManager"""
        return get_auth_manager()

    async def initialize_services(self):
        """Инициализирует асинхронные сервисы (вызывается ПОСЛЕ создания worker)"""
        logger.info("🎬 Инициализирую асинхронные сервисы...")

        # Запускаем VideoService observer loop в фоне
        asyncio.create_task(self.video_service.start())
        logger.info("✅ VideoService инициализирован (observer loop запущен)")

        # Восстанавливаем ключи авторизации из файлового бэкапа (на случай очистки Redis)
        await self.cache.restore_keys_from_backup()

        # Досоздаём недостающих юзеров из захардкоженного списка (набор людей фиксирован)
        await self.cache.seed_users_if_missing()

        # 5 минут grace period — не пишем даунтайм пока всё поднимается
        self.cache.set_startup_grace(300)

        # При рестарте in-memory статус устройств всегда стартует оптимистично ONLINE
        # (last_activity_timestamp = "сейчас", см. __init__), поэтому если устройство
        # реально было в даунтайме ДО рестарта (интервал в Redis всё ещё открыт) и
        # переподключилось быстро — переход OFFLINE/DEAD → ONLINE, который закрывает
        # интервал, просто не произойдёт: in-memory статус никогда не побывает в OFFLINE/DEAD.
        # Интервал так и останется открытым в Redis навсегда. Раньше это лечили тем, что
        # при каждом рестарте удаляли (discard_downtime) любой открытый интервал — но это
        # стирало реальный даунтайм, если устройство и правда легло перед деплоем.
        # Вместо этого: если даунтайм был открыт по-настоящему — состариваем timestamp
        # активности и явно выставляем DEAD, чтобы следующий реальный коннект честно
        # закрыл интервал сам, с правильным временем окончания.
        # Камера тут не участвует: её downtime_end вызывается безусловно при любом
        # реконнекте (video_service.py), у неё нет проблемы «застревания».
        stale_timestamp = _get_izhevsk_time() - timedelta(days=1)
        for device_id, ts_attr, status_attr in [
            (self.device_id, "last_activity_timestamp", "device_status"),
            (self.sensor_id, "last_activity_timestamp_sensor", "sensor_status"),
            (self.toilet_id, "last_activity_timestamp_toilet", "toilet_status"),
        ]:
            if await self.cache.has_open_downtime(device_id):
                setattr(self, ts_attr, stale_timestamp)
                setattr(self, status_attr, DeviceStatus.DEAD)

        # Восстанавливаем даунтайм сервера по последнему heartbeat
        await self.cache.recover_server_downtime()

        # Готовимся к приему MQTT сообщений (будет в start())
        self._initialization_complete = True
        
    async def start(self):
        """Запуск фонового воркера"""
        self.is_running = True
        logger.info("🚀 Запущен фоновый воркер")

        self.mqtt_service.set_telemetry_callback(self.handle_telemetry)
        self.mqtt_service.set_weather_request_callback(self.handle_weather_request)
        self.mqtt_service.set_door_motion_callback(self.handle_door_event)
        self.mqtt_service.set_heartbeat_sensor_callback(self.handle_sensor_healthcheck)
        self.mqtt_service.set_toilet_activity_callback(self.handle_toilet_telemetry)
        self.mqtt_service.set_silence_ended_callback(self.handle_toilet_silence_ended)
        logger.info("Установлены обработчики сообщений от платы.")
        
        # 🔧 РАЗРЕШАЕМ ОБРАБОТКУ РЕАЛЬНЫХ СООБЩЕНИЙ (не retained)
        self._initialization_complete = True
        logger.info("✅ Инициализация завершена, обработка реальных событий включена")
        
        # Запускаем задачи параллельно
        await asyncio.gather(
            self._update_weather_loop(),
            self._check_heartbeat_esp_loop(),
            self._check_time_update_loop(),
            self._server_heartbeat_loop(),
            self._chat_retention_loop(),
        )

    def _update_device_status(self) -> DeviceStatus:
        """Обновление статуса центральной платы на основе последней активности."""
        if self.last_activity_timestamp is None:
            new_status = DeviceStatus.NEVER_CONNECTED
        else:
            seconds_ago = (_get_izhevsk_time() - self.last_activity_timestamp).total_seconds()
            
            if seconds_ago < 120:  # < 2 минут
                new_status = DeviceStatus.ONLINE
            elif seconds_ago < 300:  # 2-5 минут
                new_status = DeviceStatus.OFFLINE
            else:  # > 5 минут
                new_status = DeviceStatus.DEAD
        
        # Логируем изменение статуса
        if new_status != self.device_status:
            logger.info(f"📱 Статус центральной платы изменился: {self.device_status.value} → {new_status.value}")
            self.device_status = new_status
        
        return self.device_status
    
    def _update_sensor_status(self) -> DeviceStatus:
        """Обновление статуса датчика двери на основе активности (любые сообщения от платы)"""
        if self.last_activity_timestamp_sensor is None:
            new_status = DeviceStatus.NEVER_CONNECTED
        else:
            seconds_ago = (_get_izhevsk_time() - self.last_activity_timestamp_sensor).total_seconds()

            if seconds_ago < 600:  # < 10 минут
                new_status = DeviceStatus.ONLINE
            elif seconds_ago < 1200:  # 20 минут
                new_status = DeviceStatus.OFFLINE
            else:
                new_status = DeviceStatus.DEAD

        if new_status != self.sensor_status:
            logger.info(f"📱 Статус датчика двери изменился: {self.sensor_status.value} → {new_status.value}")
            self.sensor_status = new_status

        return self.sensor_status

    def _update_toilet_status(self) -> DeviceStatus:
        """Обновление статуса туалетной платы на основе активности"""
        if self.last_activity_timestamp_toilet is None:
            new_status = DeviceStatus.NEVER_CONNECTED
        else:
            seconds_ago = (_get_izhevsk_time() - self.last_activity_timestamp_toilet).total_seconds()

            if seconds_ago < 120:  # < 2 минут (heartbeat каждую минуту)
                new_status = DeviceStatus.ONLINE
            elif seconds_ago < 300:
                new_status = DeviceStatus.OFFLINE
            else:
                new_status = DeviceStatus.DEAD

        if new_status != self.toilet_status:
            logger.info(f"🚽 Статус туалета изменился: {self.toilet_status.value} → {new_status.value}")
            self.toilet_status = new_status

        return self.toilet_status

    async def _check_time_update_loop(self, timeout: float = 30.0):
        """
        Цикл синхронизации времени. Проверяет раз в сутки.
        """
        await asyncio.sleep(30)
        while self.is_running:
            try:
                logger.info(f"⏰ Проверка синхронизации времени для {self.device_id}")

                if not self.can_send_to_device(self.device_status):
                    logger.warning(f"⚠️ Пропускаем синхронизацию времени: устройство {self.device_status.value}")
                    await asyncio.sleep(self.update_time_interval)
                    continue
                
                # 1. Проверяем, нужна ли синхронизация (прошло ли 2+ дней)
                need_sync = await self.cache.should_sync_time(device_id=self.device_id)
                
                if not need_sync:
                    logger.info(f"Устройство {self.device_id}: синхронизация не требуется")
                    await asyncio.sleep(self.update_time_interval)
                    continue
                
                logger.info(f"🕐 Устройство {self.device_id} требует синхронизации времени")
                
                # 2. Колбэки для обработки ответов от обоих устройств
                greenhouse_future = asyncio.Future()
                toilet_future = asyncio.Future()

                async def on_greenhouse_time(device_id: str, data: dict):
                    if device_id == self.device_id and not greenhouse_future.done():
                        self._record_device_activity("time_sync_response")
                        await self.cache.mark_sync_completed(device_id)
                        logger.info(f"✅ {device_id} подтвердил синхронизацию времени")
                        greenhouse_future.set_result(True)

                async def on_toilet_time(device_id: str, data: dict):
                    if device_id == self.toilet_id and not toilet_future.done():
                        self._record_toilet_activity("time_sync_response")
                        logger.info(f"✅ {device_id} подтвердил синхронизацию времени")
                        toilet_future.set_result(True)

                self.mqtt_service.set_time_callback(on_greenhouse_time)
                self.mqtt_service.set_time_callback_toilet(on_toilet_time)

                # 3. Получаем текущее время Ижевска
                now = _get_izhevsk_time()

                # 4. Формируем данные для ESP
                time_data = {
                    "year": now.year,
                    "month": now.month,
                    "day": now.day,
                    "hour": now.hour,
                    "minute": now.minute,
                    "second": now.second
                }

                logger.info(f"📤 Отправляю время на обе платы: "
                        f"{now.hour:02d}:{now.minute:02d} "
                        f"{now.day:02d}.{now.month:02d}.{now.year}")

                # 5. Отправляем время обоим устройствам
                await self.mqtt_service.send_time_to_device(
                    device_id=self.device_id,
                    payload=time_data
                )
                if self.can_send_to_device(self.toilet_status):
                    await self.mqtt_service.send_time_to_toilet(payload=time_data)
                else:
                    logger.warning(f"⚠️ Туалет недоступен, пропускаем синхронизацию времени")
                    toilet_future.set_result(False)

                # 6. Ждём ответов от обоих с общим таймаутом
                try:
                    await asyncio.wait_for(
                        asyncio.gather(greenhouse_future, toilet_future, return_exceptions=True),
                        timeout=timeout
                    )
                    logger.info("✅ Синхронизация времени завершена")
                except asyncio.TimeoutError:
                    if not greenhouse_future.done():
                        logger.warning(f"⏳ {self.device_id} не подтвердил синхронизацию")
                    if not toilet_future.done():
                        logger.warning(f"⏳ {self.toilet_id} не подтвердил синхронизацию")

                # 7. Помечаем синхронизацию завершённой для центральной платы
                await self.cache.mark_sync_completed(self.device_id)

                # 8. Очищаем колбэки
                self.mqtt_service.remove_time_callback()
                self.mqtt_service.remove_time_callback_toilet()
                
            except asyncio.CancelledError:
                logger.info(f"🚫 Цикл синхронизации для {self.device_id} отменен")
                break
                
            except Exception as e:
                logger.exception(f"❌ Ошибка в цикле синхронизации: {e}")
                # При ошибке ждем стандартный интервал
                
            # 8. Ждем сутки до следующей проверки
            logger.info(f"⏳ Жду {self.update_time_interval} сек до следующей проверки")
            await asyncio.sleep(self.update_time_interval)

    async def sync_time_now(self, timeout: float = 30.0) -> dict:
        """Принудительная синхронизация времени для обоих устройств."""
        now = _get_izhevsk_time()
        time_data = {
            "year": now.year,
            "month": now.month,
            "day": now.day,
            "hour": now.hour,
            "minute": now.minute,
            "second": now.second
        }

        greenhouse_future = asyncio.Future()
        toilet_future = asyncio.Future()

        async def on_greenhouse_time(device_id: str, _data: dict):
            if device_id == self.device_id and not greenhouse_future.done():
                self._record_device_activity("forced_time_sync")
                await self.cache.mark_sync_completed(device_id)
                greenhouse_future.set_result(True)

        async def on_toilet_time(device_id: str, _data: dict):
            if device_id == self.toilet_id and not toilet_future.done():
                self._record_toilet_activity("forced_time_sync")
                toilet_future.set_result(True)

        self.mqtt_service.set_time_callback(on_greenhouse_time)
        self.mqtt_service.set_time_callback_toilet(on_toilet_time)

        greenhouse_sent = self.can_send_to_device(self.device_status)
        toilet_sent = self.can_send_to_device(self.toilet_status)

        if greenhouse_sent:
            await self.mqtt_service.send_time_to_device(device_id=self.device_id, payload=time_data)
        else:
            greenhouse_future.set_result(False)

        if toilet_sent:
            await self.mqtt_service.send_time_to_toilet(payload=time_data)
        else:
            toilet_future.set_result(False)

        try:
            await asyncio.wait_for(
                asyncio.gather(greenhouse_future, toilet_future, return_exceptions=True),
                timeout=timeout
            )
        except asyncio.TimeoutError:
            pass
        finally:
            self.mqtt_service.remove_time_callback()
            self.mqtt_service.remove_time_callback_toilet()

        greenhouse_ok = greenhouse_future.done() and greenhouse_future.result() is True
        toilet_ok = toilet_future.done() and toilet_future.result() is True

        logger.info(f"⏰ Принудительная синхронизация: greenhouse={greenhouse_ok}, toilet={toilet_ok}")
        return {
            "greenhouse": "ok" if greenhouse_ok else ("offline" if not greenhouse_sent else "timeout"),
            "toilet": "ok" if toilet_ok else ("offline" if not toilet_sent else "timeout"),
        }

    def can_send_to_device(self, device_status: DeviceStatus) -> bool:
        """Можно ли отправлять команды на устройство?"""
        return device_status == DeviceStatus.ONLINE

    def _record_device_activity(self, activity_name: str = ""):
        """Записать активность центральной платы (любое сообщение)"""
        old = self.device_status
        self.last_activity_timestamp = _get_izhevsk_time()
        self.device_status = self._update_device_status()
        if old in (DeviceStatus.OFFLINE, DeviceStatus.DEAD) and self.device_status == DeviceStatus.ONLINE:
            asyncio.create_task(self.cache.record_downtime_end(self.device_id))
        if activity_name:
            logger.debug(f"📍 Активность: {activity_name}. Статус устройства {self.device_status.value}")

    def _record_toilet_activity(self, activity_name: str = ""):
        """Записать активность туалетной платы (любое сообщение)"""
        old = self.toilet_status
        self.last_activity_timestamp_toilet = _get_izhevsk_time()
        self.toilet_status = self._update_toilet_status()
        if old in (DeviceStatus.OFFLINE, DeviceStatus.DEAD) and self.toilet_status == DeviceStatus.ONLINE:
            asyncio.create_task(self.cache.record_downtime_end(self.toilet_id))
        if activity_name:
            logger.debug(f"🚽 Активность туалета: {activity_name}. Статус {self.toilet_status.value}")

    async def _server_heartbeat_loop(self):
        """Раз в 5 минут пишем heartbeat сервера в Redis."""
        while self.is_running:
            try:
                await self.cache.update_server_heartbeat()
            except Exception as e:
                logger.error(f"❌ Ошибка server heartbeat: {e}")
            await asyncio.sleep(300)

    async def _chat_retention_loop(self):
        """Раз в сутки удаляет сообщения чата (и их медиа в S3) старше 30 дней."""
        while self.is_running:
            try:
                await self.chat_service.trim_old_messages(days=30)
            except Exception as e:
                logger.error(f"❌ Ошибка очистки старых сообщений чата: {e}")
            await asyncio.sleep(24 * 3600)

    async def _check_heartbeat_esp_loop(self):
        """Периодическая проверка статусов устройств + трекинг даунтайма."""
        logger.info("👁️ Начинаем мониторинг центральной платы и датчика двери.")

        while self.is_running:
            try:
                # Центральная плата
                old_status = self.device_status
                new_status = self._update_device_status()

                if new_status == DeviceStatus.DEAD and self.current_telemetry:
                    seconds_ago = (_get_izhevsk_time() - self.current_telemetry.timestamp).total_seconds()
                    logger.error(f"🚨 Центральная плата МЕРТВА {int(seconds_ago / 60)} минут!")
                elif new_status == DeviceStatus.ONLINE and old_status != DeviceStatus.ONLINE:
                    logger.info("✅ Центральная плата ОНЛАЙН")

                if old_status == DeviceStatus.ONLINE and new_status in (DeviceStatus.OFFLINE, DeviceStatus.DEAD):
                    await self.cache.record_downtime_start(self.device_id)
                elif old_status in (DeviceStatus.OFFLINE, DeviceStatus.DEAD) and new_status == DeviceStatus.ONLINE:
                    await self.cache.record_downtime_end(self.device_id)

                # Датчик двери
                old_status = self.sensor_status
                new_status = self._update_sensor_status()

                if new_status == DeviceStatus.DEAD and self.last_activity_timestamp_sensor:
                    seconds_ago = (_get_izhevsk_time() - self.last_activity_timestamp_sensor).total_seconds()
                    logger.error(f"🚨 Датчик двери МЕРТВ {int(seconds_ago / 60)} минут!")
                elif new_status == DeviceStatus.ONLINE and old_status != DeviceStatus.ONLINE:
                    logger.info("✅ Датчик двери ОНЛАЙН")

                if old_status == DeviceStatus.ONLINE and new_status in (DeviceStatus.OFFLINE, DeviceStatus.DEAD):
                    await self.cache.record_downtime_start(self.sensor_id)
                elif old_status in (DeviceStatus.OFFLINE, DeviceStatus.DEAD) and new_status == DeviceStatus.ONLINE:
                    await self.cache.record_downtime_end(self.sensor_id)

                # Туалет
                old_status = self.toilet_status
                new_status = self._update_toilet_status()

                if new_status == DeviceStatus.DEAD and self.last_activity_timestamp_toilet:
                    seconds_ago = (_get_izhevsk_time() - self.last_activity_timestamp_toilet).total_seconds()
                    logger.error(f"🚨 Туалет МЕРТВ {int(seconds_ago / 60)} минут!")
                elif new_status == DeviceStatus.ONLINE and old_status != DeviceStatus.ONLINE:
                    logger.info("✅ Туалет ОНЛАЙН")

                if old_status == DeviceStatus.ONLINE and new_status in (DeviceStatus.OFFLINE, DeviceStatus.DEAD):
                    await self.cache.record_downtime_start(self.toilet_id)
                elif old_status in (DeviceStatus.OFFLINE, DeviceStatus.DEAD) and new_status == DeviceStatus.ONLINE:
                    await self.cache.record_downtime_end(self.toilet_id)

            except Exception as e:
                logger.exception(f"❌ Ошибка в проверке heartbeat: {e}")

            await asyncio.sleep(self.heartbeat_interval)

    async def _update_weather_loop(self):
        """Цикл обновления погодных данных"""
        while self.is_running:
            try:
                # Проверяем, нужно ли обновлять
                cached = await self.cache.get_cached_weather()
                api_calls = await self.cache.get_api_calls_today()
                
                update_needed = False  # По умолчанию не обновляем
                
                if not cached:
                    update_needed = True
                    logger.info("🔄 Нет кешированных данных, обновляем...")
                elif cached.expires_at < datetime.now():
                    update_needed = True
                    logger.info("🔄 Кеш устарел, обновляем...")
                elif api_calls >= 28:  # 30 - запас 2
                    logger.warning(f"⚠️ Лимит API почти исчерпан: {api_calls}/30, используем кеш")
                    # Не обновляем, используем старый кеш
                
                if update_needed:
                    logger.info("🔄 Получаем свежие данные погоды...")
                    # Получаем свежие данные
                    adapter = await asyncio.to_thread(
                        lambda: self.service.get_forecast(56.7945, 53.1797)
                    )
                    
                    if adapter:
                        # Конвертируем в модель для кэша

                        weather_data = WeatherData(
                            current_temp=adapter.current_temp,
                            current_feels_like=adapter.current_feels_like,
                            current_condition=adapter.current_condition,
                            humidity=adapter.current_humidity,
                            wind_speed=adapter.current_wind,
                            morning_temp=adapter.morning_temp,
                            day_temp=adapter.day_temp,
                            evening_temp=adapter.evening_temp,
                            night_temp=adapter.night_temp,
                            timestamp=_get_izhevsk_time(),
                            expires_at=datetime.now() + timedelta(minutes=60),
                            api_calls_today=api_calls + 1
                        )
                        
                        # Сохраняем в кэш
                        await self.cache.save_weather(weather_data)
                        logger.info(f"✅ Данные обновлены: {adapter.current_temp}°C")

                # ВСЕГДА отправляем погоду на плату (даже из кеша)
                await self.send_to_board_weather_from_cache()

                cached = await self.cache.get_cached_weather()
                if cached:
                    await self.storage.save_weather_reading(
                        temp=cached.current_temp,
                        hum=cached.humidity,
                        timestamp=_get_izhevsk_time()
                    )
            
            except Exception as e:
                logger.exception(f"❌ Ошибка в цикле обновления погоды: {e}")
            
            # Ждем перед следующим обновлением
            await asyncio.sleep(self.update_board_weather_interval)

    async def get_weather(self) -> Optional[WeatherData]:
        """Получить погоду"""
        try:

            weather = await self.cache.get_cached_weather()
        
            return weather            
            
        except Exception as e:
            logger.exception(f"❌ Ошибка получения погоды из кеша: {e}")
            return None
    
    async def send_to_board_weather_from_cache(self):
        """Отправка данных на аппаратную плату"""
        try:

            if not self.can_send_to_device(self.device_status):
                logger.warning(f"⚠️ Пропускаем отправку погоды: устройство {self.device_status.value}")
                return

            weather = await self.cache.get_cached_weather()

            if weather:
                # Формируем данные для платы

                board_data = BoardData(
                    temp=weather.current_temp,
                    feels_like=weather.current_feels_like,
                    condition=weather.current_condition,
                    humidity=weather.humidity,
                    wind_speed=weather.wind_speed,
                    morning_temp=weather.morning_temp or weather.current_temp,
                    day_temp=weather.day_temp or weather.current_temp,
                    evening_temp=weather.evening_temp or weather.current_temp,
                    night_temp=weather.night_temp or weather.current_temp,
                    update_at=self._format_time_short(weather.timestamp)
                )
                
                # Отправляем на плату 
                await self.mqtt_service.send_weather_to_device(
                    device_id=self.device_id,
                    weather_data=board_data
                )
        except Exception as e:
            logger.exception(f"❌ Ошибка отправки на плату: {e}")

    async def send_to_board_settings(self, settings: SettingsData):
        """Отправка настроек на аппаратную плату"""
        try:

            if not self.can_send_to_device(self.device_status):
                logger.warning(f"⚠️ Пропускаем отправку настроек: устройство {self.device_status.value}")
                return

            if settings:
                # Отправляем на плату 
                await self.mqtt_service.send_config(
                    device_id=self.device_id,
                    config=settings
                )
        except Exception as e:
            logger.exception(f"❌ Ошибка отправки на плату: {e}")

    async def get_current_general_status(self) -> Optional[GeneralResponse]:
        """Получить общий статус системы."""

        standard_telemetry = self.current_telemetry
        
        camera_status = await self.video_service.get_camera_state("cam1")

        # central_board_status может быть ONLINE, OFFLINE, DEAD, NEVER_CONNECTED
        # sensor_status может быть ONLINE, OFFLINE, DEAD, NEVER_CONNECTED
        # toilet_status может быть ONLINE, OFFLINE, DEAD, NEVER_CONNECTED
        # camera_status может быть NEVER_CONNECTED, OFFLINE, CONNECTED, STREAMING, RECORDING

        
        disk = shutil.disk_usage('/')
        disk_usage = DiskUsage(
            total_gb=round(disk.total / (1024 ** 3), 1),
            free_gb=round(disk.free / (1024 ** 3), 1),
            used_percent=round(disk.used / disk.total * 100, 1),
        )

        return GeneralResponse(
            telemetry=standard_telemetry,
            central_board_status=self.device_status.value if self.device_status else "offline",
            camera_status=camera_status.mode.value if camera_status else "offline",
            sensor_status=self.sensor_status.value if self.sensor_status else "offline",
            toilet_status=self.toilet_status.value if self.toilet_status else "offline",
            disk_usage=disk_usage,
        )
    
    async def get_current_config(self, timeout: float = 5.0) -> Optional[SettingsData]:
        """Получить текущие настройки (синхронный запрос-ответ)"""
        try:
            
            if not self.can_send_to_device(self.device_status):
                logger.warning(f"⚠️ Пропускаем получение настроек: устройство {self.device_status.value}")
                return None

            # Подписываемся на ответ ПЕРЕД отправкой запроса
            response_future = asyncio.Future()

            async def on_config_response(device_id: str, data: dict):
                # ПРОСТО ПРИНИМАЕМ ВСЁ ОТ НАШЕГО УСТРОЙСТВА
                if device_id == self.device_id:
                    # Записываем активность устройства
                    self._record_device_activity("config_response")
                    logger.info(f"✅ Получили настройки от {device_id}")
                    if not response_future.done():
                        response_future.set_result(data)
            
            self.mqtt_service.set_settings_callback(on_config_response)

            # Отправляем запрос
            await self.mqtt_service.send_settings_request_to_device(device_id=self.device_id)

             # Ждём ответа с таймаутом
            try:
                response = await asyncio.wait_for(response_future, timeout=timeout)
                try:
                    return SettingsData(**response)
                except Exception as e:
                    logger.warning(f"⚠️ Невалидные данные настроек от {self.device_id}: {e}")
                    return None
            except asyncio.TimeoutError:
                logger.warning(f"⏳ Таймаут ожидания настроек от {self.device_id}")
                return None

        except Exception as e:
            logger.exception(f"❌ Ошибка получения настроек: {e}")
            return None
        finally:
            # Убираем временный обработчик
            self.mqtt_service.remove_settings_callback()

    async def handle_door_event(self, device_id: str, data: dict):
        """Обработчик события открытия двери от платы"""
        # 🔧 ИГНОРИРУЕМ RETAINED MESSAGES ПРИ СТАРТЕ
        if not self._initialization_complete:
            logger.debug(f"🚪 [ВЫБРОШЕНО] Retained message от {device_id} (инициализация еще идет)")
            return
        
        self.last_activity_timestamp_sensor = _get_izhevsk_time()
            
        # Нужно включить камеру и начать запись.
        # Дверь открылась → запись уже идет (10 сек таймер молчания)
        await self.video_service.start_recording(camera_id="cam1")
        logger.info(f"🚪 Плата {device_id} сообщила об открытии двери")

    async def handle_sensor_healthcheck(self, sensor_id: str, data: dict):
        """Проверка датчика двери, что он в порядке."""
        old = self.sensor_status
        self.last_activity_timestamp_sensor = _get_izhevsk_time()
        self.sensor_status = self._update_sensor_status()
        if old in (DeviceStatus.OFFLINE, DeviceStatus.DEAD) and self.sensor_status == DeviceStatus.ONLINE:
            asyncio.create_task(self.cache.record_downtime_end(self.sensor_id))

    async def handle_toilet_telemetry(self, device_id: str, data: dict):
        """Обработчик телеметрии туалетной платы (heartbeat раз в минуту)."""
        self._record_toilet_activity("telemetry")
        logger.debug(f"🚽 Телеметрия туалета: light={data.get('lightOn')} fan={data.get('fanOn')} silent={data.get('silentMode')}")

    async def handle_toilet_silence_ended(self, device_id: str, data: dict):
        """Туалет сообщил об окончании режима тишины. Центральная плата сама сбрасывает у себя — мы только логируем."""
        self._record_toilet_activity("silence_ended")
        logger.info("🚽 Режим тишины в туалете завершён (центральная плата уведомлена напрямую)")

    async def handle_telemetry(self, device_id: str, data: dict):
        """Обработчик телеметрии от платы"""
        try:
            # Записываем активность устройства
            self._record_device_activity("telemetry")
            
            # Парсим и валидируем данные
            telemetry = TelemetryData(
                device_id=device_id,
                temperature=data.get('temperature'),
                humidity=data.get('humidity'),
                free_memory=data.get('free_memory'),
                uptime=data.get('uptime'),
                timestamp=_get_izhevsk_time()
            )
            
            # Сохраняем в кэш
            self.current_telemetry = telemetry

            self.counter_for_telemetry += 1

            if self.counter_for_telemetry >= 5:
                self.counter_for_telemetry = 0
                # Отправляем в базу данных
                await self.storage.save_esp_reading(
                    temp=telemetry.temperature,
                    hum=telemetry.humidity,
                    timestamp=_get_izhevsk_time(),
                    device_id=self.device_id
                )
            
        except ValueError as e:
            logger.exception(f"❌ Ошибка валидации телеметрии от {device_id}: {e}")
        except Exception as e:
            logger.exception(f"❌ Неожиданная ошибка при обработке телеметрии: {e}")
    
    async def handle_weather_request(self, device_id: str, data: dict):
        """Обработчик запроса погоды от платы"""
        # Записываем активность устройства
        self._record_device_activity("weather_request")
        logger.info(f"🌤️ Плата {device_id} запросила погоду")
        
        await self.send_to_board_weather_from_cache()
    
    def _format_time_short(self, dt: datetime) -> str:
        """Форматируем время как '14:38'"""
        return dt.strftime('%H:%M')

    async def stop(self):
        """Остановка воркера"""
        self.is_running = False
        await self.mqtt_service.disconnect()
        logger.warning("🛑 Остановка фонового воркера")