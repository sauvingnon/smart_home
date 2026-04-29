#include "esp_camera.h"
#include <WiFi.h>
#include <WebSocketsClient_Generic.h>
#include <Preferences.h>
#include "VideoManager.h"
#include "config.h"
#include "esp_task_wdt.h"

#define FAN_PIN 12

// AI-THINKER camera pins
#define PWDN_GPIO_NUM  32
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM   0
#define SIOD_GPIO_NUM  26
#define SIOC_GPIO_NUM  27
#define Y9_GPIO_NUM    35
#define Y8_GPIO_NUM    34
#define Y7_GPIO_NUM    39
#define Y6_GPIO_NUM    36
#define Y5_GPIO_NUM    21
#define Y4_GPIO_NUM    19
#define Y3_GPIO_NUM    18
#define Y2_GPIO_NUM     5
#define VSYNC_GPIO_NUM 25
#define HREF_GPIO_NUM  23
#define PCLK_GPIO_NUM  22

// State machine
typedef enum { STATE_IDLE, STATE_STREAMING, STATE_RECORDING } SystemState;
volatile SystemState systemState = STATE_IDLE;

Preferences preferences;
VideoManager videoManager(CAMERA_ID, ACCESS_KEY, HTTP_HOST);
WebSocketsClient webSocket;

bool fanState = true;
volatile bool isConnected     = false;
volatile bool isAuthenticated = false;
volatile bool uploadCancelled = false;
volatile bool uploadError     = false;

static volatile unsigned long frameCount = 0;
static unsigned long lastFpsLog = 0;

static int currentQualityMode = 1;
static framesize_t currentFrameSize = FRAMESIZE_VGA;

// Quality saved before recording starts; restored when recording ends
static int         preRecordQualityMode = 1;
static framesize_t preRecordFrameSize   = FRAMESIZE_VGA;

static bool cameraReady        = false;
static bool cameraSettleNeeded = false;

TaskHandle_t wsTaskHandle;
TaskHandle_t uploadTaskHandle;

// ──────────────────────────────────────────────────────────────
// Forward declarations
// ──────────────────────────────────────────────────────────────
void loadSettings();
void saveSettings();
void toggleFan(bool active);
bool cameraOn();
void cameraOff();
bool setFrameSize(const String& size, bool save = true);
float getTemperature();
void webSocketEvent(const WStype_t& type, uint8_t* payload, const size_t& length);
void wsTask(void* pvParameters);
void uploadTask(void* pvParameters);

