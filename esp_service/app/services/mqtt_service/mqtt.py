# services/mqtt_service/mqtt.py
import asyncio
import json
from typing import Dict, Optional, Callable, Any
from pydantic import ValidationError
from app.schemas.telemetry import TelemetryData
from app.schemas.settings import SettingsData
from aiomqtt import Client, Message
from app.schemas.weather_data import BoardData
from datetime import datetime
from logger import logger
from app.schemas.settings import SettingsData
from config import MQTT_USERNAME, MQTT_PASSWORD
from aiomqtt import Client, Message, MqttError

class MQTTService:
    """
    Сервис для работы с MQTT брокером
    """
    
    def __init__(
        self,
        broker_host: str = "mqtt-broker",
        broker_port: Any = 1883,
        client_id: str = "esp-service"
    ):
        self.broker_host = broker_host
        self.broker_port = int(broker_port) if isinstance(broker_port, str) else broker_port
        self.client_id = client_id
        self.client: Optional[Client] = None
        self.is_connected = False
        self._listening_task: Optional[asyncio.Task] = None
        self.device_id = "greenhouse_01"

        # Топики
        self.topics = {
            # От платы к бекенду
            "telemetry": f"{self.device_id}/telemetry", # heartbeat + датчики
            "config_update": f"{self.device_id}/config/update", # плата изменила настройки
            "weather_request": f"{self.device_id}/weather/request", # запрос погоды
            "time_ready": f"{self.device_id}/time/ready", # плата пингует что время установлено

            # от бекенда к плате
            "weather_send": f"{self.device_id}/weather",  # погода
            "config_get": f"{self.device_id}/config/get",
            "config_set": f"{self.device_id}/config/set", # установить настройки
            "time_set": f"{self.device_id}/time/set", # установить время
        }
        
        # Callback-функции
        self.callbacks = {
            "time_ready": None,
            "telemetry": None,
            "config_update": None,
            "weather_request": None
        }

        # Тайминги последних сообщений
        self.last_heartbeats: Dict[str, datetime] = {}
    
    async def connect(self):
        """Подключение к MQTT брокеру"""
        try:
            logger.info(f"🔌 Подключаемся к MQTT: {self.broker_host}:{self.broker_port}")
            
            if not isinstance(self.broker_port, int):
                raise ValueError(f"Port должен быть int, получен {type(self.broker_port)}")
            
            self.client = Client(
                hostname=self.broker_host,
                port=self.broker_port,
                username=MQTT_USERNAME,
                password=MQTT_PASSWORD,
                identifier=self.client_id,
                clean_session=True,
                keepalive=60
            )
            
            await self.client.__aenter__()
            self.is_connected = True
            
            # Подписываемся на топики сразу при подключении
            await self._setup_subscriptions()
            
            logger.info("✅ MQTT подключен")
            return True
            
        except Exception as e:
            logger.error(f"❌ Ошибка подключения MQTT: {e}")
            self.is_connected = False
            return False
    
    async def _setup_subscriptions(self):
        """Настраиваем подписки на топики"""
        if not self.client:
            return
        
        topics_to_subscribe = [
            (f"{self.device_id}/telemetry", 1),  # телеметрия от всех устройств
            (f"{self.device_id}/weather/request", 1),  # запросы погоды от всех устройств
            (f"{self.device_id}/config/update", 1), # запрос текущих настроек а это ответ платы
            (f"{self.device_id}/time/ready", 1)
        ]
        
        for topic, qos in topics_to_subscribe:
            await self.client.subscribe(topic, qos=qos)
            logger.debug(f"📡 Подписались на топик: {topic} (qos={qos})")


    async def _handle_message(self, message: Message):
        """Обработка входящих сообщений"""
        try:
            payload_str = message.payload.decode()
            payload = json.loads(payload_str)
            topic = str(message.topic)
            
            logger.debug(f"📨 Received message: {topic} -> payload")
            
            # Извлекаем device_id из топика
            # Формат: esp/telemetry, esp/config/update и т.д.
            parts = topic.split("/")
            if len(parts) < 2:
                logger.warning(f"⚠️ Неверный формат топика: {topic}")
                return
                
            device_id = parts[0]  # "esp"
            topic_type = "/".join(parts[1:])  # "telemetry", "config/update" и т.д.
            
            # Валидация и нормализация полезной нагрузки перед передачей в колбэки
            if topic_type == "telemetry" and self.callbacks["telemetry"]:
                try:
                    # Дополняем обязательные поля и валидируем
                    telemetry = TelemetryData(**{**payload, "device_id": device_id, "timestamp": datetime.now()})
                    await self.callbacks["telemetry"](device_id, telemetry.model_dump())
                except ValidationError as ve:
                    logger.warning(f"⚠️ Невалидная телеметрия от {device_id}: {ve}")
                return

            if topic_type == "config/update" and self.callbacks["config_update"]:
                try:
                    settings = SettingsData(**payload)
                    await self.callbacks["config_update"](device_id, settings.model_dump())
                except ValidationError as ve:
                    logger.warning(f"⚠️ Невалидные настройки от {device_id}: {ve}")
                return

            if topic_type == "weather/request" and self.callbacks["weather_request"]:
                await self.callbacks["weather_request"](device_id, payload)
                return

            if topic_type == "time/ready" and self.callbacks["time_ready"]:
                await self.callbacks["time_ready"](device_id, payload)
                return

            logger.debug(f"📨 Необработанный топик: {topic_type}")
                    
        except json.JSONDecodeError:
            logger.warning(f"⚠️ Невалидный JSON: {message.payload}")
        except Exception as e:
            logger.error(f"❌ Ошибка обработки сообщения: {e}")


    # ========== МЕТОДЫ ДЛЯ ОТПРАВКИ НА ПЛАТУ ==========

    async def send_time_to_device(self, device_id: str, payload: dict):
        """Отправка времени на плату."""
        return await self._send_to_device("time_set", device_id, payload, "Отправлено время")

    async def send_settings_request_to_device(self, device_id: str):
        """Отправка запроса о текущих настройках на плату."""
        return await self._send_to_device("config_get", device_id, {}, "Отправлен запрос настроек")

    async def send_weather_to_device(self, device_id: str, weather_data: BoardData):
        """Отправка погоды на конкретную плату"""
        return await self._send_to_device("weather_send", device_id, weather_data.model_dump(), f"Отправили погоду: {weather_data.temp}°C")

    async def send_config(self, device_id: str, config: SettingsData):
        """Отправка конфигурации на плату"""
        return await self._send_to_device("config_set", device_id, config.model_dump(), "Отправлен конфиг")

    async def _send_to_device(self, topic_key: str, device_id: str, payload: dict, log_msg: str) -> bool:
        """Унифицированная отправка сообщения на устройство"""
        if not self.is_connected and not await self.connect():
            return False
        try:
            topic = self._format_topic(topic_key, device_id)
            logger.debug(f"MQTT topic: {topic}")
            await self.client.publish(
                topic=topic,
                payload=json.dumps(payload),
                qos=1
            )
            logger.info(f"📡 {log_msg} — device={device_id}")
            return True
        except Exception as e:
            logger.exception(f"❌ Ошибка отправки сообщения на {device_id}: {e}")
            return False

    def _format_topic(self, topic_key: str, device_id: str) -> str:
        """Форматирование топика с device_id"""
        topic_template = self.topics[topic_key]
        if "{device_id}" in topic_template:
            return topic_template.format(device_id=device_id)
        return topic_template
    
    # ========== CALLBACK УСТАНОВКА ==========

    def set_time_callback(self, callback: Callable):
        """Установить обработчик пинга о установке времени."""
        self.callbacks["time_ready"] = callback
        logger.debug("✅ Установлен обработчик времени.")

    def remove_time_callback(self):
        """Удалить обработчик времени.."""
        self.callbacks["time_ready"] = None
        logger.debug("✅ Удален обработчик времени")

    def set_settings_callback(self, callback: Callable):
        """Установить обработчик настроек от платы."""
        self.callbacks["config_update"] = callback
        logger.debug("✅ Установлен обработчик настроек")

    def remove_settings_callback(self):
        """Удалить обработчик настроек от платы."""
        self.callbacks["config_update"] = None
        logger.debug("✅ Удален обработчик настроек")
    
    def set_telemetry_callback(self, callback: Callable):
        """Установить обработчик телеметрии"""
        self.callbacks["telemetry"] = callback
        logger.debug("✅ Установлен обработчик телеметрии")
    
    def set_weather_request_callback(self, callback: Callable):
        """Установить обработчик запроса погоды"""
        self.callbacks["weather_request"] = callback
        logger.debug("✅ Установлен обработчик запроса погоды")

    # ========== УПРАВЛЕНИЕ ЖИЗНЕННЫМ ЦИКЛОМ ==========

    async def start(self):
        """Запуск MQTT сервиса"""
        try:
            if not await self.connect():
                logger.error("❌ Не удалось подключиться к MQTT брокеру")
                return False
            
            # Запускаем прослушивание в фоне
            self._listening_task = asyncio.create_task(self.start_listening())
            logger.debug("MQTT listening task started")
            return True
            
        except Exception as e:
            logger.exception(f"❌ Ошибка запуска MQTT сервиса: {e}")
            return False
        
    async def start_listening(self):
        """Запуск прослушивания сообщений"""
        if not self.client:
            logger.error("❌ MQTT клиент не инициализирован")
            return
        
        logger.info("👂 Начинаем слушать сообщения от плат...")
        
        try:
            async for message in self.client.messages:
                await self._handle_message(message)
                
        except asyncio.CancelledError:
            logger.info("📭 Прослушивание MQTT остановлено")
            
        except MqttError as e:
            logger.exception(f"❌ Ошибка MQTT соединения: {e}")
            self.is_connected = False
            
            # Попытка переподключения через 5 секунд
            await asyncio.sleep(5)
            logger.info("🔄 Попытка переподключения...")
            await self.start()
            
        except Exception as e:
            logger.exception(f"❌ Неожиданная ошибка в listen loop: {e}", exc_info=True)

    async def disconnect(self):
        """Корректное отключение от MQTT брокера"""
        logger.info("🔌 Отключаем MQTT сервис...")
        
        # Останавливаем задачу прослушивания
        if self._listening_task and not self._listening_task.done():
            self._listening_task.cancel()
            try:
                await self._listening_task
            except asyncio.CancelledError:
                pass
            except Exception as e:
                logger.warning(f"⚠️ Ошибка при отмене задачи прослушивания: {e}")
        
        # Отключаем клиента
        if self.client and self.is_connected:
            try:
                await self.client.__aexit__(None, None, None)
                self.is_connected = False
                logger.info("✅ MQTT отключен корректно")
            except Exception as e:
                logger.exception(f"❌ Ошибка отключения MQTT клиента: {e}")
        
        # Очищаем ссылки
        self._listening_task = None
        self.client = None