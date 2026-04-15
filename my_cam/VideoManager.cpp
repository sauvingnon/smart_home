#include "VideoManager.h"

VideoManager::VideoManager(const char* cameraId, const char* accessKey, const char* serverUrl)
    : _cameraId(cameraId), _accessKey(accessKey), _serverUrl(serverUrl),
      _recording(false), _streamActive(false), _recordStartTime(0), _recordDuration(0), _recordStartTimestamp(0) {}

bool VideoManager::begin() {
    _sdReady = false;
    
    // Сначала монтируем SD
    if (!SD_MMC.begin()) {
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
    if (_recording) return;
    
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

// Упрощённая версия sendVideo (рекомендую):
bool VideoManager::sendVideo(const String& filename, unsigned long startTime, unsigned long duration, size_t fileSize) {
    if (_recording) return false;
    
    HTTPClient http;
    String url = _serverUrl + "/esp_service/upload_video?camera_id=" + _cameraId 
                + "&start_time=" + String(startTime)
                + "&duration=" + String(duration);
    
    bool useSSL = _serverUrl.startsWith("https://");
    
    if (useSSL) {
        WiFiClientSecure client;
        client.setInsecure();
        http.begin(client, url);
    } else {
        http.begin(url);
    }
    
    http.setTimeout(10000);
    // http.addHeader("X-Access-Key", _accessKey);
    http.addHeader("Content-Type", "video/mjpeg");
    
    File file = SD_MMC.open(filename, FILE_READ);
    if (!file) {
        Serial.println("❌ Cannot open file for sending");
        http.end();
        return false;
    }
    
    Serial.printf("📤 Sending %s (%zu bytes)...\n", filename.c_str(), file.size());
    
    int code = http.sendRequest("POST", &file, file.size());
    file.close();
    http.end();
    
    if (code == 200) {
        Serial.printf("✅ Video sent: %s\n", filename.c_str());
        return true;
    } else {
        Serial.printf("❌ HTTP %d for %s\n", code, filename.c_str());
        return false;
    }
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