// ──────────────────────────────────────────────────────────────
// Camera power management
//
// cameraOn() combines:
//   - original approach: explicit deinit-if-alive + PWDN LOW + 100ms before init
//   - current improvement: 500ms settle after previous deinit + 3-attempt retry loop
// ──────────────────────────────────────────────────────────────
bool cameraOn() {
    if (cameraReady) return true;

    // If an upload is running, abort it: SSL context (~30-50 KB DRAM) must be
    // freed before esp_camera_init() can allocate its DMA buffers.
    if (videoManager.isUploading()) {
        Serial.println("Aborting upload for camera init");
        uploadCancelled = true;
        videoManager.requestAbort();
        unsigned long deadline = millis() + 10000;
        while (videoManager.isUploading() && millis() < deadline)
            vTaskDelay(pdMS_TO_TICKS(50));
        vTaskDelay(pdMS_TO_TICKS(300));
    }

    // Deinit if somehow still alive (e.g. failed init attempt left driver half-started)
    if (esp_camera_sensor_get()) {
        esp_camera_deinit();
        vTaskDelay(pdMS_TO_TICKS(100));
    }

    // After esp_camera_deinit() the SCCB/I2C bus needs time to fully release.
    if (cameraSettleNeeded) {
        vTaskDelay(pdMS_TO_TICKS(500));
        cameraSettleNeeded = false;
    }

    // Power on: drive PWDN LOW and let OV2640 stabilise
    pinMode(PWDN_GPIO_NUM, OUTPUT);
    digitalWrite(PWDN_GPIO_NUM, LOW);
    vTaskDelay(pdMS_TO_TICKS(100));

    camera_config_t cfg = {};
    cfg.ledc_channel = LEDC_CHANNEL_0;
    cfg.ledc_timer   = LEDC_TIMER_0;
    cfg.pin_d0       = Y2_GPIO_NUM;
    cfg.pin_d1       = Y3_GPIO_NUM;
    cfg.pin_d2       = Y4_GPIO_NUM;
    cfg.pin_d3       = Y5_GPIO_NUM;
    cfg.pin_d4       = Y6_GPIO_NUM;
    cfg.pin_d5       = Y7_GPIO_NUM;
    cfg.pin_d6       = Y8_GPIO_NUM;
    cfg.pin_d7       = Y9_GPIO_NUM;
    cfg.pin_xclk     = XCLK_GPIO_NUM;
    cfg.pin_pclk     = PCLK_GPIO_NUM;
    cfg.pin_vsync    = VSYNC_GPIO_NUM;
    cfg.pin_href     = HREF_GPIO_NUM;
    cfg.pin_sccb_sda = SIOD_GPIO_NUM;
    cfg.pin_sccb_scl = SIOC_GPIO_NUM;
    cfg.pin_pwdn     = PWDN_GPIO_NUM;
    cfg.pin_reset    = RESET_GPIO_NUM;
    cfg.xclk_freq_hz = 20000000;
    cfg.pixel_format = PIXFORMAT_JPEG;

    if (psramFound()) {
        cfg.frame_size   = FRAMESIZE_UXGA;
        cfg.jpeg_quality = 20;           // ~28-32KB per HD frame → ~55ms write → ~18fps
        cfg.fb_count     = 2;            // 2 is enough for single-task inline pipeline
        cfg.grab_mode    = CAMERA_GRAB_LATEST;
        cfg.fb_location  = CAMERA_FB_IN_PSRAM;
    } else {
        cfg.frame_size   = FRAMESIZE_SVGA;
        cfg.jpeg_quality = 12;
        cfg.fb_count     = 1;
        cfg.grab_mode    = CAMERA_GRAB_WHEN_EMPTY;
        cfg.fb_location  = CAMERA_FB_IN_DRAM;
    }

    esp_err_t err = ESP_FAIL;
    for (int attempt = 0; attempt < 3 && err != ESP_OK; attempt++) {
        if (attempt > 0) {
            Serial.printf("Camera init retry %d/3\n", attempt);
            vTaskDelay(pdMS_TO_TICKS(1000));
        }
        err = esp_camera_init(&cfg);
    }

    if (err != ESP_OK) {
        Serial.printf("Camera init failed: 0x%x\n", err);
        return false;
    }

    sensor_t* s = esp_camera_sensor_get();
    if (s && s->id.PID == OV3660_PID) {
        s->set_vflip(s, 0);
        s->set_brightness(s, 1);
        s->set_saturation(s, -2);
    }
    if (s) s->set_framesize(s, currentFrameSize);

    cameraReady = true;
    Serial.println("Camera ON");
    return true;
}

void cameraOff() {
    if (!cameraReady) return;
    esp_camera_deinit();
    vTaskDelay(pdMS_TO_TICKS(50));
    pinMode(PWDN_GPIO_NUM, OUTPUT);
    digitalWrite(PWDN_GPIO_NUM, HIGH);
    cameraSettleNeeded = true;
    cameraReady = false;
    Serial.println("Camera OFF");
}

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────
void toggleFan(bool active) {
    digitalWrite(FAN_PIN, (fanState && active) ? HIGH : LOW);
}

bool setFrameSize(const String& size, bool save) {
    framesize_t fs;
    int mode;
    if      (size == "QVGA") { fs = FRAMESIZE_QVGA; mode = 0; }
    else if (size == "VGA")  { fs = FRAMESIZE_VGA;  mode = 1; }
    else if (size == "HD")   { fs = FRAMESIZE_HD;   mode = 2; }
    else return false;

    currentFrameSize   = fs;
    currentQualityMode = mode;

    sensor_t* s = esp_camera_sensor_get();
    if (s) s->set_framesize(s, fs);

    if (save) saveSettings();
    return true;
}

float getTemperature() {
    return temperatureRead();
}

