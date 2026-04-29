#include "esp_camera.h"
#include <WiFi.h>
#include <WebSocketsClient_Generic.h>
#include <Preferences.h>
#include "VideoManager.h"
#include "config.h"
#include "freertos/queue.h"
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

// State machine:
//   IDLE      - camera powered down, uploadTask may run
//   STREAMING - camera -> streamQueue -> wsTask sends frames via WS
//   RECORDING - camera -> recordQueue -> sdTask writes to SD, WS alive for commands
typedef enum { STATE_IDLE, STATE_STREAMING, STATE_RECORDING } SystemState;
volatile SystemState systemState = STATE_IDLE;

Preferences preferences;
VideoManager videoManager(CAMERA_ID, ACCESS_KEY, HTTP_HOST);
WebSocketsClient webSocket;

bool fanState = true;
volatile bool isConnected     = false;
volatile bool isAuthenticated = false;
volatile bool sdWriteError    = false;  // sdTask -> wsTask: SD write failed
volatile bool uploadCancelled = false;  // wsTask -> uploadTask: abort current upload
volatile bool uploadError     = false;  // uploadTask -> wsTask: HTTP send failed

QueueHandle_t streamQueue;   // camera_fb_t* pumped by cameraTask, drained by wsTask
QueueHandle_t recordQueue;   // camera_fb_t* pumped by cameraTask, drained by sdTask
TaskHandle_t  wsTaskHandle;
TaskHandle_t  cameraTaskHandle;
TaskHandle_t  sdTaskHandle;
TaskHandle_t  uploadTaskHandle;

static volatile unsigned long frameCount = 0;
static unsigned long lastFpsLog = 0;

static int currentQualityMode       = 1;
static framesize_t currentFrameSize = FRAMESIZE_VGA;

static bool          cameraReady        = false; // true between cameraOn() and cameraOff()
static bool          cameraSettleNeeded = false; // true after esp_camera_deinit(); triggers pre-init delay
static volatile bool cameraCapturing    = false; // cameraTask sets this around esp_camera_fb_get()

void loadSettings();
void saveSettings();
void toggleFan(bool active);
bool cameraOn();
void cameraOff();
bool setFrameSize(const String& size, bool save = true);
void drainQueue(QueueHandle_t q);
float getTemperature();
void webSocketEvent(const WStype_t& type, uint8_t* payload, const size_t& length);
void wsTask(void* pvParameters);
void cameraTask(void* pvParameters);
void sdTask(void* pvParameters);
void uploadTask(void* pvParameters);

