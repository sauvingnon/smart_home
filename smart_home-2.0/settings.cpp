#include "Settings.h"
#include <LittleFS.h>

Settings::Settings() {
  setDefaultValues();
}

bool Settings::begin() {
  if (!SPIFFS.begin()) {
    Serial.println("Ошибка инициализации SPIFFS");
    return false;
  }
  
  // Проверяем наличие файлов
  bool hasBin = SPIFFS.exists(binFilename);
  bool hasJson = SPIFFS.exists(jsonFilename);
  
  Serial.printf("Файлы настроек: bin=%s, json=%s\n", 
                hasBin ? "есть" : "нет", 
                hasJson ? "есть" : "нет");
  
  return true;
}

// === БИНАРНЫЕ МЕТОДЫ ===

bool Settings::load() {
  // По умолчанию пробуем загрузить из JSON
  if (loadJSON()) {
    Serial.println("Настройки загружены из JSON файла");
    return true;
  }
  
  // Если JSON нет, пробуем бинарный
  if (loadBinary()) {
    Serial.println("Настройки загружены из бинарного файла");
    return true;
  }
  
  Serial.println("Файлы настроек не найдены, используются значения по умолчанию");
  return false;
}

bool Settings::save() {
  // Сохраняем в оба формата для совместимости
  bool binOk = saveBinary();
  bool jsonOk = saveJSON();
  
  return binOk && jsonOk;
}

bool Settings::loadBinary() {
  File file = SPIFFS.open(binFilename, "r");
  if (!file) {
    return false;
  }
  
  size_t fileSize = file.size();
  if (fileSize != sizeof(SettingsData)) {
    Serial.printf("Неверный размер бинарного файла: %d (ожидалось: %d)\n", 
                  fileSize, sizeof(SettingsData));
    file.close();
    return false;
  }
  
  size_t bytesRead = file.readBytes((char*)&data, sizeof(SettingsData));
  file.close();
  
  if (bytesRead != sizeof(SettingsData)) {
    Serial.println("Ошибка чтения бинарного файла");
    return false;
  }
  
  return validateData();
}

bool Settings::saveBinary() {
  File file = SPIFFS.open(binFilename, "w");
  if (!file) {
    Serial.println("Ошибка открытия бинарного файла для записи");
    return false;
  }
  
  size_t bytesWritten = file.write((uint8_t*)&data, sizeof(SettingsData));
  file.close();
  
  if (bytesWritten != sizeof(SettingsData)) {
    Serial.println("Ошибка записи бинарного файла");
    return false;
  }
  
  return true;
}

// === JSON МЕТОДЫ ===

String Settings::toJSON(bool pretty) {
  // Создаем JSON документ (размер примерно 500 байт)
  DynamicJsonDocument doc(512);
  
  // Заполняем значениями
  doc["displayMode"] = data.displayMode;
  
  doc["dayOnHour"] = data.dayOnHour;
  doc["dayOnMinute"] = data.dayOnMinute;
  doc["dayOffHour"] = data.dayOffHour;
  doc["dayOffMinute"] = data.dayOffMinute;
  
  doc["nightOnHour"] = data.nightOnHour;
  doc["nightOnMinute"] = data.nightOnMinute;
  doc["nightOffHour"] = data.nightOffHour;
  doc["nightOffMinute"] = data.nightOffMinute;
  
  doc["toiletOnHour"] = data.toiletOnHour;
  doc["toiletOnMinute"] = data.toiletOnMinute;
  doc["toiletOffHour"] = data.toiletOffHour;
  doc["toiletOffMinute"] = data.toiletOffMinute;
  
  doc["relayMode"] = data.relayMode;
  doc["manualDayState"] = data.manualDayState;
  doc["manualNightState"] = data.manualNightState;
  
  doc["displayTimeout"] = data.displayTimeout;
  doc["fanDelay"] = data.fanDelay;
  doc["fanDuration"] = data.fanDuration;

  doc["offlineModeActive"] = data.offlineModeActive;
  
  // Сериализуем в строку
  String output;
  if (pretty) {
    serializeJsonPretty(doc, output);
  } else {
    serializeJson(doc, output);
  }
  
  return output;
}