// ──────────────────────────────────────────────────────────────
// WebSocket events — runs inside wsTask on Core 0
// ──────────────────────────────────────────────────────────────
void webSocketEvent(const WStype_t& type, uint8_t* payload, const size_t& length) {
    switch (type) {

        case WStype_DISCONNECTED:
            isConnected = isAuthenticated = false;
            if (systemState == STATE_RECORDING) {
                videoManager.stopRecord();
                currentFrameSize   = preRecordFrameSize;
                currentQualityMode = preRecordQualityMode;
            }
            systemState     = STATE_IDLE;
            uploadCancelled = true;
            toggleFan(false);
            cameraOff();
            Serial.println("WS Disconnected -> IDLE");
            break;

        case WStype_CONNECTED:
            isConnected = true;
            webSocket.sendTXT("AUTH:" + String(ACCESS_KEY) + ":" + String(CAMERA_ID));
            Serial.println("WS Connected, auth sent");
            break;

        case WStype_TEXT: {
            String cmd = (char*)payload;

            if (cmd == "AUTH_OK") {
                isAuthenticated = true;
                Serial.println("Auth OK");
                xTaskNotifyGive(uploadTaskHandle);
            }
            else if (cmd.startsWith("size:")) {
                if (systemState == STATE_RECORDING) {
                    webSocket.sendTXT("size:error:recording_active");
                    return;
                }
                webSocket.sendTXT(setFrameSize(cmd.substring(5)) ? "size:ok" : "size:error");
            }
            else if (cmd.startsWith("stream_state:")) {
                if (systemState == STATE_RECORDING) {
                    webSocket.sendTXT("stream_state:error:recording_active");
                    return;
                }
                String val = cmd.substring(13);
                if (val == "on") {
                    if (systemState != STATE_STREAMING) {
                        if (!cameraOn()) {
                            webSocket.sendTXT("stream_state:error");
                            return;
                        }
                        systemState = STATE_STREAMING;
                        toggleFan(true);
                        Serial.println("STREAMING");
                    }
                    webSocket.sendTXT("stream_state:ok");
                } else if (val == "off") {
                    if (systemState == STATE_STREAMING) {
                        systemState = STATE_IDLE;
                        toggleFan(false);
                        cameraOff();
                        xTaskNotifyGive(uploadTaskHandle);
                        Serial.println("IDLE");
                    }
                    webSocket.sendTXT("stream_state:ok");
                } else {
                    webSocket.sendTXT("stream_state:error");
                }
            }
            else if (cmd.startsWith("fan:")) {
                String fc = cmd.substring(4);
                if (fc == "on") {
                    fanState = true;
                    if (systemState != STATE_IDLE) toggleFan(true);
                    saveSettings();
                    webSocket.sendTXT("fan:ok");
                } else if (fc == "off") {
                    fanState = false;
                    toggleFan(false);
                    saveSettings();
                    webSocket.sendTXT("fan:ok");
                }
            }
            else if (cmd.startsWith("record:")) {
                String part = cmd.substring(7);

                if (part.startsWith("start")) {
                    if (!videoManager.isSDReady()) {
                        webSocket.sendTXT("record:error:no_sd");
                        return;
                    }
                    if (systemState == STATE_RECORDING) {
                        webSocket.sendTXT("record:error:already");
                        return;
                    }

                    unsigned long startTime = 0;
                    int col = part.indexOf(':');
                    if (col != -1) startTime = part.substring(col + 1).toInt();

                    uploadCancelled = true;

                    // Stop stream first, then reinit at HD — same approach as original.
                    // Full reinit is more reliable than on-the-fly framesize change.
                    if (systemState == STATE_STREAMING) {
                        cameraOff();
                        webSocket.sendTXT("stream_state:off");
                    }

                    // Save current quality so it can be restored after recording ends
                    preRecordFrameSize   = currentFrameSize;
                    preRecordQualityMode = currentQualityMode;

                    currentFrameSize   = FRAMESIZE_HD;
                    currentQualityMode = 2;

                    if (!cameraOn()) {
                        currentFrameSize   = preRecordFrameSize;
                        currentQualityMode = preRecordQualityMode;
                        webSocket.sendTXT("record:error");
                        return;
                    }

                    toggleFan(true);
                    frameCount = 0;

                    if (videoManager.startRecord(startTime)) {
                        systemState = STATE_RECORDING;
                        webSocket.sendTXT("record:started");
                        Serial.println("RECORDING");
                    } else {
                        cameraOff();
                        toggleFan(false);
                        currentFrameSize   = preRecordFrameSize;
                        currentQualityMode = preRecordQualityMode;
                        webSocket.sendTXT("record:error");
                    }
                }
                else if (part == "stop") {
                    if (systemState != STATE_RECORDING) {
                        webSocket.sendTXT("record:error:not_recording");
                        return;
                    }
                    systemState        = STATE_IDLE;
                    toggleFan(false);
                    currentFrameSize   = preRecordFrameSize;
                    currentQualityMode = preRecordQualityMode;
                    if (videoManager.stopRecord()) {
                        webSocket.sendTXT("record:stopped");
                        Serial.printf("Stopped (%lu frames)\n", frameCount);
                    } else {
                        webSocket.sendTXT("record:error");
                    }
                    cameraOff();
                    xTaskNotifyGive(uploadTaskHandle);
                    Serial.println("IDLE");
                }
            }
            else if (cmd == "queue:status") {
                webSocket.sendTXT("queue:count:" + String(videoManager.pendingCount()));
            }
            break;
        }

        default: break;
    }
}

