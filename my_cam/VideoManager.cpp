#include "VideoManager.h"
#include <WiFi.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>

VideoManager::VideoManager(const char* cameraId, const char* accessKey, const char* serverUrl)
    : _cameraId(cameraId), _accessKey(accessKey), _serverUrl(serverUrl),
      _recording(false), _streamActive(false), _recordStartTime(0), _recordDuration(0), _recordStartTimestamp(0) {}

bool VideoManager::begin() {
    _sdReady = false;
    
    // Сначала монтируем SD
    if (!SD_MMC.begin("/sdcard", true)) {
        Serial.println("SD Card mount failed in VideoManager");
        return false;
    }
    
    // Потом проверяем тип карты
    if (SD_MMC.cardType() == CARD_NONE) {
        Serial.println("No SD card found, recording disabled");
        return false;
    }
    
    _sdReady = true;
    
    // Создать папку для видео, если нет
    if (!SD_MMC.exists("/videos")) {
        if (!SD_MMC.mkdir("/videos")) {
            Serial.println("Failed to create /videos folder");
            return false;
        }
    }
    
    return true;
}


void VideoManager::addRecord(const String& filename, unsigned long startTime, unsigned long duration, size_t fileSize) {
    File queueFile = SD_MMC.open("/queue.txt", FILE_APPEND);
    if (!queueFile) {
        Serial.println("❌ Cannot open queue.txt for append");
        return;
    }
    
    queueFile.printf("%s,%lu,%lu,%zu,0\n", filename.c_str(), startTime, duration, fileSize);
    queueFile.close();
    
    Serial.printf("✅ Queued: %s\n", filename.c_str());
}

String VideoManager::getTimestampStr() {
    // Простейший вариант: использовать millis() как уникальное число, но лучше NTP.
    // Пока сделаем на основе millis().
    unsigned long now = millis();
    char buf[20];
    snprintf(buf, sizeof(buf), "%lu", now);
    return String(buf);
}

unsigned long VideoManager::getUnixTime() {
    // Здесь можно запросить время через NTP или получать от сервера.
    // Пока возвращаем millis() как заменитель.
    return millis();
}

bool VideoManager::startRecord(unsigned long startTime) {
    if (!_sdReady) {
        Serial.println("SD card not ready");
        return false;
    }
    
    if (_recording) {
        Serial.println("Already recording");
        return false;
    }
    
    // Если передан 0, используем своё время
    if (startTime == 0) {
        startTime = getUnixTime();
    }
    
    // Создаём имя файла с переданным временем
    _currentFileName = "/videos/" + _cameraId + "_" + String(startTime) + ".mjpeg";
    _currentFile = SD_MMC.open(_currentFileName, FILE_WRITE);
    if (!_currentFile) {
        Serial.println("Failed to create video file");
        return false;
    }
    
    _recording = true;
    _recordStartTime = millis();  // ← для таймаута используем millis()
    _recordStartTimestamp = startTime;  // ← переименуем, чтобы не путать
    _recordDuration = 0;
    Serial.printf("Recording started: %s (startTime=%lu)\n", _currentFileName.c_str(), startTime);
    return true;
}

bool VideoManager::writeFrame(uint8_t* data, size_t len) {
    if (!_sdReady || !_recording || !_currentFile) return false;
    size_t written = _currentFile.write(data, len);
    if (written != len) {
        Serial.println("Write error during recording");
        // Не останавливаем запись, но сообщаем об ошибке
        return false;
    }
    return true;
}

bool VideoManager::stopRecord() {
    if (!_sdReady || !_recording) return false;
    
    _currentFile.close();
    
    unsigned long duration = (millis() - _recordStartTime) / 1000;
    
    // Проверяем существование файла
    if (!SD_MMC.exists(_currentFileName)) {
        Serial.printf("❌ File NOT found: %s\n", _currentFileName.c_str());
        _recording = false;
        return false;
    }
    
    File sizeFile = SD_MMC.open(_currentFileName, FILE_READ);
    size_t fileSize = sizeFile.size();
    sizeFile.close();
    
    Serial.printf("📝 Stopped: %s, duration=%lu, size=%zu\n", 
                  _currentFileName.c_str(), duration, fileSize);
    
    // Добавляем в очередь (просто пишем строку в файл)
    addRecord(_currentFileName, _recordStartTimestamp, duration, fileSize);
    
    _recording = false;
    
    // Проверяем очередь (читаем из файла)
    int queueSize = pendingCount();
    Serial.printf("✅ Queue size after stop: %d\n", queueSize);
    
    return true;
}

