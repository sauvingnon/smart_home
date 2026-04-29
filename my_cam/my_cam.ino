#include "esp_camera.h"
#include <WiFi.h>
#include <WebSocketsClient_Generic.h>
#include <Preferences.h>
#include "VideoManager.h"
#include "config.h"

// Пин для управления вентилятором
#define FAN_PIN 12

// Объект для работы с памятью
Preferences preferences;

VideoManager videoManager(CAMERA_ID, ACCESS_KEY, HTTP_HOST);
// VideoManager videoManager(CAMERA_ID, ACCESS_KEY, HTTP_HOST);

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

  // Если камера уже инициализирована - не трогаем
  if (esp_camera_sensor_get()) {
      Serial.println("⚠️ Camera was initialized, deiniting first");
      esp_camera_deinit();
      delay(100);
  }

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

// --- Функция инициализации SD-карты ---
void initSDCard() {
    // SD_MMC.setPins(14, 15, 2, -1, -1, -1);
    // Serial.println("SD pins configured");
}

// Управление кулером
void toggleFan(bool isActive){
  // Если разрешена работа вентилятора
  if (fanState) {
    // Управляем им
    digitalWrite(FAN_PIN, isActive ? HIGH : LOW);
  } else {
    // Иначе всегда отключение
    digitalWrite(FAN_PIN, LOW);
  }
}

// --- Функция остановки камеры ---
void stopCamera() {

  if (!esp_camera_sensor_get()) {
      Serial.println("✅ Camera already off");
      return;
  }

  esp_camera_deinit();
  delay(50);

  // Выключаем питание камеры
  pinMode(PWDN_GPIO_NUM, OUTPUT);
  digitalWrite(PWDN_GPIO_NUM, HIGH);

  Serial.println("✅ Camera deinitialized");
}

// --- Установка качества ---
bool setFrameSize(String size, bool needSave = true) {
  // Определяем целевое разрешение
  framesize_t targetFs;
  int targetQualityMode;
  
  if (size == "QVGA") {
    targetFs = FRAMESIZE_QVGA;
    targetQualityMode = 0;
  }
  else if (size == "VGA") { 
    targetFs = FRAMESIZE_VGA;
    targetQualityMode = 1;
  }
  else if (size == "HD") {
    targetFs = FRAMESIZE_HD;
    targetQualityMode = 2;
  }
  else return false;
  
  // Сохраняем настройки в память (всегда)
  if (needSave) {
    currentQualityMode = targetQualityMode;
    currentFrameSize = targetFs;
    saveSettings();
  }
  
  // Пробуем применить на лету, если сенсор активен
  sensor_t *s = esp_camera_sensor_get();
  if (s) {
    if (s->set_framesize(s, targetFs) == 0) {
      Serial.printf("✅ Resolution changed on the fly to %s\n", size.c_str());
      return true;
    } else {
      Serial.printf("⚠️ Failed to change resolution on the fly, will apply after restart\n");
      return false; // Не получилось на лету, но настройки сохранены
    }
  } else {
    // Сенсор не активен — просто сохранили, применится при следующем запуске
    Serial.printf("💾 Resolution saved to %s (will apply on next camera start)\n", size.c_str());
    return true;
  }
}

