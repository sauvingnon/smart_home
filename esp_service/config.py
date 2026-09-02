import os
from dotenv import load_dotenv
from pathlib import Path

# Загружаем переменные окружения из .env файла
# load_dotenv()
env_path = Path(__file__).resolve().parent / ".env"
load_dotenv(dotenv_path=env_path)

# Теперь можешь обращаться к переменным окружения
YANDEX_WEATHER_API_KEY = os.getenv("YANDEX_WEATHER_API_KEY")
REDIS_URL = os.getenv("REDIS_URL")
MQTT_BROKER_HOST = os.getenv("MQTT_BROKER_HOST")
MQTT_BROKER_PORT = int(os.getenv("MQTT_BROKER_PORT"))
MQTT_USERNAME = os.getenv("MQTT_USERNAME")
MQTT_PASSWORD = os.getenv("MQTT_PASSWORD")
API_BASE_URL = os.getenv("API_BASE_URL")
CAMERA_ID = os.getenv("CAMERA_ID")
CAMERA_ACCESS_KEY = os.getenv("CAMERA_ACCESS_KEY")
DEFAULT_RECORDING_DAYS = int(os.getenv("DEFAULT_RECORDING_DAYS", "7"))
ENVIRONMENT = os.getenv("ENVIRONMENT", "production")  # "development" | "production"
COOKIE_SECURE = ENVIRONMENT != "development"

# Web Push (уведомления чата когда приложение полностью закрыто). Ключи
# генерируются один раз командой `vapid --gen` (пакет py-vapid, тянется
# вместе с pywebpush) и кладутся в esp_service/.env — так же, как остальные секреты.
VAPID_PUBLIC_KEY = os.getenv("VAPID_PUBLIC_KEY")
VAPID_PRIVATE_KEY = os.getenv("VAPID_PRIVATE_KEY")
VAPID_CONTACT_EMAIL = os.getenv("VAPID_CONTACT_EMAIL", "admin@example.com")

# Общий секрет для internal-эндпоинтов, которые дёргают другие контейнеры этого
# же docker-compose (recognition_worker) по внутренней сети — не публичный API,
# но сеть общая (esp_internal_network), поэтому не голое доверие по сетевой изоляции.
RECOGNITION_WORKER_SECRET = os.getenv("RECOGNITION_WORKER_SECRET")