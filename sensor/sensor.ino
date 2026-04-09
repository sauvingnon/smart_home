#include "SimpleMQTTManager.h"
#include <Wire.h>

// ========== ПИНЫ ==========
const int ledPin = 2;        // D4 (встроенный светодиод)
const int reedPin = 5;       // D1 (геркон)

// ========== WiFi & MQTT ==========
const char* ssid = "TP-Link_8343";
const char* password = "64826424";
const char* mqtt_server = "api.tgapp.dotnetdon.ru";
// const char* ssid = "TP-Link_297F";
// const char* password = "23598126";
// const char* mqtt_server = "192.168.1.100";
const int mqtt_port = 1883;
const char* mqtt_user = "mqtt_user";
const char* mqtt_pass = "tWl9w9FwMskvpv7";
const char* device_id = "sensor_door";

WiFiClient wifiClient;
SimpleMQTTManager mqtt(&wifiClient, mqtt_server, mqtt_port, mqtt_user, mqtt_pass);

// ========== Параметры ==========
const unsigned long MIN_SEND_INTERVAL = 500;   // не чаще 500 мс
const unsigned long DEBOUNCE_MS = 50;          // антидребезг
const unsigned long HEARTBEAT_INTERVAL = 300000; // 5 минут (300000 мс)

// Состояния
bool lastState = HIGH;          // последнее стабильное состояние
bool currentState = HIGH;       // текущее состояние после фильтра
unsigned long lastDebounceTime = 0;
unsigned long lastSendTime = 0;
unsigned long lastHeartbeatTime = 0;
bool motionDetected = false;

// LED режимы
enum LedMode { LED_IDLE, LED_MOTION, LED_NO_CONNECTION };
LedMode currentLedMode = LED_IDLE;
bool systemReady = false;

// ========== LED ==========
void setLedMode(LedMode mode) {
  currentLedMode = mode;
  if (mode == LED_IDLE) digitalWrite(ledPin, LOW);
  else if (mode == LED_NO_CONNECTION) digitalWrite(ledPin, HIGH);
  else if (mode == LED_MOTION) {
    // мигание будет в loop
  }
}

void updateLed() {
  unsigned long now = millis();
  switch (currentLedMode) {
    case LED_IDLE:
      digitalWrite(ledPin, LOW);
      break;
    case LED_MOTION:
      // мигаем 5 раз быстро (80/80/80/80/80)
      if ((now - lastSendTime) < 500) {
        int cycle = (now - lastSendTime) % 100;
        digitalWrite(ledPin, cycle < 50 ? HIGH : LOW);
      } else {
        digitalWrite(ledPin, LOW);
      }
      break;
    case LED_NO_CONNECTION:
      digitalWrite(ledPin, HIGH);
      break;
  }
}

// ========== MQTT ==========
void sendStateEvent(bool isOpen) {
  String payload = "{";
  payload += "\"device_id\":\"" + String(device_id) + "\",";
  payload += "\"state\":\"" + String(isOpen ? "open" : "closed") + "\",";
  payload += "\"timestamp\":" + String(millis());
  payload += "}";

  if (mqtt.connected()) {
    mqtt.publish("door/state", payload);
    Serial.printf("🚪 Door state: %s\n", isOpen ? "OPEN" : "CLOSED");
  } else {
    Serial.println("⚠️ MQTT not connected, event lost");
  }
}

// ========== HEARTBEAT ==========
void sendHeartbeat() {
  bool isOpen = (currentState == HIGH);
  int rssi = WiFi.RSSI();
  unsigned long uptime = millis() / 1000; // секунды
  
  String payload = "{";
  payload += "\"device_id\":\"" + String(device_id) + "\",";
  payload += "\"type\":\"heartbeat\",";
  payload += "\"state\":\"" + String(isOpen ? "open" : "closed") + "\",";
  payload += "\"rssi\":" + String(rssi) + ",";
  payload += "\"uptime\":" + String(uptime) + ",";
  payload += "\"timestamp\":" + String(millis());
  payload += "}";

  if (mqtt.connected()) {
    mqtt.publish("door/heartbeat", payload);
    Serial.printf("💓 Heartbeat sent | State: %s | RSSI: %d dBm | Uptime: %lu sec\n", 
                  isOpen ? "OPEN" : "CLOSED", rssi, uptime);
  } else {
    Serial.println("⚠️ MQTT not connected, heartbeat lost");
  }
}

// ========== WiFi ==========
void connectWiFi() {
  Serial.print("Connecting to WiFi");
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\n✅ WiFi connected");
  Serial.print("IP: ");
  Serial.println(WiFi.localIP());
}

// ========== Настройка ==========
void setup() {
  Serial.begin(115200);
  pinMode(ledPin, OUTPUT);
  digitalWrite(ledPin, LOW);

  // Геркон – с внутренней подтяжкой к VCC (HIGH в покое)
  pinMode(reedPin, INPUT_PULLUP);
  lastState = digitalRead(reedPin);
  currentState = lastState;

  // MQTT
  mqtt.begin();
  mqtt.setDeviceId(device_id);

  // WiFi
  connectWiFi();

  // Ждём MQTT подключения
  setLedMode(LED_NO_CONNECTION);
  while (!mqtt.connected()) {
    mqtt.loop();
    updateLed();
    delay(100);
  }

  systemReady = true;
  setLedMode(LED_IDLE);
  
  // Отправляем первый heartbeat сразу после запуска
  lastHeartbeatTime = millis();
  sendHeartbeat();
  
  Serial.println("\n✅ System ready!");
  Serial.println("📌 Reed switch on pin D3 (GPIO0)");
  Serial.println("💓 Heartbeat every 5 minutes");
}

// ========== Основной цикл ==========
void loop() {
  mqtt.loop();

  // Контроль MQTT
  if (!mqtt.connected()) {
    systemReady = false;
    setLedMode(LED_NO_CONNECTION);
    updateLed();
    delay(100);
    return;
  }

  if (!systemReady) {
    systemReady = true;
    setLedMode(LED_IDLE);
    Serial.println("✅ Connection restored");
    // Отправляем heartbeat сразу после восстановления
    lastHeartbeatTime = millis() - HEARTBEAT_INTERVAL;
  }

  unsigned long now = millis();

  // ========== HEARTBEAT ==========
  if (now - lastHeartbeatTime >= HEARTBEAT_INTERVAL) {
    lastHeartbeatTime = now;
    sendHeartbeat();
  }

  // ========== ДАТЧИК ==========
  // Чтение геркона с антидребезгом
  bool reading = digitalRead(reedPin);
  if (reading != lastState) {
    lastDebounceTime = now;
  }

  if ((now - lastDebounceTime) > DEBOUNCE_MS) {
    if (reading != currentState) {
      currentState = reading;
      // Отправляем событие при любом изменении состояния
      if (now - lastSendTime >= MIN_SEND_INTERVAL) {
        sendStateEvent(currentState == HIGH);
        lastSendTime = now;
        setLedMode(LED_MOTION);
        motionDetected = true;
      }
    }
  }
  lastState = reading;

  // Сброс LED через 1 секунду после последнего события
  if (motionDetected && (now - lastSendTime >= 1000)) {
    motionDetected = false;
    setLedMode(LED_IDLE);
  }

  updateLed();
  delay(10);
}