// Powers up and initializes the camera. Idempotent: safe to call when already on.
// After esp_camera_deinit() the I2C/SCCB bus needs time to recover: we hold PWDN
// HIGH for 500 ms before the init sequence so the driver's probe doesn't time out.
bool cameraOn() {
    if (cameraReady) return true;

    // If upload is active, abort it: the SSL context (~30-50 KB DRAM) must be
    // released before esp_camera_init() can allocate its 32 KB DMA buffers.
    if (videoManager.isUploading()) {
        Serial.println("Aborting upload for camera init");
        uploadCancelled = true;
        videoManager.requestAbort();
        unsigned long deadline = millis() + 10000;
        while (videoManager.isUploading() && millis() < deadline)
            vTaskDelay(pdMS_TO_TICKS(50));
        // Extra pause: let WiFiClientSecure destructor finish SSL cleanup.
        vTaskDelay(pdMS_TO_TICKS(300));
    }

    if (cameraSettleNeeded) {
        // PWDN is already HIGH (set by cameraOff). Hold it there long enough
        // for the I2C peripheral and OV2640 to fully settle after deinit.
        // 500 ms is empirically required on AI-Thinker; the driver's own 10 ms
        // PWDN cycle is not enough after a full deinit.
        vTaskDelay(pdMS_TO_TICKS(500));
        cameraSettleNeeded = false;
    }

    camera_config_t cfg = {};
    cfg.ledc_channel  = LEDC_CHANNEL_0;
    cfg.ledc_timer    = LEDC_TIMER_0;
    cfg.pin_d0        = Y2_GPIO_NUM;
    cfg.pin_d1        = Y3_GPIO_NUM;
    cfg.pin_d2        = Y4_GPIO_NUM;
    cfg.pin_d3        = Y5_GPIO_NUM;
    cfg.pin_d4        = Y6_GPIO_NUM;
    cfg.pin_d5        = Y7_GPIO_NUM;
    cfg.pin_d6        = Y8_GPIO_NUM;
    cfg.pin_d7        = Y9_GPIO_NUM;
    cfg.pin_xclk      = XCLK_GPIO_NUM;
    cfg.pin_pclk      = PCLK_GPIO_NUM;
    cfg.pin_vsync     = VSYNC_GPIO_NUM;
    cfg.pin_href      = HREF_GPIO_NUM;
    cfg.pin_sccb_sda  = SIOD_GPIO_NUM;
    cfg.pin_sccb_scl  = SIOC_GPIO_NUM;
    cfg.pin_pwdn      = PWDN_GPIO_NUM;
    cfg.pin_reset     = RESET_GPIO_NUM;
    cfg.xclk_freq_hz  = 20000000;
    cfg.pixel_format  = PIXFORMAT_JPEG;

    if (psramFound()) {
        cfg.frame_size   = FRAMESIZE_UXGA;
        cfg.jpeg_quality = 10;
        cfg.fb_count     = 3;
        cfg.grab_mode    = CAMERA_GRAB_LATEST;
        cfg.fb_location  = CAMERA_FB_IN_PSRAM;
    } else {
        cfg.frame_size   = FRAMESIZE_SVGA;
        cfg.jpeg_quality = 12;
        cfg.fb_count     = 1;
        cfg.grab_mode    = CAMERA_GRAB_WHEN_EMPTY;
        cfg.fb_location  = CAMERA_FB_IN_DRAM;
    }

    esp_err_t err = esp_camera_init(&cfg);
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

// Deinitializes the driver (frees heap/PSRAM) and holds PWDN HIGH.
// Must be called only after systemState is already STATE_IDLE.
void cameraOff() {
    if (!cameraReady) return;
    // cameraTask won't start new captures (STATE_IDLE). Wait for any in-flight capture.
    while (cameraCapturing) vTaskDelay(pdMS_TO_TICKS(5));
    esp_camera_deinit();
    pinMode(PWDN_GPIO_NUM, OUTPUT);
    digitalWrite(PWDN_GPIO_NUM, HIGH);
    cameraSettleNeeded = true;
    cameraReady = false;
    Serial.println("Camera OFF");
}

void toggleFan(bool active) {
    digitalWrite(FAN_PIN, (fanState && active) ? HIGH : LOW);
}

// Saves the new frame size. Applies to sensor immediately if camera is currently on.
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
    if (s) s->set_framesize(s, fs);  // no-op when camera is off

    if (save) saveSettings();
    return true;
}

void drainQueue(QueueHandle_t q) {
    camera_fb_t* fb;
    while (xQueueReceive(q, &fb, 0) == pdTRUE) {
        // Guard: after esp_camera_deinit() the frame pool is freed;
        // calling fb_return on it crashes with LoadProhibited.
        if (cameraReady) esp_camera_fb_return(fb);
    }
}

float getTemperature() {
    return temperatureRead();
}

