#!/bin/sh
set -e

echo "🚀 Initializing Mosquitto MQTT broker..."

# Проверяем переменные окружения
if [ -z "$MQTT_USERNAME" ] || [ -z "$MQTT_PASSWORD" ]; then
    echo "❌ ERROR: MQTT_USERNAME or MQTT_PASSWORD not set!"
    exit 1
fi

# Проверяем конфиг
if [ ! -f /mosquitto/config/mosquitto.conf ]; then
    echo "❌ ERROR: mosquitto.conf not found in /mosquitto/config/"
    exit 1
fi

# Создаем/обновляем файл паролей
echo "🔑 Creating password file for user: $MQTT_USERNAME"
mosquitto_passwd -b /mosquitto/config/passwd "$MQTT_USERNAME" "$MQTT_PASSWORD"

# Устанавливаем правильные права (без этого Mosquitto ругается)
chmod 0700 /mosquitto/config/passwd

echo "✅ Password file created at /mosquitto/config/passwd"
echo "📋 Config file: /mosquitto/config/mosquitto.conf"

# Запускаем Mosquitto
echo "🚀 Starting Mosquitto..."
exec mosquitto -c /mosquitto/config/mosquitto.conf