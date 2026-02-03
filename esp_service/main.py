# main.py - упрощаем запуск MQTT
from fastapi import FastAPI
from logger import logger
import asyncio
from contextlib import asynccontextmanager
from app.services.redis.cache_manager import WeatherCacheManager
from app.services.weather_service.yandex_weather import WeatherService
from app.services.mqtt_service.mqtt import MQTTService, BoardData
from app.core.worker import WeatherBackgroundWorker
from config import YANDEX_WEATHER_API_KEY, REDIS_URL, MQTT_BROKER_HOST, MQTT_BROKER_PORT
import os
from app.api.endpoints import telemetry, settings

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Запускаем всё при старте"""
    logger.info("✅ Сервис стартовал")
    
    tasks = []
    
    try:
        # 1. Redis
        cache_manager = WeatherCacheManager(REDIS_URL)
        await cache_manager.connect()
        app.state.cache_manager = cache_manager
        logger.info("✅ Redis подключен")
        
        # 2. Weather Service
        weather_service = WeatherService(api_key=YANDEX_WEATHER_API_KEY)
        app.state.weather_service = weather_service
        logger.info("✅ Weather API инициализирован")
        
        # 3. MQTT - используем новый метод start()
        mqtt_service = MQTTService(
            broker_host=MQTT_BROKER_HOST,
            broker_port=int(MQTT_BROKER_PORT),
            client_id=f"esp-service-{os.getpid()}"
        )
        
        # Запускаем MQTT (подключение + прослушивание)
        mqtt_started = await mqtt_service.start()
        if not mqtt_started:
            logger.warning("⚠️ MQTT не удалось запустить, продолжаем без него")
        
        app.state.mqtt_service = mqtt_service
        logger.info("✅ MQTT сервис запущен")
        
        # 4. Worker
        worker = WeatherBackgroundWorker.get_instance(
            cache_manager=cache_manager,
            weather_service=weather_service,
            mqtt_service=mqtt_service
        )

        app.state.worker = worker
        
        # 5. Запускаем воркер в фоне
        worker_task = asyncio.create_task(worker.start())
        tasks.append(worker_task)
        app.state.worker_task = worker_task
        logger.info("✅ Оркестратор стартовал.")
        
        logger.info("🚀 Все сервисы запущены")
        
    except Exception as e:
        logger.error(f"❌ Ошибка запуска: {e}")
        raise
    
    yield
    
    # Остановка
    logger.info("🛑 Останавливаем сервис...")
    
    for task in tasks:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
    
    if hasattr(app.state, 'worker'):
        await app.state.worker.stop()
    
    if hasattr(app.state, 'mqtt_service'):
        await app.state.mqtt_service.disconnect()
    
    logger.info("✅ Сервис остановлен")

app = FastAPI(lifespan=lifespan, title="ESP Ядро")

app.include_router(telemetry.router)
app.include_router(settings.router)