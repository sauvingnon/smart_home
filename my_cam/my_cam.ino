#include "esp_camera.h"
#include <WiFi.h>
#include <WebSocketsClient_Generic.h>
#include <Preferences.h>

// ===== НАСТРОЙКИ =====
// const char* ssid = "TP-Link_8343";
// const char* password = "64826424";
// const char* websocket_host = "api.tgapp.dotnetdon.ru";
// const uint16_t websocket_port = 443;
const char* ssid = "TP-Link_297F";
const char* password = "23598126";
const char* websocket_host = "192.168.1.100";
const uint16_t websocket_port = 8005;
const char* camera_id = "cam1";
const char* access_key = "12345678";
// =====================

// Пин для управления вентилятором
#define FAN_PIN 12

// Объект для работы с памятью
Preferences preferences;

// Активен ли кулер.
bool fanState = true;

// ПИНЫ AI-THINKER
#define PWDN_GPIO_NUM 32
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM 0
#define SIOD_GPIO_NUM 26
#define SIOC_GPIO_NUM 27
#define Y9_GPIO_NUM 35
#define Y8_GPIO_NUM 34
#define Y7_GPIO_NUM 39
#define Y6_GPIO_NUM 36
#define Y5_GPIO_NUM 21
#define Y4_GPIO_NUM 19
#define Y3_GPIO_NUM 18
#define Y2_GPIO_NUM 5
#define VSYNC_GPIO_NUM 25
#define HREF_GPIO_NUM 23
#define PCLK_GPIO_NUM 22

WebSocketsClient webSocket;
bool isConnected = false;
bool isAuthenticated = false;
bool isStreamActive = false;

// Счётчик кадров и таймеры
static unsigned long frameCount = 0;
static unsigned long lastFpsLog = 0;

// Качество изображения
static int currentQualityMode = 0;
static framesize_t currentFrameSize = FRAMESIZE_QVGA;

// --- Прототипы функций ---
void startWebSocketClient();
void webSocketTask(void * pvParameters);

// --- Функция инициализации камеры ---
void initCamera() {

  // Включаем питание камеры
  pinMode(PWDN_GPIO_NUM, OUTPUT);
  digitalWrite(PWDN_GPIO_NUM, LOW);
  delay(100);

  // ---------- КАМЕРА (ТОЧНАЯ КОПИЯ ПРИМЕРА) ----------
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.frame_size = FRAMESIZE_UXGA;      // Максимальное разрешение для старта
  config.pixel_format = PIXFORMAT_JPEG;    // для стриминга
  config.grab_mode = CAMERA_GRAB_WHEN_EMPTY; // КАК В ПРИМЕРЕ
  config.fb_location = CAMERA_FB_IN_PSRAM; // Пытаемся использовать PSRAM
  config.jpeg_quality = 12;
  config.fb_count = 1;                     // Начнем с 1, как пример

  // if PSRAM IC present, init with UXGA resolution and higher JPEG quality
  //                      for larger pre-allocated frame buffer.
  if (config.pixel_format == PIXFORMAT_JPEG) {
    if (psramFound()) {
      config.jpeg_quality = 10;
      config.fb_count = 2;
      config.grab_mode = CAMERA_GRAB_LATEST; // !!! В примере для PSRAM ставят LATEST
    } else {
      // Limit the frame size when PSRAM is not available
      config.frame_size = FRAMESIZE_SVGA;
      config.fb_location = CAMERA_FB_IN_DRAM;
    }
  } else {
    // Best option for face detection/recognition
    config.frame_size = FRAMESIZE_240X240;
  }

  // Camera init
  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed with error 0x%x", err);
    return;
  }

  // Доп. настройки сенсора (как в примере)
  sensor_t * s = esp_camera_sensor_get();
  // initial sensors are flipped vertically and colors are a bit saturated
  if (s->id.PID == OV3660_PID) {
    s->set_vflip(s, 0);        // flip it back
    s->set_hmirror(s, 1);      // Горизонтальное оторажение
    s->set_brightness(s, 1);   // up the brightness just a bit
    s->set_saturation(s, -2);  // lower the saturation
  }
  // drop down frame size for higher initial frame rate
  if (config.pixel_format == PIXFORMAT_JPEG) {
    s->set_framesize(s, FRAMESIZE_QVGA); // Начинаем с QVGA для скорости
    s->set_framesize(s, currentFrameSize); // Потом ставим из памяти
  }
  
  Serial.println("✅ Camera initialized");
}

