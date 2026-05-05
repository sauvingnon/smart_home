// ============================================================
//  toilet_module.ino  —  ESP-12E (ESP8266)
//  Управление светом и вентилятором в туалете
// ============================================================
#include <ESP8266WiFi.h>
#include <Wire.h>
#include <RTClib.h>
#include <ArduinoJson.h>
#include "SimpleMQTTManager.h"
#include "config.h"

// ============================================================
//  Пины (ESP-12E)
//  I2C (DS1307): SDA = GPIO4 (D2), SCL = GPIO5 (D1) — дефолт
//  Реле: активный LOW — LOW = замкнуто, HIGH = разомкнуто
// ============================================================
#define PIN_SENSOR  A0    // Фоторезистор         (0–1V → 0–1023)
#define PIN_LIGHT   16    // GPIO16 (D0) — реле света
#define PIN_FAN     0     // GPIO0  (D3) — реле вентилятора
#define PIN_LED     13    // GPIO13 (D7) — светодиод

// ============================================================
//  Константы
// ============================================================
#define LIGHT_THRESHOLD  300

// ============================================================
//  MQTT топики
// ============================================================
const char* set_config_topic  = "greenhouse_01/config/set"; // бекенд прислал настройки (прием)
const char* get_config_topic  = "config/get"; // запрос настроек у центра (отправка)
const char* set_time_topic    = "toilet_module/time/set";   // синхронизация времени (прием)
const char* send_config_topic = "greenhouse_01/config/update";            // центральная плата прислала настройки (прием)
const char* status_topic          = "status";           // публикуется как toilet_module/status - heartbeat и состояние (отправка)
const char* silence_ended  = "toilet_module/silence/ended";  // публикуется при отключении режима тишины после реального визита (отправка)

// ============================================================
//  Настройки (только RAM, сбрасываются при перезагрузке)
// ============================================================
struct Config {
  byte timeBeforeCool = 120;  // секунд
  byte timeAfterCool  = 3;    // минут
  byte dayHour        = 7;
  byte dayMinute      = 0;
  byte nightHour      = 23;
  byte nightMinute    = 0;
  bool silentOn       = false;
};

Config cfg;

// ============================================================
//  Рабочее состояние
// ============================================================
RTC_DS1307        rtc;
WiFiClient        wifiClient;
SimpleMQTTManager mqtt(&wifiClient, MQTT_SERVER, MQTT_PORT, MQTT_USER, MQTT_PASS);

byte currentHour   = 0;
byte currentMinute = 0;

int  sensorVal    = 0;
bool lightWasOn   = false;
int  lightOnTimer = 0;
bool fanRunning   = false;

unsigned long lastTick    = 0;
bool          configReady = false;  // true после первого успешного запроса конфига

// ============================================================
//  RTC — DS1307
// ============================================================
void updateTime() {
  DateTime now = rtc.now();
  currentHour   = now.hour();
  currentMinute = now.minute();
}

void setTime(byte hour, byte minute) {
  DateTime now = rtc.now();
  rtc.adjust(DateTime(now.year(), now.month(), now.day(), hour, minute, 0));
  currentHour   = hour;
  currentMinute = minute;
}

bool isDay() {
  int cur  = currentHour * 60 + currentMinute;
  int dawn = cfg.dayHour   * 60 + cfg.dayMinute;
  int dusk = cfg.nightHour * 60 + cfg.nightMinute;
  return cur >= dawn && cur < dusk;
}

// ============================================================
//  WiFi
// ============================================================
void setupWiFi() {
  Serial.printf("[WiFi] Connecting to %s...\n", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
  }
  Serial.printf("[WiFi] Connected, IP: %s\n", WiFi.localIP().toString().c_str());
}

// ============================================================
//  Реле — helpers
// ============================================================
void fanOn()  { digitalWrite(PIN_FAN, LOW);  fanRunning = true;  Serial.println("[FAN] ON");  }
void fanOff() { digitalWrite(PIN_FAN, HIGH); fanRunning = false; Serial.println("[FAN] OFF"); }

