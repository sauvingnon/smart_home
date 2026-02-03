FROM python:3.11-slim

# Устанавливаем рабочую директорию
WORKDIR /app

COPY requirements.txt .

# Устанавливаем зависимости
RUN pip install --no-cache-dir -r requirements.txt

# Копируем все файлы из локальной директории в контейнер
COPY . .

# Запуск FastAPI через uvicorn
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8005"]

ENV LOG_LEVEL=DEBUG
# ENV LOG_LEVEL=INFO