// Управление кулером
void toggleFan(bool isActive){
  digitalWrite(FAN_PIN, isActive ? HIGH : LOW);
}

// --- Функция остановки камеры ---
void stopCamera() {
  esp_camera_deinit();

  // Выключаем питание камеры
  pinMode(PWDN_GPIO_NUM, OUTPUT);
  digitalWrite(PWDN_GPIO_NUM, HIGH);

  Serial.println("✅ Camera deinitialized");
}

// --- Установка качества ---
bool setFrameSize(String size) {
  sensor_t *s = esp_camera_sensor_get();
  if (!s) return false;

  framesize_t fs;
  if (size == "QVGA") {
    fs = FRAMESIZE_QVGA;   // 320x240
    currentQualityMode = 0;
  }
  else if (size == "VGA") { 
    fs = FRAMESIZE_VGA;    // 640x480
    currentQualityMode = 1;
  }
  else if (size == "HD") {
    fs = FRAMESIZE_HD;     // 1280x720
    currentQualityMode = 2;
  }
  else return false;

  if (s->set_framesize(s, fs) == 0) {
    currentFrameSize = fs; // ← сохраняем
    saveSettings();
    return true;
  }

  return false;
}

// --- WebSocket Event ---
void webSocketEvent(const WStype_t& type, uint8_t * payload, const size_t& length) {
  switch (type) {
    case WStype_DISCONNECTED:
      isConnected = false;
      isAuthenticated = false;

      if (isStreamActive) {
          stopCamera();
          isStreamActive = false;
          toggleFan(false);
          Serial.println("🛑 Camera stopped due to WS disconnect");
      }

      Serial.println("❌ WS Disconnected");
      break;
    case WStype_CONNECTED:
      isConnected = true;
      webSocket.sendTXT("AUTH:" + String(access_key) + ":" + String(camera_id));
      Serial.println("✅ WS Connected. Auth sent.");
      break;
    case WStype_TEXT: {
      String cmd = String((char*)payload);
      
      if (cmd == "AUTH_OK") {
        isAuthenticated = true;
        Serial.println("🔑 Auth OK! Streaming...");
      }
      else if (cmd.startsWith("size:")) {
        String newSize = cmd.substring(5);
        if (setFrameSize(newSize)) {
          Serial.printf("📐 Resolution changed to %s\n", newSize.c_str());
          webSocket.sendTXT("size:ok");
        } else {
          Serial.printf("❌ Invalid resolution: %s\n", newSize.c_str());
          webSocket.sendTXT("size:error");
        }
      }
      else if (cmd.startsWith("stream_state:")) {
        String state = cmd.substring(13);
        if (state == "on"){
          if (fanState) {
            toggleFan(true);
          }
          if (!isStreamActive) {
            // 🔧 СНАЧАЛА ДЕИНИЦИАЛИЗИРУЕМ (очищаем предыдущее состояние)
            if (!esp_camera_sensor_get()) {
              // Если сенсор не найден, значит камера не инициализирована
              // Можем просто инициализировать
            } else {
              // Если есть сенсор - деинициализируем сначала
              stopCamera();
              delay(500);  // Даем время на деинициализацию
            }
            
            // Инициализируем камеру заново
            initCamera();
            isStreamActive = true;
            setCpuFrequencyMhz(240);
            WiFi.setSleep(false);
            webSocket.sendTXT("stream_state:ok");
            Serial.println("🎥 Camera ON - streaming started");
          } else {
            webSocket.sendTXT("stream_state:ok");
            Serial.println("Stream already active");
          }
        } else if (state == "off") {
          toggleFan(false);
          if (isStreamActive) {
            // Полностью выключаем камеру
            stopCamera();
            isStreamActive = false;
            setCpuFrequencyMhz(80);
            WiFi.setSleep(true);
            webSocket.sendTXT("stream_state:ok");
            Serial.println("🛑 Camera OFF - deinitialized");
          } else {
            webSocket.sendTXT("stream_state:ok");
          }
        } else {
          toggleFan(false);
          webSocket.sendTXT("stream_state:error");
        }
      }
      else if (cmd.startsWith("fan:")) {
        String fanCmd = cmd.substring(4);
        // Да, включается во время стрима, иначе всегда молчит
        if (fanCmd == "on") {
          fanState = true;
          toggleFan(isStreamActive);
          saveSettings();
          webSocket.sendTXT("fan:ok");
        } else if (fanCmd == "off") {
          fanState = false;
          toggleFan(isStreamActive);
          saveSettings();
          webSocket.sendTXT("fan:ok");
        }
      }
      break;
    }
    default: break;
  }
}

