#!/bin/sh
set -e

echo "Initializing Mosquitto MQTT broker..."

mkdir -p /mosquitto/config

if [ -z "$MQTT_USERNAME" ] || [ -z "$MQTT_PASSWORD" ]; then
    echo "ERROR: MQTT_USERNAME or MQTT_PASSWORD not set!"
    exit 1
fi

if [ ! -f /mosquitto/config/mosquitto.conf ]; then
    echo "ERROR: mosquitto.conf not found in /mosquitto/config/"
    exit 1
fi

echo "Creating password file for user: $MQTT_USERNAME"

touch /mosquitto/config/passwd
chmod 0700 /mosquitto/config/passwd
mosquitto_passwd -b /mosquitto/config/passwd "$MQTT_USERNAME" "$MQTT_PASSWORD"

echo "Password file created at /mosquitto/config/passwd"
echo "Config file: /mosquitto/config/mosquitto.conf"


echo "Starting Mosquitto..."
exec mosquitto -c /mosquitto/config/mosquitto.conf