// Runs inside wsTask on Core 0.
void webSocketEvent(const WStype_t& type, uint8_t* payload, const size_t& length) {
    switch (type) {

        case WStype_DISCONNECTED:
            isConnected     = false;
            isAuthenticated = false;
            if (systemState == STATE_RECORDING) videoManager.stopRecord();
            systemState     = STATE_IDLE;
            uploadCancelled = true;
            toggleFan(false);
            drainQueue(streamQueue);
            drainQueue(recordQueue);
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
                // Wake upload task immediately — there may be pending files from before reboot
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
                        drainQueue(streamQueue);
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

                    // Power on the camera (no-op if streaming, init from IDLE otherwise)
                    if (!cameraOn()) {
                        webSocket.sendTXT("record:error");
                        return;
                    }

                    unsigned long startTime = 0;
                    int col = part.indexOf(':');
                    if (col != -1) startTime = part.substring(col + 1).toInt();

                    uploadCancelled = true;

                    // Seamless transition from streaming: drain leftover frames first
                    if (systemState == STATE_STREAMING) {
                        drainQueue(streamQueue);
                        webSocket.sendTXT("stream_state:off");
                    }

                    // Drain any leftover frames in recordQueue before starting new recording
                    drainQueue(recordQueue);

                    // Switch to HD on-the-fly -- no camera reinit needed
                    sensor_t* s = esp_camera_sensor_get();
                    if (s) s->set_framesize(s, FRAMESIZE_HD);

                    systemState = STATE_RECORDING;
                    toggleFan(true);
                    frameCount = 0;

                    if (videoManager.startRecord(startTime)) {
                        webSocket.sendTXT("record:started");
                        Serial.println("RECORDING");
                    } else {
                        systemState = STATE_IDLE;
                        toggleFan(false);
                        cameraOff();
                        webSocket.sendTXT("record:error");
                    }
                }
                else if (part == "stop") {
                    if (systemState != STATE_RECORDING) {
                        webSocket.sendTXT("record:error:not_recording");
                        return;
                    }
                    if (videoManager.stopRecord()) {
                        webSocket.sendTXT("record:stopped");
                        Serial.printf("RECORDING stopped (%lu frames)\n", frameCount);
                    } else {
                        webSocket.sendTXT("record:error");
                    }
                    systemState = STATE_IDLE;
                    toggleFan(false);
                    drainQueue(recordQueue);
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

// Core 0, prio 5. Always alive.
// WiFi stack lives on Core 0 -- keeping WS here avoids cross-core I/O overhead.
void wsTask(void* pvParameters) {
    Serial.println("wsTask started (Core 0, prio 5)");
    // Not in WDT — SSL handshake can legitimately take 10-30s

    while (true) {
        webSocket.loop();

        if (sdWriteError) {
            sdWriteError = false;
            if (isConnected && isAuthenticated)
                webSocket.sendTXT("record:error:sd_write");
            // sdTask already set STATE_IDLE and called stopRecord().
            // Camera lifecycle (drain + off) is handled here so it runs on one task only.
            drainQueue(recordQueue);
            cameraOff();
            xTaskNotifyGive(uploadTaskHandle);
        }

        if (uploadError) {
            uploadError = false;
            if (isConnected && isAuthenticated)
                webSocket.sendTXT("upload:error");
        }

        if (systemState == STATE_STREAMING && isConnected && isAuthenticated) {
            camera_fb_t* fb;
            if (xQueueReceive(streamQueue, &fb, 0) == pdTRUE) {
                webSocket.sendBIN(fb->buf, fb->len, false);
                frameCount++;
                esp_camera_fb_return(fb);
            }
        }

        if (millis() - lastFpsLog >= 5000) {
            videoManager.checkRecordTimeout();
            if (videoManager.timeoutOccurred()) {
                systemState = STATE_IDLE;
                toggleFan(false);
                drainQueue(recordQueue);
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

        vTaskDelay(2 / portTICK_PERIOD_MS);
    }
}

// Core 1, prio 3. No WiFi stack competition -- pure camera hardware throughput.
// Drops frames rather than blocking if the consumer is slow.
void cameraTask(void* pvParameters) {
    Serial.println("cameraTask started (Core 1, prio 3)");
    esp_task_wdt_add(NULL);

    while (true) {
        esp_task_wdt_reset();

        SystemState state = systemState;
        if (state == STATE_IDLE) {
            vTaskDelay(20 / portTICK_PERIOD_MS);
            continue;
        }

        cameraCapturing = true;
        camera_fb_t* fb = esp_camera_fb_get();
        cameraCapturing = false;

        if (!fb) {
            vTaskDelay(5 / portTICK_PERIOD_MS);
            continue;
        }

        if (state == STATE_STREAMING) {
            if (xQueueSend(streamQueue, &fb, 0) != pdTRUE)
                esp_camera_fb_return(fb);
        } else if (state == STATE_RECORDING) {
            if (xQueueSend(recordQueue, &fb, 0) != pdTRUE)
                esp_camera_fb_return(fb);
        } else {
            esp_camera_fb_return(fb);
        }
    }
}

// Core 1, prio 2. NOT registered with WDT -- SD writes can legitimately stall.
// On failure: closes file, flags wsTask, goes IDLE.
void sdTask(void* pvParameters) {
    Serial.println("sdTask started (Core 1, prio 2)");

    while (true) {
        camera_fb_t* fb;
        if (xQueueReceive(recordQueue, &fb, pdMS_TO_TICKS(100)) == pdTRUE) {
            if (systemState == STATE_RECORDING) {
                if (videoManager.writeFrame(fb->buf, fb->len)) {
                    frameCount++;
                    esp_camera_fb_return(fb);
                } else {
                    Serial.println("SD write failed -- stopping record");
                    // Set IDLE first: shrinks the race window where wsTask also
                    // sees STATE_RECORDING and enters stopRecord() concurrently.
                    systemState = STATE_IDLE;
                    toggleFan(false);
                    esp_camera_fb_return(fb);   // camera still on here — safe
                    videoManager.stopRecord();
                    // drainQueue and cameraOff intentionally omitted: wsTask owns
                    // camera lifecycle and will handle them via sdWriteError below.
                    sdWriteError = true;
                }
            } else {
                // STATE_IDLE: camera may already be deinitialized by wsTask.
                if (cameraReady) esp_camera_fb_return(fb);
            }
        }
    }
}

// Core 1, prio 1.
// Wakes on notification (IDLE transition, AUTH_OK, SD error) OR every 30s autonomously.
// Keeps retrying failed uploads — notifies server on each failure via uploadError flag.
// Aborts between files when uploadCancelled (recording takes priority).
void uploadTask(void* pvParameters) {
    Serial.println("uploadTask started (Core 1, prio 1)");

    while (true) {
        // Wait for explicit notification or autonomous 30s check
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(30000));
        vTaskDelay(pdMS_TO_TICKS(8000));  // дать WS SSL-сессии полностью устояться

        if (systemState != STATE_IDLE || !isAuthenticated) continue;

        uploadCancelled = false;
        int pending = videoManager.pendingCount();
        if (pending == 0) continue;

        Serial.printf("Upload: %d file(s) pending\n", pending);

        while (systemState == STATE_IDLE && !uploadCancelled && isAuthenticated) {
            if (videoManager.pendingCount() == 0) break;

            bool ok = videoManager.processQueue();

            if (!ok) {
                uploadError = true;  // wsTask will send "upload:error" to server
                // Back off before retrying — don't hammer a failing server
                for (int i = 0; i < 10 && !uploadCancelled; i++)
                    vTaskDelay(pdMS_TO_TICKS(1000));
            } else {
                vTaskDelay(pdMS_TO_TICKS(200));
            }
        }

        Serial.println("Upload: done or interrupted");
    }
}

void setup() {
    Serial.begin(115200);
    Serial.setDebugOutput(true);

    ledcDetach(FAN_PIN);
    pinMode(FAN_PIN, OUTPUT);
    digitalWrite(FAN_PIN, LOW);

    // Keep camera powered down until first stream/record request.
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

    // Queues must exist before tasks start
    streamQueue = xQueueCreate(3, sizeof(camera_fb_t*));
    recordQueue = xQueueCreate(3, sizeof(camera_fb_t*));

    // Arduino core already inits TWDT — reconfigure with our timeout
    esp_task_wdt_config_t wdt_cfg = {
        .timeout_ms     = 15000,  // 15s: enough for SSL handshake
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

    // Core 0: WiFi stack + wsTask (prio 5) + uploadTask (prio 1) -- all network I/O
    // Core 1: cameraTask (prio 3) + sdTask (prio 2) -- all hardware I/O, no WiFi contention
    xTaskCreatePinnedToCore(wsTask,     "ws",     12288, NULL, 5, &wsTaskHandle,    0);
    xTaskCreatePinnedToCore(cameraTask, "cam",     8192, NULL, 3, &cameraTaskHandle, 1);
    xTaskCreatePinnedToCore(sdTask,     "sd",      8192, NULL, 2, &sdTaskHandle,     1);
    xTaskCreatePinnedToCore(uploadTask, "upload", 20480, NULL, 1, &uploadTaskHandle, 1);

    Serial.println("System ready");
}

void loop() {
    vTaskDelay(portMAX_DELAY);
}

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