// --- Запуск WebSocket клиента ---
void startWebSocketClient() {
  webSocket.begin(websocket_host, websocket_port, "/esp_service/ws/camera");
  // webSocket.beginSSL(websocket_host, websocket_port, "/esp_service/ws/camera");
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(2000);
  webSocket.enableHeartbeat(15000, 5000, 3);

  // Запускаем задачу стриминга на ядре 1
  xTaskCreatePinnedToCore(
    webSocketTask,
    "ws_task",
    4096,
    NULL,
    2,
    NULL,
    1
  );
}

// Чтение внутренней температуры ESP32
float getTemperature() {
  return temperatureRead();  // Встроенная функция
}

// --- Задача стриминга ---
void webSocketTask(void * pvParameters) {

  while(1) {
    webSocket.loop();

    if (isConnected && isAuthenticated && isStreamActive) {
      camera_fb_t * fb = esp_camera_fb_get();
      if (fb) {
        webSocket.sendBIN(fb->buf, fb->len, false);
        frameCount++;
        esp_camera_fb_return(fb);
      }
    }

    if (millis() - lastFpsLog > 5000) {
      if (isConnected && isAuthenticated) {
        byte isStreamActiveByte = isStreamActive ? 1 : 0;
        String fpsMsg = "fps:" + String(frameCount / 5) + 
                ";quality_mode:" + String(currentQualityMode) + 
                ";tmp:" + String(getTemperature()) + 
                ";isStreamActive:" + String(isStreamActiveByte);
        webSocket.sendTXT(fpsMsg);
        Serial.printf("📊 FPS report: %d fps\n", frameCount / 5);
      }
      frameCount = 0;
      lastFpsLog = millis();
    }
    
    vTaskDelay(10 / portTICK_PERIOD_MS);
  }
}

// --- НАСТРОЙКА КАМЕРЫ (ПОЛНОСТЬЮ ИЗ ПРИМЕРА) ---
void setup() {
  Serial.begin(115200);
  Serial.setDebugOutput(true);
  Serial.println();

  // Вентилятор пин
  pinMode(FAN_PIN, OUTPUT);
  digitalWrite(FAN_PIN, LOW);  // Начинаем с выключенного вентилятора

  loadSettings();

  // ---------- WiFi (как в примере) ----------
  WiFi.begin(ssid, password);
  // Если кадров мало - верни как было.
  // WiFi.setSleep(false);
  WiFi.setSleep(true);
  setCpuFrequencyMhz(80);

  Serial.print("WiFi connecting");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("");
  Serial.println("WiFi connected");

  // ---------- WEBSOCKET (ВМЕСТО HTTP-СЕРВЕРА) ----------
  startWebSocketClient();

  Serial.print("Camera Ready! Streamming to ws://");
  Serial.print(websocket_host);
  Serial.println("/esp_service/ws/camera");
}

// --- ОСНОВНОЙ ЦИКЛ (управление камерой) ---
void loop() {
  delay(10000);
}

// Загрузка настроек из памяти
void loadSettings() {
  preferences.begin("camera", false);
  
  // Загружаем fanState (по умолчанию true)
  fanState = preferences.getBool("fanState", true);
  
  // Загружаем качество (по умолчанию 1 = VGA)
  currentQualityMode = preferences.getInt("qualityMode", 1);
  
  // Преобразуем qualityMode в framesize_t
  switch(currentQualityMode) {
    case 0:
      currentFrameSize = FRAMESIZE_QVGA;
      break;
    case 1:
      currentFrameSize = FRAMESIZE_VGA;
      break;
    case 2:
      currentFrameSize = FRAMESIZE_HD;
      break;
    default:
      currentFrameSize = FRAMESIZE_VGA;
      currentQualityMode = 1;
  }
  
  preferences.end();
  
  Serial.printf("📦 Загружены настройки: fanState=%d, qualityMode=%d\n", fanState, currentQualityMode);
}

// Сохранение настроек в память
void saveSettings() {
  preferences.begin("camera", false);
  
  preferences.putBool("fanState", fanState);
  preferences.putInt("qualityMode", currentQualityMode);
  
  preferences.end();
  
  Serial.printf("💾 Сохранены настройки: fanState=%d, qualityMode=%d\n", fanState, currentQualityMode);
}