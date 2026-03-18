#include "esp_camera.h"
#include <WiFi.h>
#include <WebSocketsClient_Generic.h>

// ===== НАСТРОЙКИ =====
// const char* ssid = "TP-Link_8343";
// const char* password = "64826424";
// const char* websocket_host = "tgapp.dotnetdon.ru";
// const uint16_t websocket_port = 4444;
const char* ssid = "TP-Link_297F";
const char* password = "23598126";
const char* websocket_host = "192.168.1.102";
const uint16_t websocket_port = 8005;
const char* camera_id = "cam1";
const char* access_key = "12345678";
// =====================

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

// Счётчик кадров и таймеры
static unsigned long frameCount = 0;
static unsigned long lastFpsLog = 0;

// Качество изображения
static int currentQualityMode = 0;

// --- Прототипы функций (как в примере) ---
void startWebSocketClient();
void webSocketTask(void * pvParameters);

// --- Установка качества (три варианта) ---
bool setFrameSize(String size) {
  sensor_t *s = esp_camera_sensor_get();
  if (!s) return false;

  framesize_t fs;
  if (size == "QVGA") {
    fs = FRAMESIZE_QVGA;   // 320x240 (быстрый)
    currentQualityMode = 0;
  }
  else if (size == "VGA") { 
    fs = FRAMESIZE_VGA; // 640x480 (базовый)
    currentQualityMode = 1;
  }
  else if (size == "HD") {
    fs = FRAMESIZE_HD;   // 1280x720 (качественный)
    currentQualityMode = 2;
  }
  else return false;

  return s->set_framesize(s, fs) == 0;
}

// --- WebSocket Event (оставим как есть) ---
void webSocketEvent(const WStype_t& type, uint8_t * payload, const size_t& length) {
  switch (type) {
    case WStype_DISCONNECTED:
      isConnected = false;
      isAuthenticated = false;
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
      break;
    }
    default: break;
  }
}

// --- Функция запуска WebSocket клиента (аналог startCameraServer) ---
void startWebSocketClient() {
  webSocket.begin(websocket_host, websocket_port, "/esp_service/ws/camera");
  // webSocket.beginSSL(websocket_host, websocket_port, "/esp_service/ws/camera");
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(2000);
  webSocket.enableHeartbeat(15000, 3000, 2);

  // Запускаем задачу стриминга на ядре 1 (как это делает HTTP-сервер)
  xTaskCreatePinnedToCore(
    webSocketTask,  // Функция задачи
    "ws_task",      // Имя задачи
    4096,           // Размер стека (как в HTTP примере)
    NULL,           // Параметры
    2,              // Приоритет (как в HTTP примере)
    NULL,           // Хендл
    1               // Ядро
  );
}

// --- Задача стриминга ---
void webSocketTask(void * pvParameters) {
  while(1) {
    // Всегда дергаем loop
    webSocket.loop();

    // Если все ок - шлем кадры
    if (isConnected && isAuthenticated) {
      camera_fb_t * fb = esp_camera_fb_get();
      if (fb) {
        webSocket.sendBIN(fb->buf, fb->len, false);
        frameCount++;
        esp_camera_fb_return(fb);
      }
    }

     // Отправка FPS раз в 5 секунд
    if (millis() - lastFpsLog > 5000) {
      if (isConnected && isAuthenticated) {
        String fpsMsg = "fps:" + String(frameCount / 5) + ";quality_mode:" + String(currentQualityMode);
        webSocket.sendTXT(fpsMsg);
        Serial.printf("📊 FPS report: %d fps\n", frameCount / 5);
      }
      frameCount = 0;
      lastFpsLog = millis();
    }
    
    // Маленькая задержка для передачи управления (как в примере HTTP)
    vTaskDelay(10 / portTICK_PERIOD_MS);
  }
}

// --- НАСТРОЙКА КАМЕРЫ (ПОЛНОСТЬЮ ИЗ ПРИМЕРА) ---
void setup() {
  Serial.begin(115200);
  Serial.setDebugOutput(true);
  Serial.println();

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
  config.xclk_freq_hz = 10000000;
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
    s->set_vflip(s, 1);        // flip it back
    s->set_brightness(s, 1);   // up the brightness just a bit
    s->set_saturation(s, -2);  // lower the saturation
  }
  // drop down frame size for higher initial frame rate
  if (config.pixel_format == PIXFORMAT_JPEG) {
    s->set_framesize(s, FRAMESIZE_QVGA); // Начинаем с QVGA для скорости
  }

  // ---------- WiFi (как в примере) ----------
  WiFi.begin(ssid, password);
  WiFi.setSleep(false);
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

// --- ПОЛНОСТЬЮ ПУСТОЙ LOOP, КАК В ПРИМЕРЕ ---
void loop() {
  // Все задачи в webSocketTask
  delay(10000);
}