import logging
from logging.handlers import RotatingFileHandler
import os

# Папка для логов
LOG_DIR = "logs"
os.makedirs(LOG_DIR, exist_ok=True)

# Основной логгер
logger = logging.getLogger("esp_service")
logger.setLevel(logging.INFO)

# Файл с ротацией: max 5МБ на файл, хранить до 5 файлов
file_handler = RotatingFileHandler(
    filename=os.path.join(LOG_DIR, "esp_service.log"),
    maxBytes=5*1024*1024,
    backupCount=5,
    encoding="utf-8"
)
file_handler.setLevel(logging.INFO)

# Формат логов
formatter = logging.Formatter(
    "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
file_handler.setFormatter(formatter)

logger.addHandler(file_handler)

# Можно добавить вывод в консоль
console_handler = logging.StreamHandler()
console_handler.setFormatter(formatter)
logger.addHandler(console_handler)
