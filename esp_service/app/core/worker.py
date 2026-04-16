from typing import Dict, List, Optional
from fastapi import Request, HTTPException, WebSocket
from starlette.status import HTTP_401_UNAUTHORIZED, HTTP_403_FORBIDDEN
from app.services.redis.cache_manager import CacheManager
from app.services.weather_service.yandex_weather import WeatherService
import asyncio
from datetime import datetime, timedelta
from logger import logger
from app.services.mqtt_service.mqtt import MQTTService, BoardData
from app.services.s3_service.s3_manager import S3Manager
from app.schemas.telemetry import TelemetryData
from app.schemas.weather_data import WeatherData
from app.schemas.settings import SettingsData
from app.schemas.device_status import DeviceStatus
from app.services.video_service.video_service import VideoService
from app.services.monitor_db.telemetry_storage import TelemetryStorage
from app.services.ai_api.deepseek_client import ai_message_request
from app.utils.time import _get_izhevsk_time
from app.core.auth import init_auth_manager, get_auth_manager

# Константы и тайминги по умолчанию
DEFAULT_WEATHER_UPDATE_INTERVAL = 1800  # 30 минут (в секундах)
DEFAULT_TIME_UPDATE_INTERVAL = 43200  # 12 часов
DEFAULT_HEARTBEAT_INTERVAL = 60
DEFAULT_DEVICE_ID = "greenhouse_01"
DEFAULT_SENSOR_ID = "sensor_door_pir"

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
            storage: TelemetryStorage
            ):
        if BackgroundWorker._instance is not None:
            raise RuntimeError("Используйте BackgroundWorker.get_instance()")
        
        self.cache = cache_manager
        self.mqtt_service = mqtt_service
        self.service = weather_service
        self.storage = storage
        self.video_service = video_service
        self.is_running = False
        self.update_board_weather_interval = DEFAULT_WEATHER_UPDATE_INTERVAL 
        self.update_time_interval = DEFAULT_TIME_UPDATE_INTERVAL
        self.heartbeat_interval = DEFAULT_HEARTBEAT_INTERVAL
        self.device_id = DEFAULT_DEVICE_ID
        self.sensor_id = DEFAULT_SENSOR_ID
        self.current_telemetry: Optional[TelemetryData] = None
        self.last_activity_timestamp: Optional[datetime] = None  # Любое сообщение от платы
        self.device_status: DeviceStatus = DeviceStatus.NEVER_CONNECTED
        self.last_activity_timestamp_sensor: Optional[datetime] = None  # Любое сообщение от дверного датчика
        self.sensor_status: DeviceStatus = DeviceStatus.NEVER_CONNECTED
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
    ) -> 'BackgroundWorker':
        """Получить единственный экземпляр воркера"""
        if cls._instance is None:
            if cache_manager is None or weather_service is None or mqtt_service is None or storage is None or video_service is None:
                raise ValueError("При первом создании нужно передать все зависимости")
            
            cls._instance = cls(cache_manager, weather_service, video_service, mqtt_service, storage)
        return cls._instance
    
    @classmethod
    async def get_instance_async(
        cls,
        cache_manager: CacheManager = None,
        weather_service: WeatherService = None,
        video_service: VideoService = None,
        mqtt_service: MQTTService = None,
        storage: TelemetryStorage = None
    ) -> 'BackgroundWorker':
        """Асинхронная версия получения инстанса (с блокировкой)"""
        async with cls._lock:
            return cls.get_instance(cache_manager, weather_service, video_service, mqtt_service, storage)
    
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
        logger.info("Установлены обработчики сообщений от платы.")
        
        # 🔧 РАЗРЕШАЕМ ОБРАБОТКУ РЕАЛЬНЫХ СООБЩЕНИЙ (не retained)
        self._initialization_complete = True
        logger.info("✅ Инициализация завершена, обработка реальных событий включена")
        
        # Запускаем три задачи параллельно
        await asyncio.gather(
            # Запускаем цикл обновления данных погоды.
            self._update_weather_loop(),
            # Запускаем цикл слежения за состоянием плат.
            self._check_heartbeat_esp_loop(),
            # Запускаем цикл синхронизации времени.
            self._check_time_update_loop()
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
            else:  # > 5 минут
                new_status = DeviceStatus.DEAD
        
        # Логируем изменение статуса
        if new_status != self.sensor_status:
            logger.info(f"📱 Статус устройства изменился: {self.sensor_status.value} → {new_status.value}")
            self.sensor_status = new_status
        
        return self.sensor_status

    async def _check_time_update_loop(self, timeout: float = 30.0):
        """
        Цикл синхронизации времени. Проверяет раз в сутки.
        """
        await asyncio.sleep(30)
        while self.is_running:
            try:
                logger.info(f"⏰ Проверка синхронизации времени для {self.device_id}")

                if not self.can_send_to_device():
                    logger.warning(f"⚠️ Пропускаем синхронизацию времени: устройство {self.device_status.value}")
                    await asyncio.sleep(self.update_time_interval)
                    continue
                
                # 1. Проверяем, нужна ли синхронизация (прошло ли 7+ дней)
                need_sync = await self.cache.should_sync_time(device_id=self.device_id)
                
                if not need_sync:
                    logger.info(f"Устройство {self.device_id}: синхронизация не требуется")
                    await asyncio.sleep(self.update_time_interval)
                    continue
                
                logger.info(f"🕐 Устройство {self.device_id} требует синхронизации времени")
                
                # 2. Колбэк для обработки ответа от устройства
                response_future = asyncio.Future()
                
                async def on_time_sync_response(device_id: str, data: dict):
                    """Обработчик подтверждения синхронизации от ESP"""
                    
                    if device_id == self.device_id:
                        # Записываем активность устройства
                        self._record_device_activity("time_sync_response")
                        logger.info(f"✅ Устройство {device_id} подтвердило синхронизацию")
                        
                        # Помечаем синхронизацию как завершенную
                        await self.cache.mark_sync_completed(device_id)
                        
                        # Завершаем Future
                        if not response_future.done():
                            response_future.set_result(True)
                
                # Регистрируем колбэк
                self.mqtt_service.set_time_callback(on_time_sync_response)
                
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
                
                logger.info(f"📤 Отправляю время для {self.device_id}: "
                        f"{now.hour:02d}:{now.minute:02d} "
                        f"{now.day:02d}.{now.month:02d}.{now.year}")
                
                # 5. Отправляем время устройству
                await self.mqtt_service.send_time_to_device(
                    device_id=self.device_id,
                    payload=time_data
                )
                
                # 6. Ждём ответа 30 секунд
                try:
                    await asyncio.wait_for(response_future, timeout=timeout)
                    logger.info(f"✅ Синхронизация времени для {self.device_id} завершена")
                    
                except asyncio.TimeoutError:
                    logger.warning(f"⏳ Устройство {self.device_id} не подтвердило синхронизацию "
                                f"(ждал {timeout} секунд)")
                    # Ничего не делаем, попробуем через сутки
                
                # 7. Очищаем колбэк
                self.mqtt_service.remove_time_callback()
                
            except asyncio.CancelledError:
                logger.info(f"🚫 Цикл синхронизации для {self.device_id} отменен")
                break
                
            except Exception as e:
                logger.exception(f"❌ Ошибка в цикле синхронизации: {e}")
                # При ошибке ждем стандартный интервал
                
            # 8. Ждем сутки до следующей проверки
            logger.info(f"⏳ Жду {self.update_time_interval} сек до следующей проверки")
            await asyncio.sleep(self.update_time_interval)

    def can_send_to_device(self) -> bool:
        """Можно ли отправлять команды на устройство?"""
        return self.device_status == DeviceStatus.ONLINE

    def _record_device_activity(self, activity_name: str = ""):
        """Запиcать активность устройства (любое сообщение)"""
        self.last_activity_timestamp = _get_izhevsk_time()
        self.device_status = self._update_device_status()
        if activity_name:
            logger.debug(f"📍 Активность: {activity_name}. Статус устройства {self.device_status.value}")

    async def _check_heartbeat_esp_loop(self):
        """Периодическая проверка статусов устройств"""
        logger.info("👁️ Начинаем мониторинг центральной платы и датчика двери.")
        
        while self.is_running:
            try:
                # Проверим центральную плату
                old_status = self.device_status
                new_status = self._update_device_status()
                
                # Логируем критические состояния
                if new_status == DeviceStatus.DEAD and self.current_telemetry:
                    seconds_ago = (_get_izhevsk_time() - self.current_telemetry.timestamp).total_seconds()
                    minutes_ago = int(seconds_ago / 60)
                    logger.error(f"🚨 Центральная плата МЕРТВА {minutes_ago} минут!")
                elif new_status == DeviceStatus.ONLINE and old_status != DeviceStatus.ONLINE:
                    # Только что подключился
                    logger.info(f"✅ Центральная плата ОНЛАЙН")

                # Проверяем входной датчик
                old_status = self.sensor_status
                new_status = self._update_sensor_status()

                # Логируем критические состояния
                if new_status == DeviceStatus.DEAD:
                    seconds_ago = (_get_izhevsk_time() - self.last_activity_timestamp_sensor).total_seconds()
                    minutes_ago = int(seconds_ago / 60)
                    logger.error(f"🚨 Датчик двери МЕРТВ {minutes_ago} минут!")
                elif new_status == DeviceStatus.ONLINE and old_status != DeviceStatus.ONLINE:
                    # Только что подключился
                    logger.info(f"✅ Датчик двери ОНЛАЙН")
                
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
                            evening_temp=adapter.evening_temp,
                            night_temp=adapter.night_temp,
                            morning_temp=adapter.tomorrow_temp,
                            day_temp=adapter.current_temp,
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

            if not self.can_send_to_device():
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
                    morning_temp=weather.morning_temp,
                    day_temp=weather.day_temp,
                    evening_temp=weather.evening_temp,
                    night_temp=weather.night_temp,
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

            if not self.can_send_to_device():
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

    def get_current_telemetry(self) -> Optional[TelemetryData]:
        """Получить текущую телеметрию."""
        return self.current_telemetry
    
    async def get_current_config(self, timeout: float = 5.0) -> Optional[SettingsData]:
        """Получить текущие настройки (синхронный запрос-ответ)"""
        try:
            
            if not self.can_send_to_device():
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

    async def get_daily_report(self) -> Optional[str]:
        """
        Получить ИИ анализ данных телеметрии за последние сутки.
        Берем прошлый день 00:00-23:59 относительно текущей даты.
        Выполняем запрос на анализ с оптимальным кол-вом точек.
        """
        now = _get_izhevsk_time()
        yesterday = (now - timedelta(days=1)).strftime("%Y-%m-%d")

        # Проверим кеш
        cached = await self.cache.get_cached_daily_report(yesterday)
        if cached:
            return cached
        
        # Получаем статистику за вчера
        daily_stats = await self.storage.get_yesterday_stats(
            now=now,
            device_id=self.device_id
        )
        
        if not daily_stats:
            logger.warning("⚠️ Нет статистики за вчерашний день")
            return None
        
        # Получаем записи (агрегированные до 50 точек)
        daily_records = await self.storage.get_yesterday_records(
            now=now,
            device_id=self.device_id,
            max_points=50
        )
        
        # Форматируем записи для промпта
        records_text = self._format_records_for_prompt(daily_records)
        
        # Безопасные значения (на случай None)
        temp_in_avg = daily_stats['temperature']['inside']['avg'] or '—'
        temp_in_min = daily_stats['temperature']['inside']['min'] or '—'
        temp_in_max = daily_stats['temperature']['inside']['max'] or '—'
        
        hum_in_avg = daily_stats['humidity']['inside']['avg'] or '—'
        hum_in_min = daily_stats['humidity']['inside']['min'] or '—'
        hum_in_max = daily_stats['humidity']['inside']['max'] or '—'
        
        temp_out_avg = daily_stats['temperature']['outside']['avg'] or '—'
        temp_out_min = daily_stats['temperature']['outside']['min'] or '—'
        temp_out_max = daily_stats['temperature']['outside']['max'] or '—'
        
        hum_out_avg = daily_stats['humidity']['outside']['avg'] or '—'
        hum_out_min = daily_stats['humidity']['outside']['min'] or '—'
        hum_out_max = daily_stats['humidity']['outside']['max'] or '—'
        
        total_records = daily_stats['records']['total']
        esp_records = daily_stats['records']['esp']
        weather_records = daily_stats['records']['weather']
        
        # Формируем понятный промпт для ИИ
        prompt = f"""Вы — аналитическая система "Домовой", предназначенная для генерации отчетов о состоянии умного дома. Напишите структурированный отчет о показателях за вчерашний день ({daily_stats['date']}).

КОНТЕКСТ:
- Колебания влажности внутри помещений коррелируют с активностью жильцов (утренний подъем, возвращение с работы) или бытовыми процессами (уборка, приготовление пищи)
- Отчет должен содержать фактические данные и их краткую интерпретацию

📊 **СТАТИСТИКА ЗА ОТЧЕТНЫЙ ПЕРИОД:**

Внутренние показатели:
├─ Температура: средняя {temp_in_avg:.1f}°C (минимум {temp_in_min}°C, максимум {temp_in_max}°C)
└─ Влажность: средняя {hum_in_avg:.1f}% (минимум {hum_in_min}%, максимум {hum_in_max}%)

Внешние показатели:
├─ Температура: средняя {temp_out_avg:.1f}°C (минимум {temp_out_min}°C, максимум {temp_out_max}°C)
└─ Влажность: средняя {hum_out_avg:.1f}% (минимум {hum_out_min}%, максимум {hum_out_max}%)

🔍 **ДИНАМИКА ПОКАЗАТЕЛЕЙ:**
{records_text}

Всего измерений за период: {total_records} (внутренние датчики: {esp_records}, метеоданные: {weather_records})

📋 **ТРЕБОВАНИЯ К ОТЧЕТУ:**

1. Объем: 5-7 предложений
2. Стиль: информационно-аналитический, дружелюбный тон, без излишней фамильярности
3. Структура:
   - Общая характеристика дня на основе статистики
   - Анализ температурного режима (комфортность, соответствие внешним условиям)
   - Анализ влажности (стабильность, связь с активностью, рекомендации)
   - Заключение с практическими рекомендациями

4. Методические указания:
   - При значительных колебаниях влажности указать временные периоды активности
   - При стабильных показателях отметить эффективность климат-контроля
   - При отклонениях от нормы дать рекомендации по проветриванию или увлажнению
   - Форматирование: только текст, без маркдаун-разметки
   - Исключить упоминания конкретных моделей оборудования

ПРИМЕРЫ ОТЧЕТОВ:
"За отчетный период зафиксирована стабильная температура 23°C, что соответствует комфортным значениям. Влажность варьировалась от 45% до 55%, с пиковыми значениями в утренние (8:00-9:00) и вечерние (19:00-21:00) часы, что совпадает с периодом активности жильцов. Наружная температура была на 5°C ниже внутренней. Рекомендуется обратить внимание на влажность в ночные часы — показатель приближался к нижней границе нормы."

"Вчерашний день характеризовался повышенной влажностью внутри помещения (пиковые значения до 65% в дневные часы), что вероятно связано с бытовыми процессами. Температура держалась в диапазоне 22-24°C, что является оптимальным. Уличные показатели были в пределах сезонной нормы. Для поддержания комфортного микроклимата рекомендуется периодическое проветривание."

СФОРМИРУЙТЕ ОТЧЕТ В СООТВЕТСТВИИ С УКАЗАННЫМИ ТРЕБОВАНИЯМИ:"""
        
        logger.info(f"🤖 Отправляю запрос в ИИ за {daily_stats['date']}")
        
        result = await ai_message_request(user_message="Нужен отчет.", system_message=prompt)
        
        if result:
            logger.info(f"✅ Получен отчёт за {daily_stats['date']}")
            # Сохраним в кеш.
            await self.cache.cache_daily_report(result, yesterday, now)
            return result
        else:
            logger.error("❌ Не удалось получить ответ от ИИ")
            return None

    def _format_records_for_prompt(self, records: List[Dict]) -> str:
        """Форматирует записи для вставки в промпт (чтобы не было огромно)"""
        if not records:
            return "Нет данных"
        
        # Берём каждый 5-й элемент для компактности
        step = max(1, len(records) // 10)
        sampled = records[::step][:10]  # максимум 10 точек
        
        lines = []
        for r in sampled:
            time = r.get('time', '')
            temp_in = r.get('temp_in', '—')
            hum_in = r.get('hum_in', '—')
            temp_out = r.get('temp_out', '—')
            hum_out = r.get('hum_out', '—')
            
            line = f"{time}: внутри {temp_in}°C/{hum_in}%, снаружи {temp_out}°C/{hum_out}%"
            lines.append(line)
        
        return "\n".join(lines)

    async def get_weekly_report(self) -> Optional[str]:
        """
        Получить ИИ анализ данных телеметрии за последние 7 дней.
        Берем неделю, заканчивающуюся вчера (00:00-23:59 каждого дня).
        """
        now = _get_izhevsk_time()
        last_day = (now - timedelta(days=1)).strftime("%Y-%m-%d")

        # Проверим кеш.
        cached = await self.cache.get_cached_weekly_report(last_day)
        if cached:
            return cached
        
        # Получаем статистику за неделю
        weekly_stats = await self.storage.get_week_stats(
            now=now,
            device_id=self.device_id
        )
        
        if not weekly_stats:
            logger.warning("⚠️ Нет статистики за последнюю неделю")
            return None
        
        # Получаем записи за неделю (агрегированные)
        weekly_records = await self.storage.get_week_records(
            now=now,
            device_id=self.device_id,
            max_points=100
        )
        
        # Форматируем записи для промпта
        records_text = self._format_weekly_records_for_prompt(weekly_records)
        
        # Безопасно обрабатываем trend
        trend = weekly_stats['summary'].get('trend')
        if trend is None:
            trend_text = "недостаточно данных для анализа тренда"
        else:
            direction = "выросла" if trend > 0 else "снизилась"
            trend_text = f"{direction} на {abs(trend)}°C"
        
        # Формируем промпт для ИИ
        prompt = f"""Вы — аналитическая система "Домовой", подготовьте отчет о микроклимате в доме за прошедшую неделю ({weekly_stats['period']['start']} - {weekly_stats['period']['end']}).

**АНАЛИТИЧЕСКАЯ СПРАВКА**

На основе собранных данных представляем статистику за отчетный период:

🏠 **ВНУТРЕННИЕ ПОКАЗАТЕЛИ:**
├─ Температурный режим: средняя {weekly_stats['summary']['temperature']['inside']['avg']}°C
│  (колебания от {weekly_stats['summary']['temperature']['inside']['min']} до {weekly_stats['summary']['temperature']['inside']['max']})
└─ Влажность воздуха: средняя {weekly_stats['summary']['humidity']['inside']['avg']}%
   (диапазон от {weekly_stats['summary']['humidity']['inside']['min']} до {weekly_stats['summary']['humidity']['inside']['max']})

🌤 **ВНЕШНИЕ УСЛОВИЯ:**
├─ Температура: средняя {weekly_stats['summary']['temperature']['outside']['avg']}°C
│  (минимум {weekly_stats['summary']['temperature']['outside']['min']}, максимум {weekly_stats['summary']['temperature']['outside']['max']})
└─ Влажность: средняя {weekly_stats['summary']['humidity']['outside']['avg']}%
   (от {weekly_stats['summary']['humidity']['outside']['min']} до {weekly_stats['summary']['humidity']['outside']['max']})

📈 **ДИНАМИКА:** {trend_text}

📅 **ПОСУТОЧНАЯ СТАТИСТИКА:**
{self._format_weekly_for_prompt(weekly_stats['daily'])}

🔍 **КЛЮЧЕВЫЕ СОБЫТИЯ ПЕРИОДА:**
{records_text}

Общее количество измерений: {weekly_stats['summary']['records']['total']} 
(внутренние датчики: {weekly_stats['summary']['records']['esp']}, метеосводки: {weekly_stats['summary']['records']['weather']})

📋 **СТРУКТУРА ОТЧЕТА:**

Требуется сформировать аналитическую заметку объемом 5-7 предложений, соблюдая следующую структуру:

1. **Вводная часть** — общая характеристика недели с акцентом на температурный режим
2. **Температурный анализ** — сопоставление внутренних и внешних показателей, оценка эффективности теплозащиты
3. **Анализ влажности** — выявление периодов активности, корреляция с бытовыми процессами
4. **Экстремумы периода** — выделение самого теплого/холодного дня с обоснованием
5. **Сравнительный анализ** — соотношение внутреннего и внешнего микроклимата
6. **Рекомендации** — практические советы на предстоящий период

**МЕТОДИЧЕСКИЕ УКАЗАНИЯ:**
- При интерпретации колебаний влажности указывать на связь с активностью жильцов
- Отмечать аномальные отклонения температуры от средних значений
- Использовать числовые показатели только для подтверждения выводов
- Исключить маркдаун-разметку, технические детали и упоминания оборудования
- Стиль изложения: информационно-аналитический, с элементами заботы о комфорте

**ПРИМЕРЫ:**

"За отчетную неделю средняя температура в доме составила 23°C при внешних показателях от -2 до +5°C, что свидетельствует о надежной теплозащите помещений. Влажность варьировалась в пределах 45-60%, с характерными пиками в вечерние часы, соответствующими периодам присутствия жильцов. Максимальная температура зафиксирована в среду (24.5°C) благодаря солнечному прогреву. Разница между внутренним и внешним микроклиматом достигала 15°C. На предстоящей неделе прогнозируется понижение температуры, рекомендуется усилить контроль за влажностью воздуха."

"Неделя характеризовалась стабильным температурным режимом 22-23°C при внешних колебаниях от -1 до +4°C. Отмечены кратковременные повышения влажности в выходные дни, вероятно связанные с уборкой. Минимальная температура зафиксирована во вторник (-1°C), что не повлияло на внутренний микроклимат. Система теплозащиты функционирует эффективно, однако к вечеру пятницы наблюдалось повышение уровня CO2 — рекомендуется более регулярное проветривание."

**СФОРМИРУЙТЕ ОТЧЕТ В СООТВЕТСТВИИ С УКАЗАННЫМИ ТРЕБОВАНИЯМИ:**
"""
        
        logger.info(f"🤖 Отправляю запрос в ИИ за неделю {weekly_stats['period']['start']} - {weekly_stats['period']['end']}")
        
        result = await ai_message_request(user_message="Нужен отчет.", system_message=prompt)
        
        if result:
            logger.info(f"✅ Получен отчёт за неделю")
            await self.cache.cache_weekly_report(result, last_day, now)
            return result
        else:
            logger.error("❌ Не удалось получить ответ от ИИ")
            return None

    def _format_weekly_for_prompt(self, daily_stats: List[Dict]) -> str:
        """Форматирует статистику по дням для промпта"""
        if not daily_stats:
            return "Нет данных"
        
        lines = []
        for day in daily_stats:
            date = day['date'][5:]  # MM-DD
            temp = day.get('temp_avg', '—')
            hum = day.get('hum_avg', '—')
            out_temp = day.get('outside_temp', '—')
            
            line = f"📅 {date}: внутри {temp}°C/{hum}%, снаружи {out_temp}°C"
            lines.append(line)
        
        return "\n".join(lines)

    def _format_weekly_records_for_prompt(self, weekly_records: Dict) -> str:
        """Форматирует записи за неделю для промпта (по 2-3 точки с каждого дня)"""
        if not weekly_records or 'days' not in weekly_records:
            return "Нет данных по дням"
        
        lines = []
        for day in weekly_records['days']:
            date = day['date'][5:]  # MM-DD
            records = day.get('records', [])
            
            if not records:
                continue
            
            # Берём утро, день, вечер (первые 3 точки)
            sampled = records[::max(1, len(records)//3)][:3]
            
            day_lines = [f"  {date}:"]
            for r in sampled:
                time = r.get('time', '')
                temp_in = r.get('temp_in', '—')
                hum_in = r.get('hum_in', '—')
                temp_out = r.get('temp_out', '—')
                hum_out = r.get('hum_out', '—')
                
                day_lines.append(f"    {time}: внутри {temp_in}°C/{hum_in}%, снаружи {temp_out}°C/{hum_out}%")
            
            lines.extend(day_lines)
            lines.append("")  # пустая строка между днями
        
        return "\n".join(lines)

    async def handle_door_event(self, device_id: str, data: dict):
        """Обработчик события открытия двери от платы"""
        # 🔧 ИГНОРИРУЕМ RETAINED MESSAGES ПРИ СТАРТЕ
        if not self._initialization_complete:
            logger.debug(f"🚪 [ВЫБРОШЕНО] Retained message от {device_id} (инициализация еще идет)")
            return
        
        self.last_activity_timestamp_sensor = _get_izhevsk_time()
            
        # Нужно включить камеру и начать запись.
        # Дверь открылась → запись уже идет (10 сек таймер молчания)
        await self.video_service.start_recording(camera_id="cam1", max_duration=10)
        logger.info(f"🚪 Плата {device_id} сообщила об открытии двери")

    async def handle_sensor_healthcheck(self, sensor_id: str, data: dict):
        """Проверка датчика, что он в порядке."""
        self.last_activity_timestamp_sensor = _get_izhevsk_time()

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