#!/bin/sh
set -e

echo "🚀 Initializing Mosquitto MQTT broker..."

# ХАРДКОД для теста
USER="mqtt_user"
PASS="Test123"  # ← ПРОСТОЙ ПАРОЛЬ

echo "🔑 Creating password for user: $USER with pass: $PASS"

# Прямой вызов с простым паролем
mosquitto_passwd -c /mosquitto/config/passwd "$USER" "$PASS"
chmod 0600 /mosquitto/config/passwd

echo "✅ Password file ready"
echo "🚀 Starting Mosquitto..."
exec mosquitto -c /mosquitto/config/mosquitto.conf