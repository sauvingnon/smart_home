import os
from dotenv import load_dotenv

# Загружаем переменные окружения из .env файла
load_dotenv()

# Теперь можешь обращаться к переменным окружения
ESP_SERVICE_URL = os.getenv("ESP_SERVICE_URL")
BOT_TOKEN = os.getenv("BOT_TOKEN")

ALLOWED_USER_IDS = set(
    int(id.strip()) 
    for id in os.getenv("ALLOWED_USER_IDS", "").split(",") 
    if id.strip()
)