// --- WebSocket Event ---
void webSocketEvent(const WStype_t& type, uint8_t * payload, const size_t& length) {
  // Реагирование на события WS
  switch (type) {
    // Если отключились
    case WStype_DISCONNECTED:
      isConnected = false;
      isAuthenticated = false;

      // Если стрим или запись были активны - остановим и выключим камеру.
      if (isStreamActive || videoManager.isRecording()) {
          stopCamera();
          isStreamActive = false;
          videoManager.setStreamActive(false);
          videoManager.stopRecord();
          toggleFan(false);
          Serial.println("🛑 Camera stopped due to WS disconnect");
      }

      Serial.println("❌ WS Disconnected");
      break;
    // Если подключились
    case WStype_CONNECTED:
      isConnected = true;
      webSocket.sendTXT("AUTH:" + String(ACCESS_KEY) + ":" + String(CAMERA_ID));
      Serial.println("✅ WS Connected. Auth sent.");
      break;
    // Обмен данными 
    case WStype_TEXT: {
      String cmd = String((char*)payload);
      
      if (cmd == "AUTH_OK") {
        isAuthenticated = true;
        Serial.println("🔑 Auth OK! Streaming...");
      }
      // Установка качества с сервера
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
      // Включить\выключить стрим
      else if (cmd.startsWith("stream_state:")) {

        // Если сейчас запись - нельзя ничего делать.
        if (videoManager.isRecording()) {
          webSocket.sendTXT("stream_state:error:recording_active");
          return;
        }

        String state = cmd.substring(13);
        if (state == "on"){

          toggleFan(true);

          if (!isStreamActive) {
            // Инициализируем камеру заново
            initCamera();

            // Проверяем что камера реально поднялась
            if (!esp_camera_sensor_get()) {
              webSocket.sendTXT("stream_state:error:camera_init_failed");
              toggleFan(false);
              Serial.println("❌ Camera init failed!");
              return;
            }

            isStreamActive = true;
            videoManager.setStreamActive(true);
            // setCpuFrequencyMhz(240);
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
            videoManager.setStreamActive(false);
            // setCpuFrequencyMhz(80);
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
      // Установить состояние вентилятора
      else if (cmd.startsWith("fan:")) {
        String fanCmd = cmd.substring(4);
        // Да, включается во время стрима или записи, иначе всегда молчит
        if (fanCmd == "on") {
          // Установили новый статус
          fanState = true;
          // Провеяем, есть ли нужда включить его прямо сейчас.
          if (isStreamActive || videoManager.isRecording()) {
              toggleFan(true);
          }
          saveSettings();
          webSocket.sendTXT("fan:ok");
        } else if (fanCmd == "off") {
          fanState = false;
          // Всегда выключаем
          toggleFan(false);
          saveSettings();
          webSocket.sendTXT("fan:ok");
        }
      }
      // Начать\остановить запись
      else if (cmd.startsWith("record:")) {
          String recordPart = cmd.substring(7);  // "start:1744300000" или "stop"
          
          if (recordPart.startsWith("start")) {

              // Карта не готова для записи, мы не можем начать запись.
              if (!videoManager.isSDReady()) {
                  webSocket.sendTXT("record:error:no_sd");
                  return;
              }
              
              unsigned long startTime = 0;
              int colonPos = recordPart.indexOf(':');
              if (colonPos != -1) {
                  String timeStr = recordPart.substring(colonPos + 1);
                  startTime = timeStr.toInt();
              }
              
              // Уже запись, не можем.
              if (videoManager.isRecording()) {
                  webSocket.sendTXT("record:error:already");
              } else {
                  // Включаем запись
                  // Сохраняем текущее качество
                  int savedQualityMode = currentQualityMode;

                  // Останавливаем стрим и выключаем камеру если активна
                  if (isStreamActive) {
                      stopCamera();
                      isStreamActive = false;
                      videoManager.setStreamActive(false);
                      webSocket.sendTXT("stream_state:off");
                      delay(200);
                  }

                  // Принудительно в HD (без сохранения в память)
                  currentQualityMode = 2;
                  currentFrameSize = FRAMESIZE_HD;
                  
                  // Инициализируем камеру для записи
                  initCamera();
                  toggleFan(true);
                  // setCpuFrequencyMhz(240);
                  
                  if (videoManager.startRecord(startTime)) {
                      webSocket.sendTXT("record:started");
                  } else {
                      // Выключаем камеру при ошибке
                      stopCamera();
                      toggleFan(false);
                      // setCpuFrequencyMhz(80);

                      // При ошибке возвращаем качество
                      currentQualityMode = savedQualityMode;
                      switch(savedQualityMode) {
                          case 0: currentFrameSize = FRAMESIZE_QVGA; break;
                          case 1: currentFrameSize = FRAMESIZE_VGA; break;
                          case 2: currentFrameSize = FRAMESIZE_HD; break;
                      }
                      webSocket.sendTXT("record:error");
                  }
              }
          }
          else if (recordPart == "stop") {
              if (videoManager.stopRecord()) {
                  // Выключаем камеру
                  stopCamera();
                  toggleFan(false);
                  // setCpuFrequencyMhz(80);
                  
                  // Возвращаем качество из памяти
                  preferences.begin("camera", false);
                  int savedQuality = preferences.getInt("qualityMode", 1);
                  preferences.end();
                  
                  currentQualityMode = savedQuality;
                  switch(savedQuality) {
                      case 0: currentFrameSize = FRAMESIZE_QVGA; break;
                      case 1: currentFrameSize = FRAMESIZE_VGA; break;
                      case 2: currentFrameSize = FRAMESIZE_HD; break;
                  }
                  
                  webSocket.sendTXT("record:stopped");
              } else {
                  webSocket.sendTXT("record:error");
              }
          }
      }
      // Узнать статус очереди
      else if (cmd == "queue:status") {
          int pending = videoManager.pendingCount();
          webSocket.sendTXT("queue:count:" + String(pending));
      }
      break;
    }
    default: break;
  }
}

// --- Запуск WebSocket клиента ---
void startWebSocketClient() {
  if (WEBSOCKET_PORT == 443) {
    webSocket.beginSslWithCA(WEBSOCKET_HOST, WEBSOCKET_PORT, WEB_SOCKET_ENDPOINT, NULL, "wss");
  } else {
    webSocket.begin(WEBSOCKET_HOST, WEBSOCKET_PORT, WEB_SOCKET_ENDPOINT);
  }
  
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(2000);

  // Запускаем задачу стриминга на ядре 1
  // ВОЗМОЖНО ТРЕБУЕТСЯ УВИЛИЧИТЬ СТЕК 
  BaseType_t result = xTaskCreatePinnedToCore(
    webSocketTask, "ws_task", 12288, NULL, 1, NULL, 1
  );
  if (result != pdPASS) {
      Serial.println("❌ WS Task creation FAILED!");
  } else {
      Serial.println("✅ WS Task created");
  }
}

// Чтение внутренней температуры ESP32
float getTemperature() {
  return temperatureRead();  // Встроенная функция
}

// --- Задача стриминга и записи ---
void webSocketTask(void * pvParameters) {
  Serial.println("🚀 WS Task started!");
  while(1) {
    webSocket.loop();

    // Если подключены и WS активен
    if (isConnected && isAuthenticated) {

      // Если идет запись
      if (videoManager.isRecording()) {

        // Камера выключена, а запись якобы идёт - КРИТИЧЕСКАЯ ОШИБКА
        if (!esp_camera_sensor_get()) {
          Serial.println("❌ FATAL: Recording but camera is OFF!");
          videoManager.stopRecord();
          webSocket.sendTXT("record:error:camera_off");
          vTaskDelay(1000);
          continue;
        }        

        camera_fb_t * fb = esp_camera_fb_get();
        if (fb) {
          // Пишем на карту
          if (!videoManager.writeFrame(fb->buf, fb->len)) {
              videoManager.stopRecord();
              stopCamera();
              toggleFan(false);
              // setCpuFrequencyMhz(80);
              webSocket.sendTXT("record:error:write_failed");
          } else {
              frameCount++;
          }
          esp_camera_fb_return(fb);
        }
      // Если идет стрим
      } else if (isStreamActive) {

        // Камера выключена, а флаг стрима true - КРИТИЧЕСКАЯ ОШИБКА
        if (!esp_camera_sensor_get()) {
          Serial.println("❌ FATAL: Streaming but camera is OFF!");
          isStreamActive = false;
          webSocket.sendTXT("stream_state:error:camera_off");
          vTaskDelay(1000);
          continue;
        }

        camera_fb_t * fb = esp_camera_fb_get();
        if (fb) {
            webSocket.sendBIN(fb->buf, fb->len, false);
            frameCount++;
            esp_camera_fb_return(fb);
        }
      }
    }

    if (millis() - lastFpsLog > 5000) {
      if (isConnected && isAuthenticated) {
        byte isStreamActiveByte = isStreamActive ? 1 : 0;
        String fpsMsg = "fps:" + String(frameCount / 5) + 
                ";quality_mode:" + String(currentQualityMode) + 
                ";tmp:" + String(getTemperature()) + 
                ";isStreamActive:" + String(isStreamActiveByte) +
                ";fan:" + String(fanState ? 1 : 0) +
                ";isRecordActive:" + String(videoManager.isRecording() ? 1 : 0);
        webSocket.sendTXT(fpsMsg);
        Serial.printf("📊 Report: %s\n", fpsMsg.c_str());
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

  // Отключаем встроенный светодиод на GPIO13 (он нам не нужен, будем использовать этот пин для вентилятора)
  ledcDetach(FAN_PIN);   // если светодиод был подключён к ШИМ (обычно нет, но на всякий случай)
  pinMode(FAN_PIN, OUTPUT);
  digitalWrite(FAN_PIN, LOW);  // светодиод выключен

  loadSettings();

  // ---------- WiFi (как в примере) ----------
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  // Если кадров мало - верни как было.
  WiFi.setSleep(false);
  // WiFi.setSleep(true);
  setCpuFrequencyMhz(240);

  Serial.print("WiFi connecting");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("");
  Serial.println("WiFi connected");

  // Инициализация SD-карты
  initSDCard();

  if (!videoManager.begin()) {
      Serial.println("VideoManager init failed! Recording will be disabled.");
  }

  // ---------- WEBSOCKET ----------
  startWebSocketClient();

  Serial.printf("📶 RSSI: %d dBm\n", WiFi.RSSI());

  Serial.print("Camera Ready! Streamming to ws://");
  Serial.print(WEBSOCKET_HOST);
  Serial.println("/esp_service/ws/camera");
}

// --- ОСНОВНОЙ ЦИКЛ (управление камерой) ---
void loop() {
    Serial.printf("Free heap: %d bytes\n", ESP.getFreeHeap());
    videoManager.checkRecordTimeout();  // ← проверяем таймаут записи

    if (videoManager.timeoutOccurred()) {
        stopCamera();
        toggleFan(false);
        // setCpuFrequencyMhz(80);
        if (isConnected && isAuthenticated) {  // ← добавить проверку
            webSocket.sendTXT("record:stopped:timeout");
        }
    }

    if (isConnected && isAuthenticated && !isStreamActive && !videoManager.isRecording()) {
        videoManager.processQueue();
    }

    delay(5000);
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