void VideoManager::processQueue() {
    if (_recording || _streamActive) return;
    
    File queueFile = SD_MMC.open("/queue.txt", FILE_READ);
    if (!queueFile) {
        // Нет файла или пустой
        return;
    }
    
    // Читаем первую строку
    String line = queueFile.readStringUntil('\n');
    queueFile.close();
    
    if (line.length() == 0) return;
    
    // Парсим: filename,startTime,duration,fileSize,sent
    int comma1 = line.indexOf(',');
    int comma2 = line.indexOf(',', comma1+1);
    int comma3 = line.indexOf(',', comma2+1);
    int comma4 = line.indexOf(',', comma3+1);
    
    if (comma1 == -1 || comma2 == -1 || comma3 == -1 || comma4 == -1) {
        Serial.println("❌ Invalid queue line");
        // Удаляем битую строку
        removeFirstLine();
        return;
    }
    
    String filename = line.substring(0, comma1);
    unsigned long startTime = line.substring(comma1+1, comma2).toInt();
    unsigned long duration = line.substring(comma2+1, comma3).toInt();
    size_t fileSize = line.substring(comma3+1, comma4).toInt();
    bool sent = line.substring(comma4+1).toInt() == 1;
    
    if (!sent) {
        Serial.printf("📤 Sending: %s\n", filename.c_str());
        if (sendVideo(filename, startTime, duration, fileSize)) {
            // Удаляем файл и строку из очереди
            SD_MMC.remove(filename);
            removeFirstLine();
            Serial.printf("✅ Sent: %s\n", filename.c_str());
        } else {
            // Отмечаем как отправленное? Нет, пробуем заново в следующий раз
            // Просто не удаляем строку
            Serial.printf("⚠️ Send failed: %s\n", filename.c_str());
        }
    } else {
        // Уже отправлено, удаляем строку
        removeFirstLine();
    }
}

void VideoManager::removeFirstLine() {
    File queueFile = SD_MMC.open("/queue.txt", FILE_READ);
    if (!queueFile) return;
    
    // Пропускаем первую строку
    queueFile.readStringUntil('\n');
    
    // Создаём новый файл без первой строки
    File tempFile = SD_MMC.open("/queue.tmp", FILE_WRITE);
    if (tempFile) {
        while (queueFile.available()) {
            tempFile.write(queueFile.read());
        }
        tempFile.close();
    }
    queueFile.close();
    
    // Заменяем старый файл новым
    SD_MMC.remove("/queue.txt");
    SD_MMC.rename("/queue.tmp", "/queue.txt");
}

