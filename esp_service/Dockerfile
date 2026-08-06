FROM python:3.11-slim

RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

# Устанавливаем рабочую директорию
WORKDIR /app

COPY requirements.txt .

# pypi.org недоступен из РФ с 01.06.2026 — ставим через зеркала.
# Два индекса на выбор (не проверено с самого VPS, только что оба технически
# рабочие и полные откуда я собирал) — pip сам возьмёт пакет с того, что ответит.
RUN pip install --no-cache-dir \
    -i https://pypi.tuna.tsinghua.edu.cn/simple/ \
    --extra-index-url https://mirror.yandex.ru/pypi/web/simple/ \
    -r requirements.txt

# Копируем все файлы из локальной директории в контейнер
COPY . .

# Запуск FastAPI через uvicorn
# Запуск FastAPI через uvicorn
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8005"]

# LOG_LEVEL контролируется через переменную окружения .env (по умолчанию INFO)
