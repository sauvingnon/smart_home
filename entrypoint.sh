#!/bin/bash

# Настройка garage.

set -e

echo "Garage Setup Script"

# Загружаем переменные из .env если файл существует
if [ -f .env ]; then
    echo "Загружаем переменные из .env"
    export $(grep -v '^#' .env | xargs)
fi

# Проверяем обязательные переменные
if [[ -z "$S3_BUCKET_NAME" ]]; then
    echo "Ошибка: S3_BUCKET_NAME не задан"
    exit 1
fi

if [[ -z "$S3_ACCESS_KEY_ID" ]] || [[ -z "$S3_SECRET_ACCESS_KEY" ]]; then
    echo "Внимание: S3 ключи не заданы, пропускаем настройку ключей"
    SETUP_KEYS=false
else
    SETUP_KEYS=true
fi

echo "Bucket: $S3_BUCKET_NAME"
if [ "$SETUP_KEYS" = true ]; then
    echo "Access Key: $S3_ACCESS_KEY_ID"
fi

# Запускаем сервер
echo "Запускаем сервер Garage..."
garage server &
SERVER_PID=$!
sleep 5

# Проверяем что сервер запустился
if ! kill -0 $SERVER_PID 2>/dev/null; then
    echo "Ошибка: Сервер Garage не запустился"
    exit 1
fi
echo "Сервер Garage запущен (PID: $SERVER_PID)"

# Получаем ID ноды
echo "Получаем ID ноды..."
sleep 3
NODE_ID=$(garage node id 2>/dev/null | head -n1)
if [ -z "$NODE_ID" ]; then
    echo "Ошибка: Не удалось получить ID ноды"
    kill $SERVER_PID 2>/dev/null
    exit 1
fi
echo "ID ноды: $NODE_ID"

# Извлекаем только ID (без адреса)
NODE_ID_SHORT=$(echo "$NODE_ID" | cut -d'@' -f1)
echo "Короткий ID ноды: $NODE_ID_SHORT"

# Настраиваем layout
echo "Настраиваем layout..."
if garage layout assign -z dc1 -c 1G "$NODE_ID_SHORT" 2>/dev/null; then
    echo "Layout назначен"
else
    echo "Не удалось назначить layout (возможно уже назначен)"
fi

# Применяем layout
echo "Применяем layout..."
if garage layout apply --version 1 2>/dev/null; then
    echo "Layout применен"
else
    echo "Не удалось применить layout (возможно уже применен)"
fi

# Ждем готовности layout
echo "Ждем готовности layout..."
sleep 5

# Создаем bucket
echo "Создаем bucket: $S3_BUCKET_NAME"
if garage bucket create "$S3_BUCKET_NAME" 2>&1 | tee /tmp/bucket_create.log; then
    echo "✅ Bucket создан"
else
    echo "⚠️ Результат создания bucket:"
    cat /tmp/bucket_create.log
fi

# Настраиваем ключи если заданы
if [ "$SETUP_KEYS" = true ]; then
    echo "Настраиваем ключи доступа..."
    
    # Даем немного времени для инициализации
    sleep 2
    
    echo "Получаем список ключей..."
    garage key list
    
    echo "Импортируем ключ: $S3_ACCESS_KEY_ID"
    # Используем сам ключ как имя
    if garage key import --yes "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" 2>&1 | tee /tmp/key_import.log; then
        echo "✅ Ключ импортирован успешно"
    else
        echo "⚠️ Импорт ключа выдал некоторый результат (может быть ключ уже существует)"
        cat /tmp/key_import.log
    fi
    
    # Даем права на bucket используя ключ как ID
    echo "Даем права на bucket для ключа $S3_ACCESS_KEY_ID..."
    if garage bucket allow --read --write "$S3_BUCKET_NAME" --key "$S3_ACCESS_KEY_ID" 2>&1; then
        echo "✅ Права настроены"
    else
        echo "⚠️ Может быть ошибка при настройке прав (не критично)"
    fi
    
    echo "Проверяем финальный список ключей..."
    garage key list
fi

# Останавливаем сервер
echo "Останавливаем сервер..."
kill $SERVER_PID 2>/dev/null || true
sleep 2

# Перезапускаем в foreground режиме
echo "Запускаем Garage в foreground режиме..."
exec garage server