// ============================================================
//  Принудительное вентилирование (макс. 30 минут)
// ============================================================
#define FAN_FORCED_MAX_MIN  30

void runFanForced(int minutes) {
  minutes = constrain(minutes, 1, FAN_FORCED_MAX_MIN);
  Serial.printf("[FAN] Forced ventilation: %d min\n", minutes);
  fanOn();
  for (int m = 0; m < minutes; m++) {
    for (int s = 0; s < 60; s++) {
      delay(1000);
      mqtt.loop();
    }
  }
  fanOff();
  Serial.println("[FAN] Forced ventilation done");
}

// ============================================================
//  Светодиод
// ============================================================
void ledBlink(int times, int onMs, int offMs) {
  for (int i = 0; i < times; i++) {
    digitalWrite(PIN_LED, HIGH); delay(onMs);
    digitalWrite(PIN_LED, LOW);  delay(offMs);
  }
}

// ============================================================
//  Детектор паттерна мигания → режим тишины
//
//  Паттерн: 2 коротких вспышки из темноты
//  (тьма → свет → тьма → свет → тьма)
//  Вспышка считается если она длится BLINK_MIN_MS..BLINK_MAX_MS.
//  Обе вспышки должны уложиться в BLINK_WINDOW_MS.
// ============================================================
#define BLINK_MIN_MS     300
#define BLINK_MAX_MS    2500
#define BLINK_WINDOW_MS 8000

struct {
  bool          lastState    = false;
  unsigned long onStartMs    = 0;
  int           count        = 0;
  unsigned long firstBlinkMs = 0;
} blinkDetector;

void checkBlinkPattern() {
  static unsigned long lastCheck = 0;
  unsigned long now = millis();
  if (now - lastCheck < 100) return;
  lastCheck = now;

  bool on = (analogRead(PIN_SENSOR) > LIGHT_THRESHOLD);

  // Сброс если окно истекло
  if (blinkDetector.count > 0 && now - blinkDetector.firstBlinkMs > BLINK_WINDOW_MS) {
    Serial.println("[BLINK] Window expired, reset counter");
    blinkDetector.count = 0;
  }

  if (on && !blinkDetector.lastState) {
    // Фронт: свет включился — запоминаем момент
    blinkDetector.onStartMs = now;
  }

  if (!on && blinkDetector.lastState) {
    // Спад: свет выключился — оцениваем длительность вспышки
    unsigned long duration = now - blinkDetector.onStartMs;
    if (duration >= BLINK_MIN_MS && duration <= BLINK_MAX_MS) {
      if (blinkDetector.count == 0) blinkDetector.firstBlinkMs = now;
      blinkDetector.count++;
      Serial.printf("[BLINK] Flash #%d, duration: %lums\n", blinkDetector.count, duration);
      if (blinkDetector.count >= 2) {
        cfg.silentOn = true;
        blinkDetector.count = 0;
        Serial.println("[BLINK] Pattern detected -> SILENT MODE ON");
        ledBlink(5, 100, 100);
      }
    } else if (duration > BLINK_MAX_MS) {
      Serial.printf("[BLINK] Flash too long (%lums), reset counter\n", duration);
      blinkDetector.count = 0;
    }
  }

  blinkDetector.lastState = on;
}

// ============================================================
//  MQTT — публикация состояния - heartbeat и текущие данные
// ============================================================
void publishStatus() {
  StaticJsonDocument<128> doc;
  doc["lightOn"]    = (sensorVal > LIGHT_THRESHOLD);
  doc["fanOn"]      = fanRunning;
  doc["sensor"]     = sensorVal;
  doc["isDay"]      = isDay();
  doc["hour"]       = currentHour;
  doc["minute"]     = currentMinute;
  doc["silentMode"] = cfg.silentOn;
  mqtt.publish(status_topic, doc);
}

