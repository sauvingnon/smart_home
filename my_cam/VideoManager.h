#ifndef VIDEO_MANAGER_H
#define VIDEO_MANAGER_H

#include <Arduino.h>
#include <FS.h>
#include <SD_MMC.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>

class VideoManager {
public:
    VideoManager(const char* cameraId, const char* accessKey, const char* serverUrl);
    bool begin();                     // инициализация SD, папок, загрузка JSON
    bool startRecord(unsigned long startTime = 0);  // начать запись (startTime = 0 - использовать своё время)
    bool writeFrame(uint8_t* data, size_t len);     // записать кадр
    bool stopRecord();                // завершить запись, сохранить запись в JSON
    void processQueue();              // отправить одно неотправленное видео (вызывать в loop)
    int pendingCount();               // количество неотправленных видео
    bool isRecording() const { return _recording; }
    bool isSDReady() const { return _sdReady; }
    void setStreamActive(bool active); // сообщить модулю, активен ли стрим (чтобы не отправлять во время записи)
    void setMaxRecordDuration(unsigned long seconds) { _maxRecordDuration = seconds; }
    void checkRecordTimeout();  // вызывать в loop()
    bool timeoutOccurred() { 
        bool ret = _timeoutOccurred; 
        _timeoutOccurred = false; 
        return ret; 
    }
    
private:
    bool _timeoutOccurred = false;
    String _cameraId;
    String _accessKey;
    String _serverUrl;
    bool _sdReady;
    bool _recording;
    bool _streamActive;
    File _currentFile;
    String _currentFileName;
    unsigned long _recordDuration;
    unsigned long _maxRecordDuration = 300;  // 5 минут по умолчанию
    unsigned long _recordStartTimestamp; // для переданного от сервера времени
    unsigned long _recordStartTime = 0;
    
    void addRecord(const String& filename, unsigned long startTime, unsigned long duration, size_t fileSize);
    void removeFirstLine();
    
    // Отправка одного файла
    bool sendVideo(const String& filename, unsigned long startTime, unsigned long duration, size_t fileSize);
    
    // Вспомогательные
    String getTimestampStr();             // для имени файла
    unsigned long getUnixTime();          // получить текущее время (NTP или из millis с коррекцией)
};

#endif