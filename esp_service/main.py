# main.py - упрощаем запуск MQTT
from fastapi import FastAPI
from logger import logger
import asyncio
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from app.services.redis.cache_manager import CacheManager
from app.services.weather_service.yandex_weather import WeatherService
from app.services.monitor_db.telemetry_storage import get_telemetry_storage
from app.services.s3_service.s3_manager import S3Manager
from app.services.video_service.video_service import VideoService
from app.services.mqtt_service.mqtt import MQTTService, BoardData
from app.core.worker import BackgroundWorker
from config import YANDEX_WEATHER_API_KEY, REDIS_URL, MQTT_BROKER_HOST, MQTT_BROKER_PORT
import os
from app.api.endpoints import telemetry, settings, weather, auth, statistic, ai_report, stream

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Запускаем всё при старте"""
    logger.info("✅ Сервис стартовал")
    
    tasks = []
    
    try:
        # 1. Redis
        cache_manager = CacheManager(REDIS_URL)
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

        # 4. База данных
        storage = get_telemetry_storage()

        # 5. S3 хранилище
        s3_manager = S3Manager(
            endpoint_url="http://garage:3900",
            access_key="GK39eb72624df14cf0b66afa79",
            secret_key="b607bde5e96a7f99175f9945441bd059d366e404655394e44f4bbc835b5accd7",
            bucket_name="video-bucket"
        )

        s3_started = await s3_manager.connect()
        if not s3_started:
            logger.warning("Не удалось запустить s3 хранилище, продолжаем без него.")
        else:
            logger.info("✅ S3 хранилище запущено.")
        app.state.s3_manager = s3_manager
        
        # Запускаем MQTT (подключение + прослушивание)
        mqtt_started = await mqtt_service.start()
        if not mqtt_started:
            logger.warning("⚠️ MQTT не удалось запустить, продолжаем без него")
        else:
            logger.info("✅ MQTT сервис запущен")
        app.state.mqtt_service = mqtt_service

        video_service = VideoService(s3_manager, cache_manager)
        
        # 4. Worker
        worker = BackgroundWorker.get_instance(
            cache_manager=cache_manager,
            weather_service=weather_service,
            video_service=video_service,
            mqtt_service=mqtt_service,
            storage=storage
        )

        app.state.worker = worker
        
        # 4. Инициализируем асинхронные сервисы ПЕРЕД запуском worker
        await worker.initialize_services()
        
        # 5. Запускаем воркер в фоне
        worker_task = asyncio.create_task(worker.start())
        tasks.append(worker_task)
        app.state.worker_task = worker_task
        logger.info("✅ Оркестратор стартовал.")
        
        logger.info("🚀 Все сервисы запущены")

        yield

    finally:
        # Остановка
        logger.info("🛑 Останавливаем сервис...")
        
        # 1. Останавливаем все задачи
        for task in tasks:
            if not task.done():
                task.cancel()
                try:
                    await asyncio.wait_for(task, timeout=5.0)
                except (asyncio.CancelledError, asyncio.TimeoutError):
                    logger.warning(f"Задача {task.get_name()} не завершилась корректно")
                except Exception as e:
                    logger.error(f"Ошибка при остановке задачи: {e}")
        
        # 2. Останавливаем сервисы в правильном порядке (обратном запуску)
        stop_errors = []
        
        try:
            if hasattr(app.state, 'worker'):
                await app.state.worker.stop()
        except Exception as e:
            stop_errors.append(f"worker: {e}")
        
        try:
            if hasattr(app.state, 'mqtt_service'):
                await app.state.mqtt_service.disconnect()
        except Exception as e:
            stop_errors.append(f"mqtt_service: {e}")
        
        try:
            if hasattr(app.state, 'cache_manager'):
                await app.state.cache_manager.disconnect()
        except Exception as e:
            stop_errors.append(f"cache_manager: {e}")
        
        try:
            if hasattr(app.state, 's3_manager'):
                await app.state.s3_manager.disconnect()
        except Exception as e:
            stop_errors.append(f"s3_manager: {e}")
        
        if stop_errors:
            logger.error(f"Ошибки при остановке: {stop_errors}")
        else:
            logger.info("✅ Сервис остановлен корректно")


app = FastAPI(lifespan=lifespan, title="ESP Ядро", root_path="/api")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://tgapp.dotnetdon.ru",
    ],
    # allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
async def health():
    return {"status": "ok"}

app.include_router(telemetry.router)
app.include_router(settings.router)
app.include_router(weather.router)
app.include_router(auth.router)
app.include_router(statistic.router)
app.include_router(ai_report.router)
app.include_router(stream.router)