// ============================================================
//  Setup
// ============================================================
void setup() {
  Serial.begin(115200);
  pinMode(PIN_LIGHT, OUTPUT);
  pinMode(PIN_FAN,   OUTPUT);
  pinMode(PIN_LED,   OUTPUT);
  digitalWrite(PIN_LIGHT, HIGH);
  digitalWrite(PIN_LED,   LOW);
  fanOff();

  Wire.begin();

  rtc.begin();

  setupWiFi();

  mqtt.setDeviceId(DEVICE_ID);
  mqtt.begin();
  setupMQTTHandlers();

  // Ждём подключения не более 10 секунд, затем запрашиваем настройки
  // Если MQTT недоступен — стартуем с дефолтными значениями
  Serial.println("[MQTT] Waiting for connection (max 10s)...");
  unsigned long waitStart = millis();
  while (!mqtt.connected() && millis() - waitStart < 10000) {
    mqtt.loop();
    delay(100);
  }
  if (!mqtt.connected()) {
    Serial.println("[MQTT] Not available, starting with defaults");
    Serial.printf("  dayHour=%d:%02d  nightHour=%d:%02d  fanDelay=%ds  fanDuration=%dmin  silent=%d\n",
      cfg.dayHour, cfg.dayMinute, cfg.nightHour, cfg.nightMinute,
      cfg.timeBeforeCool, cfg.timeAfterCool, cfg.silentOn);
  }

  Serial.println("[BOOT] Ready");
  ledBlink(3, 300, 300);
}

// ============================================================
//  Loop
// ============================================================
void loop() {
  mqtt.loop();
  checkBlinkPattern();

  // Первое подключение после старта без MQTT — запросить конфиг
  if (!configReady && mqtt.connected()) {
    Serial.println("[MQTT] Connected (delayed), requesting config...");
    mqtt.publish(get_config_topic, "{\"device_id\":\"" DEVICE_ID "\"}");
    configReady = true;
  }

  if (millis() - lastTick < 1000) return;
  lastTick = millis();

  updateTime();

  sensorVal    = analogRead(PIN_SENSOR);
  bool lightOn = (sensorVal > LIGHT_THRESHOLD);
  bool day     = isDay();

  // Периодический дамп времени и isDay каждые 30 сек
  static int debugTickCounter = 0;
  if (++debugTickCounter >= 30) {
    debugTickCounter = 0;
    int cur  = currentHour * 60 + currentMinute;
    int dawn = cfg.dayHour * 60 + cfg.dayMinute;
    int dusk = cfg.nightHour * 60 + cfg.nightMinute;
    Serial.printf("[TIME] %02d:%02d  cur=%d  dawn=%d(%d:%02d)  dusk=%d(%d:%02d)  isDay=%d\n",
      currentHour, currentMinute,
      cur, dawn, cfg.dayHour, cfg.dayMinute,
      dusk, cfg.nightHour, cfg.nightMinute, day);
  }

  // Принт при смене день/ночь
  static bool prevDay = false;
  if (day != prevDay) {
    prevDay = day;
    Serial.printf("[DAY] Changed -> %s  time=%02d:%02d\n", day ? "DAY" : "NIGHT", currentHour, currentMinute);
  }

  // Дневное / ночное реле света
  digitalWrite(PIN_LIGHT, day ? LOW : HIGH);

  // --- Свет горит ---
  if (lightOn) {
    if (!lightWasOn) Serial.printf("[LIGHT] ON  sensor=%d  silent=%d  day=%d\n", sensorVal, cfg.silentOn, day);
    lightOnTimer++;
    lightWasOn = true;
    // >= с гардом !fanRunning — не пропустим тик и не спамим
    if (lightOnTimer >= cfg.timeBeforeCool && !fanRunning) {
      if (day && !cfg.silentOn) {
        Serial.printf("[LIGHT] Timer reached %ds -> fan on\n", cfg.timeBeforeCool);
        fanOn();
      } else {
        Serial.printf("[LIGHT] Timer reached %ds, fan skipped (day=%d silent=%d)\n", cfg.timeBeforeCool, day, cfg.silentOn);
      }
    }
  }

  // --- Свет погас ---
  if (!lightOn && lightWasOn) {
    bool realVisit   = (lightOnTimer >= cfg.timeBeforeCool);
    bool silentWasOn = cfg.silentOn;
    Serial.printf("[LIGHT] OFF  timer=%ds  realVisit=%d  silent=%d  day=%d\n", lightOnTimer, realVisit, silentWasOn, day);
    if (realVisit && day) {
      // Тишина при кулдауне не учитывается — только день/ночь
      fanOn();  // включаем явно (мог не гореть если был silent во время визита)
      Serial.printf("[FAN] Cooldown: %d min\n", cfg.timeAfterCool);
      int afterTimer = 0;
      while (afterTimer < cfg.timeAfterCool * 60) {
        delay(1000);
        afterTimer++;
        mqtt.loop();
      }
      Serial.println("[FAN] Cooldown done");
    }
    if (realVisit) {
      cfg.silentOn = false;
      if (silentWasOn) {
        Serial.println("[SILENT] Reset after visit, notifying center");
        mqtt.publish(silence_ended, "{\"silentMode\":false}");
      }
    }
    fanOff();
    lightOnTimer = 0;
    lightWasOn   = false;
  }

  static int statusTickCounter = 0;
  if (++statusTickCounter >= 60) {
    statusTickCounter = 0;
    publishStatus();
  }

  // LED горит постоянно пока MQTT недоступен
  digitalWrite(PIN_LED, mqtt.connected() ? LOW : HIGH);
}