bool Settings::fromJSON(String json) {
  // Проверяем размер JSON
  if (json.length() > 1024) {
    Serial.println("JSON слишком большой");
    return false;
  }
  
  // Парсим JSON
  DynamicJsonDocument doc(512);
  DeserializationError error = deserializeJson(doc, json);
  
  if (error) {
    Serial.print("Ошибка парсинга JSON: ");
    Serial.println(error.c_str());
    return false;
  }
  
  // Временная структура для валидации
  SettingsData newData = data; // Копируем текущие значения
  
  // Читаем значения (с проверкой наличия)
  if (doc.containsKey("displayMode")) 
    newData.displayMode = doc["displayMode"];
  
  if (doc.containsKey("dayOnHour")) newData.dayOnHour = doc["dayOnHour"];
  if (doc.containsKey("dayOnMinute")) newData.dayOnMinute = doc["dayOnMinute"];
  if (doc.containsKey("dayOffHour")) newData.dayOffHour = doc["dayOffHour"];
  if (doc.containsKey("dayOffMinute")) newData.dayOffMinute = doc["dayOffMinute"];
  
  if (doc.containsKey("nightOnHour")) newData.nightOnHour = doc["nightOnHour"];
  if (doc.containsKey("nightOnMinute")) newData.nightOnMinute = doc["nightOnMinute"];
  if (doc.containsKey("nightOffHour")) newData.nightOffHour = doc["nightOffHour"];
  if (doc.containsKey("nightOffMinute")) newData.nightOffMinute = doc["nightOffMinute"];
  
  if (doc.containsKey("toiletOnHour")) newData.toiletOnHour = doc["toiletOnHour"];
  if (doc.containsKey("toiletOnMinute")) newData.toiletOnMinute = doc["toiletOnMinute"];
  if (doc.containsKey("toiletOffHour")) newData.toiletOffHour = doc["toiletOffHour"];
  if (doc.containsKey("toiletOffMinute")) newData.toiletOffMinute = doc["toiletOffMinute"];
  
  if (doc.containsKey("relayMode")) newData.relayMode = doc["relayMode"];
  if (doc.containsKey("manualDayState")) newData.manualDayState = doc["manualDayState"];
  if (doc.containsKey("manualNightState")) newData.manualNightState = doc["manualNightState"];
  
  if (doc.containsKey("displayTimeout")) newData.displayTimeout = doc["displayTimeout"];
  if (doc.containsKey("fanDelay")) newData.fanDelay = doc["fanDelay"];
  if (doc.containsKey("fanDuration")) newData.fanDuration = doc["fanDuration"];

  if (doc.containsKey("offlineModeActive")) newData.offlineModeActive = doc["offlineModeActive"];
  
  // Валидируем данные
  data = newData;
  if (!validateData()) {
    setDefaultValues();
    return false;
  }
  
  return true;
}

bool Settings::loadJSON() {
  File file = SPIFFS.open(jsonFilename, "r");
  if (!file) {
    return false;
  }
  
  String jsonContent = file.readString();
  file.close();
  
  return fromJSON(jsonContent);
}

bool Settings::saveJSON() {
  String json = toJSON(true); // Красивый JSON с отступами
  
  File file = SPIFFS.open(jsonFilename, "w");
  if (!file) {
    Serial.println("Ошибка открытия JSON файла для записи");
    return false;
  }
  
  size_t bytesWritten = file.print(json);
  file.close();
  
  if (bytesWritten != json.length()) {
    Serial.println("Ошибка записи JSON файла");
    return false;
  }
  
  return true;
}

// === ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ===

void Settings::setDefaultValues() {
  data.displayMode = 1;
  
  data.dayOnHour = 8;
  data.dayOnMinute = 0;
  data.dayOffHour = 22;
  data.dayOffMinute = 0;
  
  data.nightOnHour = 22;
  data.nightOnMinute = 0;
  data.nightOffHour = 8;
  data.nightOffMinute = 0;
  
  data.toiletOnHour = 8;
  data.toiletOnMinute = 0;
  data.toiletOffHour = 20;
  data.toiletOffMinute = 0;
  
  data.relayMode = false;
  data.manualDayState = false;
  data.manualNightState = false;
  
  data.displayTimeout = 30;
  data.fanDelay = 60;
  data.fanDuration = 5;

  data.offlineModeActive = false;
}

bool Settings::validateData() {
  // Проверяем все значения на валидность
  if (data.displayMode > 2) return false;
  
  if (!validateTime(data.dayOnHour, data.dayOnMinute)) return false;
  if (!validateTime(data.dayOffHour, data.dayOffMinute)) return false;
  if (!validateTime(data.nightOnHour, data.nightOnMinute)) return false;
  if (!validateTime(data.nightOffHour, data.nightOffMinute)) return false;
  if (!validateTime(data.toiletOnHour, data.toiletOnMinute)) return false;
  if (!validateTime(data.toiletOffHour, data.toiletOffMinute)) return false;
  
  if (data.displayTimeout > 255) return false; // byte ограничение
  if (data.fanDelay > 255) return false;
  if (data.fanDuration > 255) return false;
  
  return true;
}

bool Settings::validateTime(byte hour, byte minute) {
  return (hour < 24 && minute < 60);
}

bool Settings::resetToDefaults() {
  setDefaultValues();
  return save();
}