// ──────────────────────────────────────────────────────────────
// wsTask — Core 1, prio 5
//
// Handles WebSocket, camera capture, and SD write inline.
// Single tight loop: no queue overhead, no cross-task frame passing.
//
// With fb_count=2 and GRAB_LATEST: while wsTask writes frame N to SD,
// the camera driver captures frame N+1 into the second buffer. After
// fb_return(N), fb_get() returns N+1 immediately (already ready).
// Core 1 keeps SD writes away from WiFi task (prio 23) on Core 0.
// ──────────────────────────────────────────────────────────────
void wsTask(void* pvParameters) {
    Serial.println("wsTask started (Core 1, prio 5)");

    while (true) {
        webSocket.loop();

        if (uploadError) {
            uploadError = false;
            if (isConnected && isAuthenticated)
                webSocket.sendTXT("upload:error");
        }

        if (isConnected && isAuthenticated) {
            if (systemState == STATE_RECORDING) {
                camera_fb_t* fb = esp_camera_fb_get();
                if (fb) {
                    if (!videoManager.writeFrame(fb->buf, fb->len)) {
                        // SD write failed — stop recording, power down camera, go IDLE
                        esp_camera_fb_return(fb);
                        systemState        = STATE_IDLE;
                        toggleFan(false);
                        currentFrameSize   = preRecordFrameSize;
                        currentQualityMode = preRecordQualityMode;
                        videoManager.stopRecord();
                        cameraOff();
                        xTaskNotifyGive(uploadTaskHandle);
                        webSocket.sendTXT("record:error:write_failed");
                    } else {
                        frameCount++;
                        esp_camera_fb_return(fb);
                    }
                }
            } else if (systemState == STATE_STREAMING) {
                camera_fb_t* fb = esp_camera_fb_get();
                if (fb) {
                    webSocket.sendBIN(fb->buf, fb->len, false);
                    frameCount++;
                    esp_camera_fb_return(fb);
                }
            }
        }

        // ── 5-second telemetry + timeout check ──
        if (millis() - lastFpsLog >= 5000) {
            esp_task_wdt_reset();  // сброс WDT: раз в 5с, задолго до лимита 60с
            videoManager.checkRecordTimeout();
            if (videoManager.timeoutOccurred() && systemState == STATE_RECORDING) {
                systemState        = STATE_IDLE;
                toggleFan(false);
                currentFrameSize   = preRecordFrameSize;
                currentQualityMode = preRecordQualityMode;
                cameraOff();
                xTaskNotifyGive(uploadTaskHandle);
                if (isConnected && isAuthenticated)
                    webSocket.sendTXT("record:stopped:timeout");
                Serial.println("Record timeout -> IDLE");
            }

            if (isConnected && isAuthenticated) {
                String msg = "fps:"           + String(frameCount / 5)
                           + ";quality_mode:" + String(currentQualityMode)
                           + ";tmp:"          + String(getTemperature(), 1)
                           + ";state:"        + String((int)systemState)
                           + ";fan:"          + String(fanState ? 1 : 0)
                           + ";heap:"         + String(ESP.getFreeHeap());
                webSocket.sendTXT(msg);
                Serial.printf("Report: %s\n", msg.c_str());
            }
            frameCount = 0;
            lastFpsLog = millis();
        }

        // Only delay when idle — during capture fb_get() already yields the CPU
        if (systemState == STATE_IDLE)
            vTaskDelay(pdMS_TO_TICKS(10));
    }
}

