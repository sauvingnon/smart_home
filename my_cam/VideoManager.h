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
    bool processQueue();              // отправить одно неотправленное видео; true = успех, false = ошибка/пусто
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
    void requestAbort();                        // прервать текущую отправку после текущего чанка
    bool isUploading() const { return _uploading; }

    static const int    MAX_QUEUE_FAILS  = 20;    // consecutive send failures before discarding
    static const size_t MIN_RECORD_SIZE  = 1024;  // bytes — below this the recording is invalid

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
    String _lastQueueFile  = "";  // filename at the head of queue during current upload attempts
    int    _queueFailCount = 0;   // consecutive send failures for _lastQueueFile
    volatile bool _uploading       = false; // true while sendVideo() is active
    volatile bool _abortRequested  = false; // set by requestAbort(); checked between chunks
    portMUX_TYPE  _stopMux = portMUX_INITIALIZER_UNLOCKED; // guards _recording in stopRecord()
    
    void addRecord(const String& filename, unsigned long startTime, unsigned long duration, size_t fileSize);
    void removeFirstLine();
    
    // Отправка одного файла
    bool sendVideo(const String& filename, unsigned long startTime, unsigned long duration, size_t fileSize);
    String urlEncode(const String& str);
    
    // Вспомогательные
    String getTimestampStr();             // для имени файла
    unsigned long getUnixTime();          // получить текущее время (NTP или из millis с коррекцией)
};

#endif