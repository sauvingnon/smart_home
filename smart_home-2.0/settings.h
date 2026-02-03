#ifndef SETTINGS_H
#define SETTINGS_H

#include <Arduino.h>
#include <FS.h>
#include <ArduinoJson.h>

struct SettingsData {
  // Режим экрана (0-постоянный, 1-авто, 2-умный)
  byte displayMode = 1;
  
  // Дневное реле расписание
  byte dayOnHour = 8, dayOnMinute = 0;
  byte dayOffHour = 22, dayOffMinute = 0;
  
  // Ночное реле расписание  
  byte nightOnHour = 22, nightOnMinute = 0;
  byte nightOffHour = 8, nightOffMinute = 0;
  
  // Уборная расписание
  byte toiletOnHour = 8, toiletOnMinute = 0;
  byte toiletOffHour = 20, toiletOffMinute = 0;
  
  // Режим работы реле (false=авто, true=ручной)
  bool relayMode = false;
  
  // Ручное состояние (только если relayMode=true)
  bool manualDayState = false;
  bool manualNightState = false;
  
  // Время горения дисплея (секунды)
  byte displayTimeout = 30;
  
  // Вентилятор
  byte fanDelay = 60;     // секунд до включения
  byte fanDuration = 5;   // минут работы после выхода

  // Интернет
  bool offlineModeActive = false;
};

class Settings {
public:
  Settings();
  bool begin();
  bool load();
  bool save();
  
  // === БИНАРНЫЕ МЕТОДЫ (оставляем для совместимости) ===
  bool loadBinary();           // Загрузка бинарного файла
  bool saveBinary();           // Сохранение бинарного файла
  
  // === JSON МЕТОДЫ ===
  String toJSON(bool pretty = false);      // Настройки → JSON строка
  bool fromJSON(String json);              // JSON строка → настройки
  bool loadJSON();                         // Загрузка из JSON файла
  bool saveJSON();                         // Сохранение в JSON файл
  
  // === ГЕТТЕРЫ ===
  SettingsData getData() const { return data; }
  
  byte getDisplayMode() const { return data.displayMode; }
  
  byte getDayOnHour() const { return data.dayOnHour; }
  byte getDayOnMinute() const { return data.dayOnMinute; }
  byte getDayOffHour() const { return data.dayOffHour; }
  byte getDayOffMinute() const { return data.dayOffMinute; }
  
  byte getNightOnHour() const { return data.nightOnHour; }
  byte getNightOnMinute() const { return data.nightOnMinute; }
  byte getNightOffHour() const { return data.nightOffHour; }
  byte getNightOffMinute() const { return data.nightOffMinute; }
  
  byte getToiletOnHour() const { return data.toiletOnHour; }
  byte getToiletOnMinute() const { return data.toiletOnMinute; }
  byte getToiletOffHour() const { return data.toiletOffHour; }
  byte getToiletOffMinute() const { return data.toiletOffMinute; }
  
  bool getRelayMode() const { return data.relayMode; }
  bool getManualDayState() const { return data.manualDayState; }
  bool getManualNightState() const { return data.manualNightState; }
  
  byte getDisplayTimeout() const { return data.displayTimeout; }
  byte getFanDelay() const { return data.fanDelay; }
  byte getFanDuration() const { return data.fanDuration; }

  bool getOfflineMode() const { return data.offlineModeActive; }
  
  // === СЕТТЕРЫ ===
  void setData(const SettingsData& newData);
  
  void setDisplayMode(byte value);
  
  void setDaySchedule(byte onH, byte onM, byte offH, byte offM);
  void setNightSchedule(byte onH, byte onM, byte offH, byte offM);
  void setToiletSchedule(byte onH, byte onM, byte offH, byte offM);
  
  void setRelayMode(bool value);
  void setManualStates(bool dayState, bool nightState);
  
  void setDisplayTimeout(byte value);
  void setFanSettings(byte delaySec, byte durationMin);

  void setOfflineMode(bool offlineModeActive);
  
  // === СЛУЖЕБНЫЕ МЕТОДЫ ===
  void printToSerial();                    // Вывод в Serial
  bool resetToDefaults();                  // Сброс к значениям по умолчанию
  size_t getFileSize();                    // Размер файла на диске
  
private:
  SettingsData data;
  const char* binFilename = "/settings.bin";  // Бинарный файл
  const char* jsonFilename = "/settings.json"; // JSON файл
  
  void setDefaultValues();
  bool validateTime(byte hour, byte minute);
  bool validateData();                      // Проверка валидности данных
};

#endif