// ──────────────────────────────────────────────────────────────
// uploadTask — Core 0, prio 1
//
// Wakes on notification (record stop, stream stop, AUTH_OK) or every 30s.
// Sends queued videos in the background while system is IDLE.
// ──────────────────────────────────────────────────────────────
void uploadTask(void* pvParameters) {
    Serial.println("uploadTask started (Core 0, prio 1)");

    while (true) {
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(30000));
        vTaskDelay(pdMS_TO_TICKS(5000));  // let WS SSL session fully settle

        if (systemState != STATE_IDLE || !isAuthenticated) continue;

        uploadCancelled = false;
        if (videoManager.pendingCount() == 0) continue;

        Serial.printf("Upload: %d file(s) pending\n", videoManager.pendingCount());

        while (systemState == STATE_IDLE && !uploadCancelled && isAuthenticated) {
            if (videoManager.pendingCount() == 0) break;

            bool ok = videoManager.processQueue();
            if (!ok) {
                uploadError = true;
                for (int i = 0; i < 10 && !uploadCancelled; i++)
                    vTaskDelay(pdMS_TO_TICKS(1000));
            } else {
                vTaskDelay(pdMS_TO_TICKS(200));
            }
        }

        Serial.println("Upload done or interrupted");
    }
}

// ──────────────────────────────────────────────────────────────
// setup / loop
// ──────────────────────────────────────────────────────────────
void setup() {
    Serial.begin(115200);
    Serial.setDebugOutput(true);

    ledcDetach(FAN_PIN);
    pinMode(FAN_PIN, OUTPUT);
    digitalWrite(FAN_PIN, LOW);

    // Keep camera powered down until first stream/record request
    pinMode(PWDN_GPIO_NUM, OUTPUT);
    digitalWrite(PWDN_GPIO_NUM, HIGH);

    loadSettings();

    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    WiFi.setSleep(false);
    setCpuFrequencyMhz(240);

    Serial.print("WiFi connecting");
    while (WiFi.status() != WL_CONNECTED) {
        delay(500);
        Serial.print(".");
    }
    Serial.printf("\nWiFi connected, RSSI: %d dBm\n", WiFi.RSSI());

    if (!videoManager.begin())
        Serial.println("VideoManager init failed -- recording disabled");

    esp_task_wdt_config_t wdt_cfg = {
        .timeout_ms     = 60000,  // 60s: перезагрузка если плата зависла на минуту
        .idle_core_mask = 0,
        .trigger_panic  = true,
    };
    esp_task_wdt_reconfigure(&wdt_cfg);

    if (WEBSOCKET_PORT == 443)
        webSocket.beginSslWithCA(WEBSOCKET_HOST, WEBSOCKET_PORT, WEB_SOCKET_ENDPOINT, NULL, "wss");
    else
        webSocket.begin(WEBSOCKET_HOST, WEBSOCKET_PORT, WEB_SOCKET_ENDPOINT);
    webSocket.onEvent(webSocketEvent);
    webSocket.setReconnectInterval(2000);

    // wsTask on Core 1: camera capture + SD write run without WiFi stack preemption.
    // WiFi task (prio 23) lives on Core 0 — if wsTask were there too it would interrupt
    // SD writes repeatedly, adding ~30-50ms per frame and halving recording FPS.
    // uploadTask stays on Core 0 where HTTP/SSL naturally belongs.
    xTaskCreatePinnedToCore(wsTask,     "ws",     12288, NULL, 5, &wsTaskHandle,     1);
    xTaskCreatePinnedToCore(uploadTask, "upload", 20480, NULL, 1, &uploadTaskHandle, 0);
    esp_task_wdt_add(wsTaskHandle);  // перезагрузка если wsTask завис дольше 60 секунд

    Serial.println("System ready");
}

void loop() {
    vTaskDelay(portMAX_DELAY);
}

// ──────────────────────────────────────────────────────────────
// Settings persistence (NVS)
// ──────────────────────────────────────────────────────────────
void loadSettings() {
    preferences.begin("camera", false);
    fanState           = preferences.getBool("fanState",   true);
    currentQualityMode = preferences.getInt("qualityMode", 1);
    preferences.end();

    switch (currentQualityMode) {
        case 0:  currentFrameSize = FRAMESIZE_QVGA; break;
        case 2:  currentFrameSize = FRAMESIZE_HD;   break;
        default: currentQualityMode = 1;
        case 1:  currentFrameSize = FRAMESIZE_VGA;  break;
    }
    Serial.printf("Loaded: fan=%d, quality=%d\n", fanState, currentQualityMode);
}

void saveSettings() {
    preferences.begin("camera", false);
    preferences.putBool("fanState",   fanState);
    preferences.putInt("qualityMode", currentQualityMode);
    preferences.end();
}