bool VideoManager::sendVideo(const String& filename, unsigned long startTime, 
                             unsigned long duration, size_t fileSize) {
    if (_recording) return false;
    
    File file = SD_MMC.open(filename, FILE_READ);
    if (!file) {
        Serial.println("❌ Cannot open file for sending");
        return false;
    }
    
    size_t actualSize = file.size();
    if (actualSize == 0) {
        file.close();
        Serial.println("⚠️ Empty file, keeping for investigation");
        return true;
    }
    
    // Кодируем имя файла для URL
    String encodedFilename = urlEncode(filename.substring(filename.lastIndexOf('/') + 1));
    
    Serial.printf("📤 Sending %s (%zu bytes) in chunks...\n", filename.c_str(), actualSize);
    
    bool useSSL = _serverUrl.startsWith("https://");
    const size_t CHUNK_SIZE = 1024 * 1024;
    int totalChunks = (actualSize + CHUNK_SIZE - 1) / CHUNK_SIZE;
    size_t totalSent = 0;
    bool success = true;
    
    // Выделяем буфер один раз
    uint8_t* buffer = (uint8_t*)malloc(CHUNK_SIZE);
    if (!buffer) {
        Serial.println("❌ Failed to allocate buffer");
        file.close();
        return false;
    }
    
    for (int chunk = 1; chunk <= totalChunks && success; chunk++) {
        size_t chunkStart = (chunk - 1) * CHUNK_SIZE;
        size_t chunkSize = (chunk == totalChunks) ? (actualSize - chunkStart) : CHUNK_SIZE;
        
        // Повторные попытки для каждого чанка
        const int MAX_RETRIES = 3;
        bool chunkSuccess = false;
        
        for (int retry = 0; retry < MAX_RETRIES && !chunkSuccess; retry++) {
            if (retry > 0) {
                Serial.printf("🔄 Retry %d/%d for chunk %d\n", retry + 1, MAX_RETRIES, chunk);
                delay(1000 * retry);  // Экспоненциальная задержка
            }
            
            Serial.printf("📦 Chunk %d/%d (%zu bytes)\n", chunk, totalChunks, chunkSize);
            
            String url = _serverUrl + "/api/esp_service/video/upload_chunk"
                        + "?camera_id=" + _cameraId 
                        + "&start_time=" + String(startTime)
                        + "&duration=" + String(duration)
                        + "&chunk=" + String(chunk)
                        + "&total_chunks=" + String(totalChunks)
                        + "&filename=" + encodedFilename;
            
            int code = -1;
            
            // 🔥🔥🔥 ВОТ ТУТ ФИКС: client на стеке, без new/delete 🔥🔥🔥
            if (useSSL) {
                WiFiClientSecure client;
                client.setInsecure();
                HTTPClient http;
                http.begin(client, url);
                http.setTimeout(30000);
                http.addHeader("X-Access-Key", _accessKey);
                http.addHeader("Content-Type", "application/octet-stream");
                
                file.seek(chunkStart);
                size_t bytesRead = file.read(buffer, chunkSize);
                if (bytesRead > 0) {
                    code = http.POST(buffer, bytesRead);
                }
                http.end();
            } else {
                WiFiClient client;
                HTTPClient http;
                http.begin(client, url);
                http.setTimeout(30000);
                http.addHeader("X-Access-Key", _accessKey);
                http.addHeader("Content-Type", "application/octet-stream");
                
                file.seek(chunkStart);
                size_t bytesRead = file.read(buffer, chunkSize);
                if (bytesRead > 0) {
                    code = http.POST(buffer, bytesRead);
                }
                http.end();
            }
            
            if (code == 200) {
                totalSent += chunkSize;
                chunkSuccess = true;
                Serial.printf("✅ Chunk %d sent\n", chunk);
            } else {
                Serial.printf("❌ Chunk %d failed (HTTP %d)\n", chunk, code);
            }
        }
        
        if (!chunkSuccess) {
            success = false;
        }
        
        yield();
    }
    
    free(buffer);
    file.close();
    
    if (success && totalSent == actualSize) {
        Serial.printf("✅ Video fully sent: %s\n", filename.c_str());
        SD_MMC.remove(filename);
        return true;
    } else {
        Serial.printf("❌ Upload failed (sent %zu/%zu)\n", totalSent, actualSize);
        return false;
    }
}

// Вспомогательная функция для кодирования URL
String VideoManager::urlEncode(const String& str) {
    String encoded = "";
    char c;
    for (size_t i = 0; i < str.length(); i++) {
        c = str[i];
        if (isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
            encoded += c;
        } else {
            char hex[4];
            sprintf(hex, "%%%02X", c);
            encoded += hex;
        }
    }
    return encoded;
}

void VideoManager::setStreamActive(bool active) {
    _streamActive = active;
}

void VideoManager::checkRecordTimeout() {
    if (!_recording) return;
    
    unsigned long recordDuration = (millis() - _recordStartTime) / 1000;
    if (recordDuration >= _maxRecordDuration) {
        Serial.printf("⏱️ Recording timeout (%lu sec), auto-stopping...\n", recordDuration);
        stopRecord();
        _timeoutOccurred = true;
        // Можно отправить уведомление через WebSocket, но у нас нет доступа к webSocket
        // Лучше вернуть флаг или вызвать callback
    }
}

int VideoManager::pendingCount() {
    if (!SD_MMC.exists("/queue.txt")) return 0;
    
    File queueFile = SD_MMC.open("/queue.txt", FILE_READ);
    if (!queueFile) return 0;
    
    int count = 0;
    while (queueFile.available()) {
        String line = queueFile.readStringUntil('\n');
        if (line.length() == 0) continue;
        
        // Парсим только sent статус (последнее поле)
        int lastComma = line.lastIndexOf(',');
        if (lastComma != -1) {
            String sentStr = line.substring(lastComma + 1);
            sentStr.trim();
            if (sentStr == "0") {
                count++;
            }
        }
    }
    queueFile.close();
    return count;
}