// ============================================================
//  MQTT — парсинг и применение настроек
// ============================================================
void applyConfig(const String& payload) {
  StaticJsonDocument<256> doc;
  if (deserializeJson(doc, payload)) {
    Serial.println("[CFG] JSON parse error");
    return;
  }

  if (doc.containsKey("toiletOnHour"))   cfg.dayHour        = doc["toiletOnHour"].as<byte>();
  if (doc.containsKey("toiletOnMinute")) cfg.dayMinute      = doc["toiletOnMinute"].as<byte>();
  if (doc.containsKey("toiletOffHour"))  cfg.nightHour      = doc["toiletOffHour"].as<byte>();
  if (doc.containsKey("toiletOffMinute"))cfg.nightMinute    = doc["toiletOffMinute"].as<byte>();
  if (doc.containsKey("fanDelay"))       cfg.timeBeforeCool = doc["fanDelay"].as<byte>();
  if (doc.containsKey("fanDuration"))    cfg.timeAfterCool  = doc["fanDuration"].as<byte>();
  if (doc.containsKey("silentMode"))     cfg.silentOn       = doc["silentMode"].as<bool>();

  Serial.printf("[CFG] Applied: day=%d:%02d night=%d:%02d fanDelay=%ds fanDuration=%dmin silent=%d\n",
    cfg.dayHour, cfg.dayMinute, cfg.nightHour, cfg.nightMinute,
    cfg.timeBeforeCool, cfg.timeAfterCool, cfg.silentOn);

  byte forced = doc["forcedVentilationTimeout"] | 0;
  if (forced > 0) runFanForced(forced);
}

// ============================================================
//  MQTT — регистрация обработчиков
// ============================================================
void setupMQTTHandlers() {

  // Настройки от бекенда
  mqtt.addHandler(set_config_topic, [](const String& topic, const String& msg) {
    applyConfig(msg);
  });

  // Настройки от центральной платы (тот же парсер)
  mqtt.addHandler(send_config_topic, [](const String& topic, const String& msg) {
    applyConfig(msg);
  });

  // Синхронизация времени
  mqtt.addHandler(set_time_topic, [](const String& topic, const String& msg) {
    StaticJsonDocument<128> doc;
    if (deserializeJson(doc, msg)) return;

    int year   = doc["year"]   | 2024;
    int month  = doc["month"]  | 1;
    int day    = doc["day"]    | 1;
    int hour   = doc["hour"]   | 0;
    int minute = doc["minute"] | 0;
    int second = doc["second"] | 0;

    rtc.adjust(DateTime(year, month, day, hour, minute, second));
    currentHour   = hour;
    currentMinute = minute;
    Serial.printf("[TIME] Set to %04d-%02d-%02d %02d:%02d:%02d\n", year, month, day, hour, minute, second);

    mqtt.publish("time/ready", "{}");  // публикуется как toilet_module/time/ready
  });
}