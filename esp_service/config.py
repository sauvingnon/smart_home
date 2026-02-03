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