#!/bin/sh
set -e

echo "Initializing Mosquitto MQTT broker..."

# Создаем все необходимые директории
mkdir -p /mosquitto/config
mkdir -p /mosquitto/data
mkdir -p /mosquitto/log

# Проверяем переменные окружения
if [ -z "$MQTT_USERNAME" ] || [ -z "$MQTT_PASSWORD" ]; then
    echo "ERROR: MQTT_USERNAME or MQTT_PASSWORD not set!"
    exit 1
fi

# Проверяем конфиг
if [ ! -f /mosquitto/config/mosquitto.conf ]; then
    echo "ERROR: mosquitto.conf not found in /mosquitto/config/"
    exit 1
fi

# Устанавливаем права доступа
echo "Setting permissions..."
chown -R mosquitto:mosquitto /mosquitto/data 2>/dev/null || true
chown -R mosquitto:mosquitto /mosquitto/log 2>/dev/null || true
chmod 0755 /mosquitto/data
chmod 0755 /mosquitto/log

# Создаем файл паролей
echo "Creating password file for user: $MQTT_USERNAME"
touch /mosquitto/config/passwd
mosquitto_passwd -b /mosquitto/config/passwd "$MQTT_USERNAME" "$MQTT_PASSWORD" 2>&1

# Устанавливаем права для mosquitto пользователя
chown mosquitto:mosquitto /mosquitto/config/passwd 2>/dev/null || true
chmod 0600 /mosquitto/config/passwd

# Проверяем права доступа
echo "Checking permissions..."
ls -la /mosquitto/ || true
ls -la /mosquitto/config/ || true

echo "Password file created at /mosquitto/config/passwd"
echo "Config file: /mosquitto/config/mosquitto.conf"
echo "Starting Mosquitto..."
exec mosquitto -c /mosquitto/config/mosquitto.conf