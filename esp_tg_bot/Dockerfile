FROM python:3.11-slim

# Обновляем пакеты
RUN apt-get update

# Устанавливаем рабочую директорию
WORKDIR /app

# Копируем файл зависимостей
COPY requirements.txt /app/

# Устанавливаем зависимости
RUN pip install -r requirements.txt

# Копируем остальные файлы
COPY . /app/

# Команда запуска
CMD ["python", "main.py"]

ENV PYDEVD_DISABLE_FILE_VALIDATION=1