size_t Settings::getFileSize() {
  if (SPIFFS.exists(jsonFilename)) {
    File file = SPIFFS.open(jsonFilename, "r");
    size_t size = file.size();
    file.close();
    return size;
  }
  return 0;
}

// === СЕТТЕРЫ ===

void Settings::setData(const SettingsData& newData) {
  // Копируем данные
  data = newData;
  
  // Валидируем
  if (!validateData()) {
    Serial.println("Предупреждение: установлены невалидные данные, сброс к значениям по умолчанию");
    setDefaultValues();
  }
}

void Settings::setDisplayMode(byte value) {
  if (value <= 2) {
    data.displayMode = value;
  } else {
    Serial.println("Ошибка: displayMode должен быть 0-2");
  }
}

void Settings::setDaySchedule(byte onH, byte onM, byte offH, byte offM) {
  if (validateTime(onH, onM) && validateTime(offH, offM)) {
    data.dayOnHour = onH;
    data.dayOnMinute = onM;
    data.dayOffHour = offH;
    data.dayOffMinute = offM;
  } else {
    Serial.println("Ошибка: невалидное время в дневном расписании");
  }
}

void Settings::setNightSchedule(byte onH, byte onM, byte offH, byte offM) {
  if (validateTime(onH, onM) && validateTime(offH, offM)) {
    data.nightOnHour = onH;
    data.nightOnMinute = onM;
    data.nightOffHour = offH;
    data.nightOffMinute = offM;
  } else {
    Serial.println("Ошибка: невалидное время в ночном расписании");
  }
}

void Settings::setToiletSchedule(byte onH, byte onM, byte offH, byte offM) {
  if (validateTime(onH, onM) && validateTime(offH, offM)) {
    data.toiletOnHour = onH;
    data.toiletOnMinute = onM;
    data.toiletOffHour = offH;
    data.toiletOffMinute = offM;
  } else {
    Serial.println("Ошибка: невалидное время в расписании уборной");
  }
}

void Settings::setRelayMode(bool value) {
  data.relayMode = value;
  // При переходе в авто-режим сбрасываем ручные состояния
  if (!value) {
    data.manualDayState = false;
    data.manualNightState = false;
  }
}

void Settings::setManualStates(bool dayState, bool nightState) {
  if (data.relayMode) {
    data.manualDayState = dayState;
    data.manualNightState = nightState;
  } else {
    Serial.println("Предупреждение: установка ручных состояний при выключенном ручном режиме");
  }
}

void Settings::setDisplayTimeout(byte value) {
  data.displayTimeout = value;
}

void Settings::setFanSettings(byte delaySec, byte durationMin) {
  data.fanDelay = delaySec;
  data.fanDuration = durationMin;
}

void Settings::setOfflineMode(bool offlineModeActive) {
  data.offlineModeActive = offlineModeActive;
}

// === СЛУЖЕБНЫЕ МЕТОДЫ ===

void Settings::printToSerial() {
  Serial.println("=== ТЕКУЩИЕ НАСТРОЙКИ ===");
  
  Serial.printf("Режим дисплея: %d (0-постоянный, 1-авто, 2-умный)\n", data.displayMode);
  
  Serial.println("\n--- Дневное реле ---");
  Serial.printf("  Включение: %02d:%02d\n", data.dayOnHour, data.dayOnMinute);
  Serial.printf("  Выключение: %02d:%02d\n", data.dayOffHour, data.dayOffMinute);
  
  Serial.println("\n--- Ночное реле ---");
  Serial.printf("  Включение: %02d:%02d\n", data.nightOnHour, data.nightOnMinute);
  Serial.printf("  Выключение: %02d:%02d\n", data.nightOffHour, data.nightOffMinute);
  
  Serial.println("\n--- Уборная ---");
  Serial.printf("  Включение: %02d:%02d\n", data.toiletOnHour, data.toiletOnMinute);
  Serial.printf("  Выключение: %02d:%02d\n", data.toiletOffHour, data.toiletOffMinute);
  
  Serial.println("\n--- Режимы ---");
  Serial.printf("  Режим реле: %s\n", data.relayMode ? "РУЧНОЙ" : "АВТО");
  if (data.relayMode) {
    Serial.printf("    Дневное состояние: %s\n", data.manualDayState ? "ВКЛ" : "ВЫКЛ");
    Serial.printf("    Ночное состояние: %s\n", data.manualNightState ? "ВКЛ" : "ВЫКЛ");
  }
  
  Serial.println("\n--- Параметры ---");
  Serial.printf("  Таймаут дисплея: %d сек\n", data.displayTimeout);
  Serial.printf("  Вентилятор: задержка %d сек, работа %d мин\n", 
                data.fanDelay, data.fanDuration);

  Serial.printf("    Оффлайн режим: %s\n", data.offlineModeActive ? "ВКЛ" : "ВЫКЛ");
  
  Serial.println("=====================");
}