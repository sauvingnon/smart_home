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
BOT_SECRET = os.getenv("BOT_SECRET")
API_TOKEN_DEEPSEEK = os.getenv("API_TOKEN_DEEPSEEK")
BASE_URL_DEEPSEEK = os.getenv("BASE_URL_DEEPSEEK")
API_BASE_URL = os.getenv("API_BASE_URL")
CAMERA_ID = os.getenv("CAMERA_ID")
CAMERA_ACCESS_KEY = os.getenv("CAMERA_ACCESS_KEY")
DEFAULT_RECORDING_DAYS = int(os.getenv("DEFAULT_RECORDING_DAYS", "7"))