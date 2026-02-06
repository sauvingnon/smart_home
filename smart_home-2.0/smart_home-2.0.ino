// Кодирование символов кириллицы
uint8_t bukva_P[8] = {0x1F, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11};
uint8_t bukva_Ya[8] = {B01111, B10001, B10001, B01111, B00101, B01001, B10001};
uint8_t bukva_L[8] = {0x3, 0x7, 0x5, 0x5, 0xD, 0x9, 0x19};
uint8_t bukva_Lm[8] = {0, 0, B01111, B00101, B00101, B10101, B01001};
uint8_t bukva_Mz[8] = {0x10, 0x10, 0x10, 0x1E, 0x11, 0x11, 0x1E};
uint8_t bukva_I[8] = {0x11, 0x13, 0x13, 0x15, 0x19, 0x19, 0x11};
uint8_t bukva_D[8] = {B01111, B00101, B00101, B01001, B10001, B11111, 0x11};
uint8_t bukva_G[8] = {B11111, B10001, B10000, B10000, B10000, B10000, B10000};
uint8_t bukva_IY[8] = {B01110, B00000, B10001, B10011, B10101, B11001, B10001};
uint8_t bukva_Z[8] = {B01110, B10001, B00001, B00010, B00001, B10001, B01110};
uint8_t bukva_ZH[8] = {B10101, B10101, B10101, B11111, B10101, B10101, B10101};
uint8_t bukva_Y[8] = {B10001, B10001, B10001, B01010, B00100, B01000, B10000};
uint8_t bukva_B[8] = {B11110, B10000, B10000, B11110, B10001, B10001, B11110};
uint8_t bukva_CH[8] = {B10001, B10001, B10001, B01111, B00001, B00001, B00001};
uint8_t bukva_IYI[8] = {B10001, B10001, B10001, B11001, B10101, B10101, B11001};
uint8_t bukva_TS[8] = {B10010, B10010, B10010, B10010, B10010, B10010, B11111, B00001};
uint8_t bukva_EE[8] = {B11111, B00001, B00001, B01111, B00001, B00001, B11111, B00000};
uint8_t bukva_F[8] = {B00100, B11111, B10101, B10101, B10101, B11111, B00100, B00000};
uint8_t bukva_SH[8] = { B10101, B10101, B10101, B10101, B10101, B10101, B11111, B00000};
// Кодирование символов градуса
uint8_t degree[8] = {B00111,B00101,B00111,B00000,B00000,B00000,B00000,};
// Кодируем символ разделителя минут и часов для крупных цифр 
uint8_t tochka[8] = {B00000,B00000,B00000,B01110,B01110,B01110,B00000,};

/* ========== ПОДКЛЮЧЕНИЕ БИБЛИОТЕК ========== */
// Подключение датчика температуры и влажности
// Библиотека для датчика температура и влажности
#include <Adafruit_AHT10.h> 
// Объявление датчика как обьекта
Adafruit_AHT10 myAHT10;   

// Подключение энкодера
// Ряд пинов для подключение энкодера
#define S1 D5                                  
#define S2 D6
#define KEY D7
// Подключение библиотеки для энкодера 
#include <GyverEncoder.h>
// Объявление энкодера как объекта
Encoder enc(S1, S2, KEY);

// Пин отслеживания состояние Bluetooth
const byte BLUETOOTH_STATE_PIN = A0; 

// Подключение кнопок
const byte GREEN_BUTTON_PIN = D8;
const byte YELLOW_BUTTON_PIN = D4;

 // Пин реле "Ночного света"
const int RelayNightPin = D3;
// Пин реле "Дневного света"
const int RelayDayPin = D0;

// Структура для кнопки
struct Button {
  // Последнее состояние
  bool lastState;
  // Ожидание отпускания 
  bool waitingRelease;
};

Button yellowBtn = {HIGH, false};
// Начальное состояние для зеленой - LOW
Button greenBtn = {LOW, false}; 

bool yellowPressed = false;
bool greenPressed = false;

// Подключение дисплея
// Второстепенная библиотека для модуля реального времени
#include <Wire.h>

//Библиотека для дисплея
#include <LiquidCrystal_I2C.h>
// Создание объекта дисплея
LiquidCrystal_I2C lcd(0x27, 20, 4);
// Библиотека для вывода крупных чисел
#include <bigNumbers.h>             
// Создание обьекта дисплея для крупных чисел
bigNumbers <LiquidCrystal_I2C> bigNumbersLcd(&lcd);

// Самописный модуль для работы с JSON
#include "Settings.h"
// Структура для замены EEPROM
Settings settings;

// Самописный модуль для взаимодействия с интернетом через MQTT брокер
#include "SimpleMQTTManager.h" 

// WiFi настройки
// const char* ssid = "TP-Link_297F";
// const char* password = "23598126";

const char* ssid = "TP-Link_8343";
const char* password = "64826424";

// MQTT брокер
const char* mqtt_server = "dotnetdon.ru";
// const char* mqtt_server = "192.168.1.102";

// Глобальные объекты
WiFiClient wifiClient;
SimpleMQTTManager mqtt(&wifiClient, mqtt_server, 1883, "mqtt_user", "tWl9w9FwMskvpv7");

// Топики на прием:
// Бекенд прислал погоду
const char* weather_topic = "greenhouse_01/weather";
// Бекенд прислал настройки
const char* set_config_topic = "greenhouse_01/config/set";
// Бекенд просит настройки
const char* get_config_topic = "greenhouse_01/config/get";
// Бекенд хочет отправить время
const char* set_time_topic = "greenhouse_01/time/set";

// На плате
struct WeatherData {
  int temp;
  int feels_like;
  String condition;
  int humidity;
  float wind_speed;
  
  // Прогноз
  int morning_temp;
  int day_temp;
  int evening_temp;
  int night_temp;
  
  // Время получения (сама плата ставит)
  unsigned long received_at;

  // Серверное время обновления
  String update_at;
  
  // Функция проверки срока годности
  bool isExpired() {
    return (millis() - received_at) > (2 * 60 * 60 * 1000UL); // 2 часа
  }
  
  // Функция проверки свежести (<30 минут)
  bool isFresh() {
    return (millis() - received_at) < (30 * 60 * 1000UL); // 30 минут
  }
};

WeatherData current_weather; // Текущая погода

// Библиотека для модуля реального времени
#include "RTClib.h"
// Объект модуля реального времени
RTC_DS1307 rtc;

// Структура для описания настраиваемого параметра времени
struct TimeParam {
  const char* label;      // Текст подписи (во второй строке)
  int minValue;           // Минимальное значение
  int maxValue;           // Максимальное значение
  int currentValue;       // Текущее значение
  byte xPos;              // Позиция X для отображения
  byte yPos;              // Позиция Y для отображения
  bool isDayOfWeek;       // Флаг дня недели
  bool isYear;            // Флаг года
  byte saveIndex;         // Индекс в массиве A для сохранения
};

// Переменные для вывода температуры и влажности.
int h, t;
// Переменные температуры и влажности но с типом float
float hf,tf;
// Переменные для вывода данных о времени
int Hour, Minute, Second, Date, Month, DayOf, Year;           

// Объявляем тип "Метка времени" для реле
struct RelaySchedule {
    byte startHour;
    byte startMinute;
    byte stopHour;
    byte stopMinute;
};

// Создаем экземпляры для каждого реле
RelaySchedule dayRelay;
RelaySchedule nightRelay;
RelaySchedule toiletRelay;

// Режим работы платы онлайн\оффлайн
boolean isOfflineModeActive;
// Для режима работы экрана
byte displayMode;
// Для хранения состояния режима работы ночного и дневного реле   
boolean isManualModeRelayEnabled;
// Переменные для сохранения ручных настроек работы реле              
boolean isNightRelayForcedOn, isDayRelayForcedOn;
// Для хранения времени работы дисплея в авто режиме
byte displayTimeoutSeconds;
// Время до включения вентилятора в секундах
byte fanDelay;
// Время после покидания уборной в минутах
byte fanDuration;

// Позиция курсора
int k;
// Для отрисовки изменений
boolean needRedraw;
// Таймер для подсчета времени бездействия и отключения дисплея по таймауту
int timer;

// Флаг для выхода, нужен для выхода из двойного меню сразу на домашнюю страницу
boolean exitFlag;

// Режимы отображения данных дисплея:
// Отображение времени
#define DISPLAY_MODE_TIME 0
// Отображение температуры улица\дома
#define DISPLAY_MODE_TEMP 1
// Отображение прогноза погоды
#define DISPLAY_MODE_FORECAST 2
// Таймаут для отображения каждого режима - 10 сек.
#define TIME_INTERVAL 10000
// Таймаут для опроса внутреннего датчика - 20 сек.
#define SENSOR_UPDATE_INTERVAL 20000
// Таймаут обновления дисплея - 1 сек.
#define DISPLAY_UPDATE_INTERVAL 1000

// Текущий режим отображения дисплея
uint8_t currentDisplayMode = DISPLAY_MODE_TIME; 
// Последнее переключение режима
unsigned long lastModeSwitch = 0; \
// Последнее считывание датчика
unsigned long lastSensorUpdate = 0; 
// Последнеее обновление дисплея
unsigned long lastDisplayUpdate = 0;  
// Последняя отправка данных 
unsigned long lastAutoSend = 0;
// Моргание двоеточием.
bool colonVisible = true;
unsigned long lastColonBlink = 0;

void setup() {
  Serial.begin(115200);                         // Установка скорости обмена данными Arduino
  Wire.begin();                               // Старт библиотеки IC2
  myAHT10.begin();                            // Старт датчика
  rtc.begin();                                // Старт модуля времени
  lcd.init();
  lcd.backlight();
  bigNumbersLcd.intNumbers();
  pinMode(BLUETOOTH_STATE_PIN, INPUT);
  pinMode(S1, INPUT_PULLUP);
  pinMode(S2, INPUT_PULLUP);
  pinMode(RelayDayPin, OUTPUT);               // Установка режима пина дневного реле как выходного
  pinMode(RelayNightPin, OUTPUT);             // Установка режима пина ночного реле как выходного
  initButtons();
  enc.setTickMode(AUTO);                        // Включение авто режима энкодера
  enc.setType(TYPE2);                           // Выбор типа энкодера

  settings.begin();
  settings.load();

  loadSettingsInMemory();
  // Инициализируем MQTT один раз перед попыткой подключения
  mqtt.begin();

  setupNetwork();
  showSplashScreen();
  updateTime();
  needRedraw = true;
  Serial.println("Система успешно загружена.");
}

// ===== ОСНОВНОЙ ЦИКЛ =====
void loop() {

  // 1. ОБРАБОТКА ВВОДА (высший приоритет)
  updateButtons();
  enc.tick();
  
  // Обработка нажатия кнопки энкодера
  if (enc.isPress() || enc.isTurn()) {
    resetInactivityTimer();
    lcd.backlight();
  }
  
  // Обработка зелёной кнопки
  if (greenPressed) {
    resetButtonFlags();
    resetInactivityTimer();
    lcd.backlight();
    mainMenuFirst();
    return; // После вызова меню выходим из loop
  }

  static unsigned long lastTimeUpdate = 0;
  // Обновляем время раз в секунду
  if (millis() - lastTimeUpdate >= 1000) {
    lastTimeUpdate = millis();
    updateTime();  // Читаем из RTC
  }
  
  // 2. АВТОМАТИЧЕСКАЯ СМЕНА РЕЖИМОВ (раз в 10 секунд)
  if (millis() - lastModeSwitch >= TIME_INTERVAL) {
    lastModeSwitch = millis();

    bool weatherIsFresh = (current_weather.received_at > 0 && 
                          current_weather.isFresh());

    if (currentDisplayMode == DISPLAY_MODE_TIME) 
      currentDisplayMode = DISPLAY_MODE_TEMP;
    else if (currentDisplayMode == DISPLAY_MODE_TEMP && weatherIsFresh)
      currentDisplayMode = DISPLAY_MODE_FORECAST;
    else 
      currentDisplayMode = DISPLAY_MODE_TIME;

    needRedraw = true; // Принудительная перерисовка при смене режима
    colonVisible = true; // Сбрасываем состояние двоеточия
    lcd.clear();
  }
  
  // 3. ОБНОВЛЕНИЕ ДАННЫХ ДАТЧИКОВ (раз в 20 секунд)
  if (millis() - lastSensorUpdate >= SENSOR_UPDATE_INTERVAL || needRedraw) {
    lastSensorUpdate = millis();
    updateSensorData(); // Вынесено в отдельную функцию
  }
  
  // 4. МОРГАНИЕ ДВОЕТОЧИЕМ (только в режиме времени)
  if (currentDisplayMode == DISPLAY_MODE_TIME) {
    if (millis() - lastColonBlink >= 500) { // Моргаем каждые 500мс
      lastColonBlink = millis();
      colonVisible = !colonVisible;
      needRedraw = true;
    }
  }
  
  // 5. ОБНОВЛЕНИЕ ДИСПЛЕЯ (раз в секунду или по необходимости)
  if (millis() - lastDisplayUpdate >= DISPLAY_UPDATE_INTERVAL || needRedraw) {
    lastDisplayUpdate = millis();
    
    switch (currentDisplayMode) {
      case DISPLAY_MODE_TIME:
        displayTimeMode();
        break;
      case DISPLAY_MODE_TEMP:
        displayTempMode();
        break;
      case DISPLAY_MODE_FORECAST:
        displayForecastMode();
        break;
    }
    
    needRedraw = false;
  }

  // Автопубликация данных (каждые 60 сек)
  if (millis() - lastAutoSend > 60000) {
    // Отправка телеметрии с платы.
    sendTelemetry();

    lastAutoSend = millis();    
  }

  // Раз в 10 минут например надо проверять пинал ли нас сервер, согласуем тайминг - если не пинал значит умер....
  
  // 6. ФОНОВЫЕ ПРОЦЕССЫ (низший приоритет)
  updateTimer(); // Таймер бездействия
  displayLoop();
  relayLoop();   // Управление реле
  if(!isOfflineModeActive) {
    // ОБРАТИ ВНИМАНИЕ! ЕСЛИ БРОКЕР НЕ РАБОТАЕТ ТО ЭТО БУДЕТ БЛОКИРОВАТЬ ПОТОК!
    mqtt.loop();   // Проверка хендлеров MQTT
  }
}

// ===== ФУНКЦИИ ОТОБРАЖЕНИЯ ============================================

// Режим офлайн (без WiFi)
void displayOfflineMode() {
  lcd.createChar(7, bukva_I);
  lcd.createChar(6, bukva_D);
  lcd.createChar(5, bukva_Y);
  lcd.createChar(4, bukva_P);
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("HET CET\7");
  lcd.setCursor(0, 1);
  lcd.print("WiFi HE \6OCT\5\4EH");
  delay(2000);
}

// Онлайн без MQTT
void displayOnlineWithoutMQTT() {
  lcd.createChar(7, bukva_I);
  lcd.createChar(6, bukva_D);
  lcd.createChar(5, bukva_Y);
  lcd.createChar(4, bukva_P);
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("HET CET\7");
  lcd.setCursor(0, 1);
  lcd.print("MQTT HE \6OCT\5\4EH");
  delay(1500);
}

// Успешное подключение ко всему
void displayConnected() {
  lcd.createChar(7, bukva_I);
  lcd.createChar(6, bukva_G);
  lcd.createChar(5, bukva_B);
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("BCE C\7CTEMb|: OK");
  lcd.setCursor(0, 1);
  lcd.print("\6OTOB K PA\5OTE");
  delay(1500);
}

// Показать стартовый экран
void showSplashScreen() {
  lcd.clear();
  lcd.createChar(3, bukva_Ya);
  lcd.createChar(4, bukva_I);
  lcd.createChar(5, bukva_D);
  lcd.createChar(6, bukva_IY);
  lcd.createChar(7, bukva_Y);
  lcd.setCursor(0, 0);
  lcd.print("|------------------|");
  lcd.setCursor(0, 1);
  lcd.print("|    \7MHb|\6 \5OM    |");
  lcd.setCursor(0, 2);
  lcd.print("|    BEPC\4\3 2.0    |");
  lcd.setCursor(0, 3);
  lcd.print("|------------------|");
  delay(2000);
  lcd.clear();
}

// Отображение даты
void printDate() {
  String result = "";
  
  // Добавляем день
  if (Date < 10) result += " "; // Для выравнивания однозначных чисел
  result += String(Date);
  result += " ";
  
  // Месяц (будем создавать символы по частям)
  switch(Month) {
    case 1:  // январь
      lcd.createChar(4, bukva_Ya);
      result += "\4HBAP\4";     // Пример: символы 0,1,2 = "янв"
      break;
    case 2:  // февраль
      lcd.createChar(4, bukva_F);
      lcd.createChar(5, bukva_L);
      lcd.createChar(6, bukva_Ya);
      result += "\4EBPA\5\6";     // "фев"
      break;
    case 3:  // март
      result += "MAPTA";   // "март"
      break;
    case 4:  // апрель
      lcd.createChar(4, bukva_P);
      lcd.createChar(5, bukva_Ya);
      lcd.createChar(6, bukva_L);
      result += "A\4PE\6\5"; // "апрел"
      break;
    case 5:  // май
      lcd.createChar(4, bukva_Ya);
      result += "MA\4";       // "ма"
      break;
    case 6:  // июнь bukva_I
      lcd.createChar(4, bukva_I);
      lcd.createChar(5, bukva_Ya);
      result += "\4b|H\5";     // "июн"
      break;
    case 7:  // июль
      lcd.createChar(4, bukva_I);
      lcd.createChar(5, bukva_Ya);
      lcd.createChar(6, bukva_L);
      result += "\4b|\6\5";     // "июл"
      break;
    case 8:  // август
      lcd.createChar(4, bukva_G);
      lcd.createChar(5, bukva_Y);
      result += "AB\4\5CTA"; // "авгус"
      break;
    case 9:  // сентябрь
      lcd.createChar(4, bukva_Ya);
      lcd.createChar(5, bukva_B);
      result += "CEHT\4\5P\4";          // стандартный символ
      break;
    case 10: // октябрь
      lcd.createChar(4, bukva_Ya);
      lcd.createChar(5, bukva_B);
      result += "OKT\4\5P\4";   // "октя"
      break;
    case 11: // ноябрь
      lcd.createChar(4, bukva_Ya);
      lcd.createChar(5, bukva_B);
      result += "HO\4\5P\4";     // "ноя"
      break;
    case 12: // декабрь
      lcd.createChar(4, bukva_Ya);
      lcd.createChar(5, bukva_B);
      lcd.createChar(6, bukva_D);
      result += "\6EKA\5P\4";          // стандартный символ
      break;
  }
  
  // Добавляем запятую
  result += ", ";
  
  // День недели (тоже через кастомные символы)
  switch(DayOf) {
    case 0: // воскресенье
      result += "BC";     // "вск"
      break;
    case 1: // понедельник
      lcd.createChar(7, bukva_P);
      result += "\7H";     // "пнд"
      break;
    case 2: // вторник
      result += "BT";     // "втр"
      break;
    case 3: // среда
      result += "CP";     // "срд"
      break;
    case 4: // четверг
      lcd.createChar(7, bukva_CH);
      result += "\7T";     // "чтв"
      break;
    case 5: // пятница
      lcd.createChar(7, bukva_P);
      result += "\7T";     // "птн"
      break;
    case 6: // суббота
      lcd.createChar(7, bukva_B);
      result += "C\7";     // "сбт"
      break;
  }
  
  lcd.setCursor(2, 3);
  lcd.print(result);
}

// Режим отображения времени
void displayTimeMode() {
  // Большие цифры времени
  bigNumbersLcd.printNumber(Hour/10, 2);
  bigNumbersLcd.printNumber(Hour%10, 6);
  
  // Моргающее двоеточие
  if (colonVisible) {
    lcd.createChar(3, tochka);
    lcd.setCursor(9, 0);
    lcd.write(3);
    lcd.setCursor(9, 1);
    lcd.write(3);
  } else {
    lcd.setCursor(9, 0);
    lcd.print(" ");
    lcd.setCursor(9, 1);
    lcd.print(" ");
  }
  
  bigNumbersLcd.printNumber(Minute/10, 10);
  bigNumbersLcd.printNumber(Minute%10, 14);
  
  // Отображение даты
  printDate();
}

// Режим отображения температуры
void displayTempMode() {

  bool weatherIsFresh = (current_weather.received_at > 0 && 
                          current_weather.isFresh());

  // Создаем символ градуса если нужно
  lcd.createChar(7, bukva_ZH);  // Символ градуса
  lcd.createChar(6, bukva_D); // Кириллица Д
  lcd.createChar(5, bukva_I); // Кириллица Ф
  
  // Отображение внутренней температуры
  lcd.setCursor(0, 0);
  lcd.print("\6OM:");
  lcd.setCursor(8, 0);
  lcd.print(tf, 1);
  lcd.print(" C ");
  lcd.print(hf, 0);
  lcd.print(" %");
  
  if (weatherIsFresh) {
    // Отображение внешней температуры (если есть)
    lcd.setCursor(0, 1);
    lcd.print("\5\7EBCK:");
    lcd.setCursor(8, 1);
    lcd.print(current_weather.temp);
    lcd.print(" C");
    lcd.print("/");
    lcd.print(current_weather.feels_like);
    lcd.print(" C");

    lcd.setCursor(0, 2);
    lcd.print("BETEP:   ");
    
    lcd.print(current_weather.wind_speed);
    
    lcd.print(" M/C");

    printTranslateWeather(current_weather.condition);
  } else {
    lcd.createChar(4, bukva_I);
    lcd.createChar(3, bukva_F);
    lcd.createChar(2, bukva_TS);
    lcd.setCursor(0, 2);
    lcd.print("   HET \4H\3OPMA\2\4\4");
    requestForecast();
  }
  
  
}

// Режим отображения прогноза погоды
void displayForecastMode() {

  lcd.createChar(7, bukva_Y);  // Символ градуса
  lcd.createChar(6, bukva_D); // Кириллица Д
  lcd.createChar(5, bukva_CH); // Кириллица Ч
  lcd.createChar(4, bukva_P); // Кириллица П
  lcd.createChar(3, bukva_G); // Кириллица Г
  lcd.createChar(2, bukva_B); // Кириллица Б
  lcd.createChar(1, bukva_L); // Кириллица Л


  lcd.setCursor(0, 0);
  lcd.print("  \4PO\3HO3 \4O\3O\6b|");
  
  // Отображение внутренней температуры
  lcd.setCursor(0, 1);
  lcd.print("\7TPO: ");

  lcd.setCursor(7, 1);
  lcd.print(current_weather.morning_temp);
  // lcd.print(" C ");

  lcd.setCursor(11, 1);
  lcd.print("\6EHb:");

  lcd.setCursor(17, 1);
  lcd.print(current_weather.day_temp);
  // lcd.print(" C ");

  lcd.setCursor(0, 2);
  lcd.print("BE\5EP:");

  lcd.setCursor(7, 2);
  lcd.print(current_weather.evening_temp);
  // lcd.print(" C ");

  lcd.setCursor(11, 2);
  lcd.print("HO\5b:");

  lcd.setCursor(17, 2);
  lcd.print(current_weather.night_temp);
  // lcd.print(" C ");

  lcd.setCursor(0, 3);
  lcd.print("O\2HOB\1EHO:  ");
  lcd.print(current_weather.update_at);


}

// Отображение описание погоды
void printTranslateWeather(String englishCondition) {
  englishCondition.toUpperCase();

  if (englishCondition == "CLEAR") {
    lcd.createChar(4, bukva_Ya);
    lcd.setCursor(0, 3);
    lcd.print("        \4CHO");
  }
  else if (englishCondition == "PARTLY-CLOUDY") {
    lcd.createChar(4, bukva_P);
    lcd.createChar(3, bukva_B);
    lcd.createChar(2, bukva_CH);
    lcd.createChar(1, bukva_L);
    lcd.setCursor(0, 3);
    lcd.print("\4EPEMEH. O\3\1A\2HOCTb");
  }
  else if (englishCondition == "CLOUDY") {
    lcd.createChar(4, bukva_B);
    lcd.createChar(3, bukva_CH);
    lcd.createChar(2, bukva_L);
    lcd.setCursor(0, 3);
    lcd.print("      O\4\2A\3HO");
  }
  else if (englishCondition == "OVERCAST") {
    lcd.createChar(4, bukva_P);
    lcd.createChar(3, bukva_Y);
    lcd.setCursor(0, 3);
    lcd.print("      \4ACM\3PHO");
  }
  else if (englishCondition == "LIGHT-RAIN") {
    lcd.createChar(4, bukva_B);
    lcd.createChar(3, bukva_L);
    lcd.createChar(2, bukva_SH);
    lcd.createChar(1, bukva_D);
    lcd.createChar(0, bukva_ZH);
    lcd.setCursor(0, 3);
    lcd.print("   HE\4O\3b\2. \1O");
    lcd.write(0);
    lcd.print("\1b");
  }
  else if (englishCondition == "RAIN") {
    lcd.createChar(4, bukva_D);
    lcd.createChar(3, bukva_ZH);
    lcd.setCursor(0, 3);
    lcd.print("       \4O\3\4b");
  }
  else if (englishCondition == "HEAVY-RAIN") {
    lcd.createChar(4, bukva_D);
    lcd.createChar(3, bukva_ZH);
    lcd.createChar(2, bukva_I);
    lcd.createChar(1, bukva_L);
    lcd.createChar(0, bukva_IY);
    lcd.setCursor(0, 3);
    lcd.print("   C\2\1bHb|");
    lcd.write(0);
    lcd.print(" \4O\3\4b");
  }
  else if (englishCondition == "SHOWERS") {
    lcd.createChar(4, bukva_L);
    lcd.createChar(3, bukva_I);
    lcd.setCursor(0, 3);
    lcd.print("       \4\3BEHb");
  }
  else if (englishCondition == "SLEET") {
    lcd.createChar(4, bukva_IY);
    lcd.createChar(3, bukva_G);
    lcd.setCursor(0, 3);
    lcd.print("    MOKPb|\4 CHE\3");
  }
  else if (englishCondition == "LIGHT-SNOW") {
    lcd.createChar(4, bukva_B);
    lcd.createChar(3, bukva_L);
    lcd.createChar(2, bukva_SH);
    lcd.createChar(1, bukva_IY);
    lcd.createChar(0, bukva_G);
    lcd.setCursor(0, 3);
    lcd.print("   HE\4O\3b\2O\1 CHE");
    lcd.write(0);
  }
  else if (englishCondition == "SNOW") {
    lcd.createChar(4, bukva_G);
    lcd.setCursor(0, 3);
    lcd.print("        CHE\4");
  }
  else if (englishCondition == "SNOWFALL") {
    lcd.createChar(4, bukva_G);
    lcd.createChar(3, bukva_P);
    lcd.createChar(2, bukva_D);
    lcd.setCursor(0, 3);
    lcd.print("      CHE\4O\3A\2");
  }
  else if (englishCondition == "HAIL") {
    lcd.createChar(4, bukva_G);
    lcd.createChar(3, bukva_D);
    lcd.setCursor(0, 3);
    lcd.print("        \4PA\3");
  }
  else if (englishCondition == "THUNDERSTORM") {
    lcd.createChar(4, bukva_G);
    lcd.createChar(3, bukva_Z);
    lcd.setCursor(0, 3);
    lcd.print("       \4PO\3A");
  }
  else if (englishCondition == "THUNDERSTORM-WITH-RAIN") {
    lcd.createChar(4, bukva_G);
    lcd.createChar(3, bukva_Z);
    lcd.createChar(2, bukva_D);
    lcd.createChar(1, bukva_ZH);
    lcd.setCursor(0, 3);
    lcd.print("   \4PO\3A C \2O\1\2EM");
  }
  else if (englishCondition == "THUNDERSTORM-WITH-HAIL") {
    lcd.createChar(4, bukva_G);
    lcd.createChar(3, bukva_Z);
    lcd.createChar(2, bukva_D);
    lcd.setCursor(0, 3);
    lcd.print("   \4PO\3A C \4PA\2OM");
  }
  else {
    lcd.createChar(4, bukva_I);
    lcd.createChar(3, bukva_F);
    lcd.createChar(2, bukva_TS);
    lcd.setCursor(0, 3);
    lcd.print("   HET \4H\3OPMA\2\4\4");
  }
}

// ============ МЕНЮ =================================================

// Меню. Мы сразу используем методы из settings для записи в энерогонезависимую память.
// После вызываем settings.save() и loadSettingsInMemory() для синхронизации
// Также необходимо вызывать метод для отправки настроек MQTT брокеру.
void mainMenuFirst() {

  lcd.clear();
  k = 0;                            // Курсор в исходном положении
  needRedraw = true;                   // Для еденичной отрисовки

  // Бесокнечный цикл
  while (true) {

    // Флаг выхода
    if (exitFlag) {
      exitFlag = false;
      return;
    }

    enc.tick();
    updateButtons();

    if (yellowPressed) {
      resetButtonFlags();
      lcd.clear();
      needRedraw = true;
      return;
    }

    yield();

    // Требуется отрисовка
    if (needRedraw) {

      lcd.createChar(1, bukva_Y);
      lcd.createChar(2, bukva_L);
      lcd.createChar(3, bukva_IY);
      lcd.createChar(4, bukva_EE);
      lcd.createChar(5, bukva_ZH);
      lcd.createChar(6, bukva_I);
      lcd.createChar(7, bukva_I);

      lcd.setCursor (1, 0);
      lcd.print("PE\5\6M \4KPAHA");
      lcd.setCursor (1, 1);
      lcd.print("TA\3MA\1T \4KPAHA");
      lcd.setCursor (1, 2);
      lcd.print("PE\5\6M PE\2E");
      lcd.setCursor (1, 3);
      lcd.print("HACTPO\3KA PE\2E");
      lcd.setCursor(0, k);
      lcd.print(">");
      needRedraw = false;         // Изменений нет - отрисовка завершена
    }

    if (enc.isTurn()){     // Если был поворот в любую сторону
      lcd.setCursor(0, k);
      lcd.print(" ");
      
      if (checkEncIsLeftRotate()) {     // Был поворов вправо
        k++;

        if(k>=4){      // Переход на меню 2
          k = 0;   
          lcd.clear();                     // Отчистка дисплея          
          needRedraw = true;                   // Для еденичной отрисовки
          mainMenuSecond();
        }

      } 
      if (checkEncIsRightRotate()) {      // Был поворот влево
        k--;
        
        if (k <= -1) {           // Переход на меню 2
            k = 3;
            lcd.clear();                     // Отчистка дисплея          
            needRedraw = true;                   // Для еденичной отрисовки
          }
          
      } 
          
      needRedraw = true;   // Есть изменения - необходимо отрисовать
    } 
          
    if (enc.isPress()) {      // Если было нажатие кнопки энкодера
      switch (k) {
        // Режим экрана
        case 0:
          screenModeSettings();      
          break;
        // Время подсветки экрана
        case 1:  
          screenTimeSettings();
          break;
        // Режим реле
        case 2:
          relayModeSettings();
          break;
        case 3:
        // Настройки реле
          if(isManualModeRelayEnabled) 
            settingsForManualRelay();
          else 
            settingsForAutoRelay();
          break;
      }

      needRedraw = true;
    
    }

  }

}

// Проверка ЛЮБОГО поворота налево
bool checkEncIsLeftRotate() {
  return enc.isLeft() || enc.isLeftH() || enc.isFastL();
}

// Проверка ЛЮБОГО поворта направо
bool checkEncIsRightRotate() {
  return enc.isRight() || enc.isRightH() || enc.isFastR();
}

// Настройка режима работы реле
void relayModeSettings() { 

  lcd.clear();
  k = 1;                            // Курсор в исходном положении
  needRedraw = true;                   // Для еденичной отрисовки

  // Бесокнечный цикл
  while (true) {

    updateButtons();

    if (yellowPressed) {
      resetButtonFlags();
      lcd.clear();
      k = 2;
      needRedraw = true;
      return;
    }

    yield();

    // Требуется отрисовка
    if (needRedraw) {

      lcd.createChar(2, bukva_Y);
      lcd.createChar(3, bukva_IY);
      lcd.createChar(4, bukva_CH);
      lcd.createChar(5, bukva_L);
      lcd.createChar(6, bukva_I);
      lcd.createChar(7, bukva_ZH);
      lcd.setCursor (0, 0);
      lcd.print("-----PE\7\6M PE\5E-----");
      lcd.setCursor (1, 1);
      lcd.print("ABTOMAT\6\4ECK\6\3 [ ]");
      lcd.setCursor (1, 2);
      lcd.print("P\2\4HO\3         [ ]");
      lcd.setCursor(0, k);
      lcd.print(">");
      lcd.setCursor(17, isManualModeRelayEnabled ? 2 : 1);
      lcd.print("*");
      needRedraw = false;         // Изменений нет - отрисовка завершена
    }

    enc.tick();

    if (enc.isTurn()){     // Если был поворот в любую сторону
      lcd.setCursor(0, k);
      lcd.print(" ");
      
      if (checkEncIsLeftRotate()) {     // Был поворов вправо
        k++;
        if(k>=3){      // Переход на меню 2
          k = 1;   
        }
      } 
      if (checkEncIsRightRotate()) {      // Был поворот влево
        k--;
        if (k <= 0) {           // Переход на меню 2
            k = 2;
          }  
      }

      needRedraw = true;
    } 
          
    if (enc.isPress()) {      // Если было нажатие кнопки энкодера
      isManualModeRelayEnabled = !isManualModeRelayEnabled;
      settings.setRelayMode(isManualModeRelayEnabled);
      settings.save();
      needRedraw = true;
    }

  }

}

// Настройка времени работы экрана
void screenTimeSettings() {

  lcd.clear();
  needRedraw = true;                   // Для еденичной отрисовки

  byte counter = displayTimeoutSeconds;

  // Бесокнечный цикл
  while (true) {

    updateButtons();

    if (yellowPressed) {
      resetButtonFlags();
      lcd.clear();
      needRedraw = true;
      return;
    }

    yield();

    // Требуется отрисовка
    if (needRedraw) {

      lcd.createChar(4, bukva_EE);
      lcd.createChar(5, bukva_D);
      lcd.createChar(6, bukva_Y);
      lcd.createChar(7, bukva_Ya);
      lcd.setCursor (0, 0);
      lcd.print("----BPEM\7 \4KPAHA----");
      lcd.setCursor (0, 2);
      lcd.print("           ");
      lcd.setCursor (7, 2);
      lcd.print(counter);
      lcd.setCursor (11, 2);
      lcd.print("CEK\6H\5");
      needRedraw = false;         // Изменений нет - отрисовка завершена
    }

    enc.tick();

    if (enc.isTurn()){     // Если был поворот в любую сторону

      if (checkEncIsLeftRotate()) {     // Был поворов вправо
        counter += 5;
        if(counter>=251){      // Переход на меню 2
          counter = 5;   
        }
      } 
      if (checkEncIsRightRotate()) {      // Был поворот влево
        counter -= 5;
        if (counter <= 4) {           // Переход на меню 2
            counter = 250;
          }  
      }

      needRedraw = true;
    } 
          
    if (enc.isPress()) {      // Если было нажатие кнопки энкодера
      settings.setDisplayTimeout(counter);
      settings.save();
      displayTimeoutSeconds = counter;
      needRedraw = true;
      return;
    }

  }

}

// Настройка режима работы экрана
void screenModeSettings() {

  lcd.clear();
  k = 1;                            // Курсор в исходном положении
  needRedraw = true;                   // Для еденичной отрисовки

  // Бесокнечный цикл
  while (true) {

    updateButtons();

    if (yellowPressed) {
      resetButtonFlags();
      lcd.clear();
      needRedraw = true;
      return;
    }

    yield();

    // Требуется отрисовка
    if (needRedraw) {

      lcd.createChar(0, bukva_CH);
      lcd.createChar(1, bukva_Y);
      lcd.createChar(2, bukva_IY);
      lcd.createChar(3, bukva_EE);
      lcd.createChar(4, bukva_ZH);
      lcd.createChar(5, bukva_I);
      lcd.createChar(6, bukva_P);
      lcd.createChar(7, bukva_Ya);
      lcd.setCursor (0, 0);
      lcd.print("----PE\4\5M \3KPAHA----");
      lcd.setCursor (1, 1);
      lcd.print("\6OCTO\7HHb|\2    [ ]");
      lcd.setCursor (1, 2);
      lcd.print("ABTOMAT\5");
      lcd.write(0);
      lcd.print("ECK\5\2 [ ]");
      lcd.setCursor (1, 3);
      lcd.print("\1MHb|\2         [ ]");
      lcd.setCursor(0, k);
      lcd.print(">");
      lcd.setCursor(17, displayMode+1);
      lcd.print("*");
      needRedraw = false;         // Изменений нет - отрисовка завершена
    }

    enc.tick();

    if (enc.isTurn()){     // Если был поворот в любую сторону
      lcd.setCursor(0, k);
      lcd.print(" ");
      
      if (checkEncIsLeftRotate()) {     // Был поворов вправо
        k++;
        if(k>=4){      // Переход на меню 2
          k = 1;   
        }
      } 
      if (checkEncIsRightRotate()) {      // Был поворот влево
        k--;
        if (k <= -0) {           // Переход на меню 2
            k = 3;
          }  
      }

      needRedraw = true;
    } 
          
    if (enc.isPress()) {      // Если было нажатие кнопки энкодера
      settings.setDisplayMode(k-1);
      settings.save();
      loadSettingsInMemory();
      needRedraw = true;
    }

  }

}

// Вторая часть меню
void mainMenuSecond() {

  lcd.clear();
  k = 0;                            // Курсор в исходном положении
  needRedraw = true;                   // Для еденичной отрисовки

  // Бесокнечный цикл
  while (true) {

    yield();

    updateButtons();

    if (yellowPressed) {
      resetButtonFlags();
      lcd.clear();
      needRedraw = true;
      exitFlag = true;
      return; 
    }

    // Требуется отрисовка
    if (needRedraw) {

      lcd.createChar(2, bukva_L);
      lcd.createChar(3, bukva_IY);
      lcd.createChar(4, bukva_EE);
      lcd.createChar(5, bukva_Y);
      lcd.createChar(6, bukva_I);
      lcd.createChar(7, bukva_B);

      lcd.setCursor (1, 0);
      lcd.print("HACTPO\3KA CET\6");
      lcd.setCursor (1, 1);
      lcd.print("C\7POC HACTPOEK");
      lcd.setCursor (1, 2);
      lcd.print("HACTPO\3KA Bluetooth");
      lcd.setCursor (1, 3);
      lcd.print("\5CTAHOBKA BPEMEH\6");
      lcd.setCursor(0, k);
      lcd.print(">");
      needRedraw = false;         // Изменений нет - отрисовка завершена
    }

    enc.tick();

    if (enc.isTurn()){     // Если был поворот в любую сторону
      lcd.setCursor(0, k);
      lcd.print(" ");
      
      if (checkEncIsLeftRotate()) {     // Был поворов вправо
        k++;

        if(k>=4){      // Переход на меню 2
          k = 0;   
          lcd.clear();                     // Отчистка дисплея          
          needRedraw = true;                   // Для еденичной отрисовки
        }

      } 
      if (checkEncIsRightRotate()) {      // Был поворот влево
        k--;
        
        if (k <= -1) {           // Переход на меню 1
            k = 3;
            lcd.clear();                     // Отчистка дисплея          
            needRedraw = true;                   // Для еденичной отрисовки
            return;
          }
          
      } 
          
      needRedraw = true;   // Есть изменения - необходимо отрисовать
    } 
          
    if (enc.isPress()) {      // Если было нажатие кнопки энкодера
      switch(k){
        // Настройка сети
        case 0:
          settingsForInternet();
          break;
        // Сброс настроек
        case 1:
          setDefaultSettings();
          break;
        // Настройка блютуза
        case 2:
          bluetoothSettings();
          break;
        // Установка времени
        case 3:
          setTime();
          break;
      }
      needRedraw = true;
    
    }

  }

}

// Отображение текущих параметров блока в уборной
void bluetoothSettings() {
  
  lcd.clear();
  k = 0;                            // Курсор в исходном положении
  needRedraw = true;                   // Для еденичной отрисовки

  // Бесокнечный цикл
  while (true) {

    yield();

    updateButtons();

    if (yellowPressed) {
      resetButtonFlags();
      lcd.clear();
      needRedraw = true;
      return; 
    }

    // Требуется отрисовка
    if (needRedraw) {

      lcd.createChar(3, bukva_ZH);
      lcd.createChar(4, bukva_D);                         // Символы необходимые для отрисовки кириллицы в данном меню
      lcd.createChar(5, bukva_L);
      lcd.createChar(6, bukva_P);
      lcd.createChar(7, bukva_I);

      lcd.setCursor (1, 0);
      lcd.print("\4O BK\5 BEHT:      c");         // Пункт меню связанный с настройкой задержки до включения вентилятора
      lcd.setCursor (16, 0);
      lcd.print(fanDelay);                // Место для времени до вкл
      lcd.setCursor (1, 1);
      lcd.print("\6OC\5E Bb|XO\4A:   m");           // Пункт меню связанный с настройкой времени работы после покидания
      lcd.setCursor (16, 1);
      lcd.print(fanDuration);                                                // Место для времени после выкл
      lcd.setCursor (1, 2);
      lcd.print("HACTP. CBETA");
      lcd.setCursor (1, 3);
      lcd.print("\6O\4K\5. AKT: ");
      if (isBluetoothConnected()) {
        lcd.print("\4A");
      } else {
        lcd.print("HET");
      }
      lcd.setCursor(0, k);
      lcd.print(">");

      needRedraw = false;         // Изменений нет - отрисовка завершена
    }

    enc.tick();

    if (enc.isTurn()){     // Если был поворот в любую сторону
      lcd.setCursor(0, k);
      lcd.print(" ");
      
      if (checkEncIsLeftRotate()) {     // Был поворов вправо
        k++;

        if(k>=3){      // Переход на меню 2
          k = 0;           
          needRedraw = true;                   // Для еденичной отрисовки
        }

      } 
      if (checkEncIsRightRotate()) {      // Был поворот влево
        k--;
        
        if (k <= -1) {           // Переход на меню 1
            k = 2;   
            needRedraw = true;                   // Для еденичной отрисовки
          }
          
      } 
          
      needRedraw = true;   // Есть изменения - необходимо отрисовать
    } 
          
    if (enc.isPress()) {      // Если было нажатие кнопки энкодера
      byte result;
      switch(k) {
        // Установка времени до
        case 0:
          result = functionSet(fanDelay, 250, 10);
          settings.setFanSettings(result, fanDuration);
          settings.save();
          loadSettingsInMemory();
          break;
        // Установка времени после
        case 1:
          result = functionSet(fanDuration, 30, 1);
          settings.setFanSettings(fanDelay, result);
          settings.save();
          loadSettingsInMemory();
          break;
        // Настройка времени
        case 2:
          setBluetoothTime();
          break;
      }
      needRedraw = true;
    
    }

  }

}

// Меню настройки блока в уборной
void setBluetoothTime() { 

  lcd.clear();
  k = 0;                            // Курсор в исходном положении
  needRedraw = true;                   // Для еденичной отрисовки

  while (true) {
    
    yield();

    updateButtons();

    if (yellowPressed) {
      resetButtonFlags();
      lcd.clear();
      needRedraw = true;
      return; 
    }

    if (needRedraw) {                                          // Если есть изменения 


      lcd.createChar(7, bukva_L);
      lcd.createChar(6, bukva_L); 
      lcd.createChar(5, bukva_Ya);
      lcd.createChar(4, bukva_L);
      lcd.createChar(3, bukva_L);
      lcd.createChar(2, bukva_L);
      lcd.createChar(1, bukva_L);
      lcd.createChar(0, bukva_L);

      lcd.setCursor(1, 0);
      lcd.print("BK\7 CBETA");
      lcd.setCursor(15, 0);
      lcd.print(toiletRelay.startHour / 10);
      lcd.print(toiletRelay.startHour % 10);
      lcd.print(":");
      lcd.print(toiletRelay.startMinute / 10);
      lcd.print(toiletRelay.startMinute % 10);    

      lcd.setCursor(1,1);
      lcd.print("Bb|K\7. CBETA");
      lcd.setCursor(15, 1);
      lcd.print(toiletRelay.stopHour / 10);
      lcd.print(toiletRelay.stopHour % 10);
      lcd.print(":");
      lcd.print(toiletRelay.stopMinute / 10);
      lcd.print(toiletRelay.stopMinute % 10);    

      lcd.setCursor(0, k);
      lcd.print(">");
      needRedraw = false;         // Изменений нет - отрисовка завершена

    }
    if (enc.isTurn()) {    

      lcd.setCursor(0, k);
      lcd.print(" ");

      if (checkEncIsRightRotate()) {     
        k++;
        if (k>=2) 
          k = 0; 
      } else {    
        k--;
        if (k<=-1)
          k = 1;     
      } 
        
      needRedraw = true;   // Есть изменения - необходимо отрисовать
    }

    if(enc.isPress()) {      // Если было нажатие кнопки энкодера

      needRedraw = true;

      switch(k) {
        case 0:
          relaySetTime(toiletRelay.startHour, toiletRelay.startMinute, 1, 11, 4);
          break;
        case 1:
          relaySetTime(toiletRelay.stopHour, toiletRelay.stopMinute, 13, 23, 5);
          break;
      }
       needRedraw = true;
    }
  }
}

// Сброс настроек
void setDefaultSettings() {
  for (byte counter = 15; counter != 0; --counter) {
    lcd.clear();
    lcd.home();
    lcd.print("Please, wait ");
    lcd.print(counter);
    delay(1000);
    if (enc.isPress()) { 
      lcd.clear(); 
      return; 
    }
  }          
  settings.resetToDefaults();
  loadSettingsInMemory();
  lcd.createChar(4, bukva_P);
  lcd.createChar(5, bukva_L);
  lcd.clear();
  lcd.setCursor(0, 1);
  lcd.print("     Bb|\4O\5HEHO");
  delay(2000);
  lcd.clear();
}

// Настройки для интернета
void settingsForInternet() {
   lcd.clear();
  k = 0;                            // Курсор в исходном положении
  needRedraw = true;                   // Для еденичной отрисовки

  // Бесокнечный цикл
  while (true) {

    yield();

    updateButtons();

    if (yellowPressed) {
      resetButtonFlags();
      lcd.clear();
      needRedraw = true;
      return; 
    }

    // Требуется отрисовка
    if (needRedraw) {

      lcd.clear();

      lcd.createChar(2, bukva_Y);
      lcd.createChar(3, bukva_I);

      lcd.setCursor (1, 0);
      lcd.print("CTAT\2C CET\3");

      if (isOfflineModeActive) {
        lcd.print(" OFF");
      } else {
        lcd.print(" ON");

        lcd.setCursor (1, 1);
        lcd.print("CTAT\2C WIFI:");
        if (WiFi.status() == WL_CONNECTED) {
          lcd.print(" ON");

          lcd.setCursor (1, 2);\
          lcd.print("CTAT\2C CEPBEPA:");
          if (mqtt.connected()) {
            lcd.print(" ON");
          } else {
            lcd.print(" OFF");
          }

        } else {
          lcd.print(" OFF");
        }

      }

      lcd.setCursor(0, k);
      lcd.print(">");
      needRedraw = false;         // Изменений нет - отрисовка завершена
    }

    enc.tick();

    if (enc.isTurn()){     // Если был поворот в любую сторону
      lcd.setCursor(0, k);
      lcd.print(" ");
      
      if (checkEncIsLeftRotate()) {     // Был поворов вправо
        k++;

        if(k>=4){      // Переход на меню 2
          k = 0;   
          lcd.clear();                     // Отчистка дисплея          
          needRedraw = true;                   // Для еденичной отрисовки
        }

      } 
      if (checkEncIsRightRotate()) {      // Был поворот влево
        k--;
        
        if (k <= -1) {           // Переход на меню 1
            k = 3;
            lcd.clear();                     // Отчистка дисплея          
            needRedraw = true;                   // Для еденичной отрисовки
            return;
          }
          
      } 
          
      needRedraw = true;   // Есть изменения - необходимо отрисовать
    } 
          
    if (enc.isPress()) {      // Если было нажатие кнопки энкодера
      switch(k){
        // ОФФЛАЙН РЕЖИМ
        case 0:
          isOfflineModeActive = !isOfflineModeActive;
          if (!isOfflineModeActive) {
            setupNetwork();
          }
          settings.setOfflineMode(isOfflineModeActive);
          settings.save();
          break;
        // ВАЙФАЙ
        case 1:
          if (isOfflineModeActive) break;
          if (WiFi.status() != WL_CONNECTED) {
            setupNetwork();
          }
          break;
        // БРОКЕР
        case 2:
         if (isOfflineModeActive || WiFi.status() != WL_CONNECTED) break;
          if (!mqtt.connected()) {
            setupNetwork();
          }
          break;
        // 
        case 3:
          
          break;
      }
      needRedraw = true;
    
    }

  }
}

// Настройки для ручного реле
void settingsForManualRelay() { 

  k = 0;
  lcd.clear();
  needRedraw = true;

  while (true) {        // Воид настройки реле ручного режима работы

    yield();

    if (needRedraw) {                             // Если есть изменения 

      lcd.createChar(3, bukva_L);
      lcd.createChar(4, bukva_CH);
      lcd.createChar(5, bukva_D);
      lcd.createChar(6, bukva_I);
      lcd.createChar(7, bukva_IY);

      lcd.setCursor (1, 0);
      lcd.print("\5HEBHO\7 \5AT\4\6K  ");

      if(isDayRelayForcedOn) 
        lcd.print("ON ");
      else 
        lcd.print("OFF");

      lcd.setCursor (1, 1);
      lcd.print("HO\4HO\7 \5AT\4\6K   ");
      
      if (isNightRelayForcedOn) 
        lcd.print("ON ");
      else 
        lcd.print("OFF");

      lcd.setCursor(0, k);
      lcd.print(">");
      needRedraw = false;         // Изменений нет - отрисовка завершена
    }

    enc.tick();
    updateButtons();
        
    if (enc.isTurn()) {     // Если был поворот в любую сторону
      lcd.setCursor(0, k);
      lcd.print(" ");
       
      if (checkEncIsLeftRotate()) {     // Был поворов вправо
        ++k;
        if (k>=2) 
          k = 0;
      }
       
      if (checkEncIsRightRotate()) {     // Был поворот влево
        --k;
        if (k<=-1) 
          k = 1;
      } 
        
      needRedraw = true;   // Есть изменения - необходимо отрисовать
    }
      
    if (enc.isPress()) {      // Если было нажатие кнопки энкодера
      switch (k) {
        case 0:  
          if (isDayRelayForcedOn) {
            isDayRelayForcedOn = false;
            digitalWrite(RelayDayPin, LOW);
          } else {
            isDayRelayForcedOn = true;
            digitalWrite(RelayDayPin, HIGH);
          }
          settings.setManualStates(isDayRelayForcedOn, isNightRelayForcedOn);
          break;
        case 1: 
          if (isNightRelayForcedOn) {
            isNightRelayForcedOn = false;
            digitalWrite(RelayNightPin, LOW);
          } else { 
            isNightRelayForcedOn = true;
            digitalWrite(RelayNightPin, HIGH);
          }
          settings.setManualStates(isDayRelayForcedOn, isNightRelayForcedOn);
          break;
      }

      // Важно! Сохранение настроек.
      settings.save();
      loadSettingsInMemory();

      needRedraw = true;
    }

    if(yellowPressed){      // Проверка нажатия желтой кнопки
      resetButtonFlags();
      lcd.clear();
      needRedraw = true;
      k = 3;
      return;                 
    }
  }
}

// Настройки для автоматического реле
void settingsForAutoRelay() {  

  k = 0;
  lcd.clear();
  needRedraw = true;

  while (true) {      //Воид настроки реле автоматического режима работы

    yield();
  
    if (needRedraw) {                                                   // Если есть изменения 

      lcd.createChar(3, bukva_L);
      lcd.createChar(4, bukva_CH);
      lcd.createChar(5, bukva_D);

      lcd.setCursor (1, 0);
      lcd.print("\5HEB \5AT BK\3");
      lcd.setCursor(15, 0);
      lcd.print(dayRelay.startHour / 10);
      lcd.print(dayRelay.startHour % 10);
      lcd.print(":");
      lcd.print(dayRelay.startMinute / 10);
      lcd.print(dayRelay.startMinute % 10);    
      lcd.setCursor (1, 1);
      lcd.print("\5HEB \5AT Bb|K");
      lcd.setCursor(15, 1);
      lcd.print(dayRelay.stopHour / 10);
      lcd.print(dayRelay.stopHour % 10);
      lcd.print(":");
      lcd.print(dayRelay.stopMinute / 10);
      lcd.print(dayRelay.stopMinute % 10);   
      lcd.setCursor (1, 2);
      lcd.print("HO\4H \5AT BK\3");
      lcd.setCursor(15, 2);
      lcd.print(nightRelay.startHour / 10);
      lcd.print(nightRelay.startHour % 10);
      lcd.print(":");
      lcd.print(nightRelay.startMinute / 10);
      lcd.print(nightRelay.startMinute % 10);    
      lcd.setCursor (1, 3);
      lcd.print("HO\4H \5AT Bb|K");
      lcd.setCursor(15, 3);
      lcd.print(nightRelay.stopHour / 10);
      lcd.print(nightRelay.stopHour % 10);
      lcd.print(":");
      lcd.print(nightRelay.stopMinute / 10);
      lcd.print(nightRelay.stopMinute % 10);   
      lcd.setCursor(0, k);
      lcd.print(">");
      needRedraw = false;         // Изменений нет - отрисовка завершена
    }

    enc.tick();
    updateButtons();
      
    if (enc.isTurn()) {     // Если был поворот в любую сторону

      lcd.setCursor(0, k);
      lcd.print(" ");
      
      if (checkEncIsLeftRotate()) {     // Был поворов вправо
        ++k;
        if (k==4)
          k = 0;
      }
      
      if (checkEncIsRightRotate()) {     // Был поворот влево
        --k;
        if (k==-1) 
          k = 3;
      }

      needRedraw = true;   // Есть изменения - необходимо отрисовать
    
    }
        
    if (enc.isPress()) {      // Если было нажатие кнопки энкодера
      needRedraw = true;      // Дабы при тыке энкодера была мгновенная отрисвока вторичного курсора
      
      switch (k) {
        case 0:  
          relaySetTime(dayRelay.startHour, dayRelay.startMinute, 1, 11, 0);
          break;
        case 1:
          relaySetTime(dayRelay.stopHour, dayRelay.stopMinute, 13, 23, 1);
          break;
        case 2:
          relaySetTime(nightRelay.startHour, nightRelay.startMinute, 13, 23, 2);
          break;
        case 3:
          relaySetTime(nightRelay.stopHour, nightRelay.stopMinute, 1, 11, 3);
          break;
      }
      
      needRedraw = true;
        
    }

    if (yellowPressed) {      // Проверка нажатия желтой кнопки
    resetButtonFlags();
      lcd.clear();
      needRedraw = true;
      k = 3;
      return; 
    }

  }
}

// ===== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ===========================================


// Подключение к бекенду
void setupNetwork(){

  if (isOfflineModeActive) {
    displayOfflineMode();
    return;
  }

  lcd.clear();
  
  // Подключение к WiFi
  if (!connectToWiFi()) {
    // Если не удалось - работаем оффлайн
    displayOfflineMode();
    return;
  }

  // Подключение к MQTT
  if (!connectToMQTT()) {
    // Если MQTT не доступен - всё равно продолжаем
    displayOnlineWithoutMQTT();
  } else {
    displayConnected();
    setupMQTTHandlers();
  }

}

// Подключение к WiFi (5 попыток)
bool connectToWiFi() {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("WiFi: ");
  lcd.print(ssid);
  WiFi.begin(ssid, password);

  int attempts = 0;
  const int maxAttempts = 5;

  while (WiFi.status() != WL_CONNECTED && attempts < maxAttempts) {
    attempts++;

    lcd.createChar(7, bukva_P);
    lcd.setCursor(0, 1);
    lcd.print("\7O\7b|TKA ");
    lcd.print(attempts);
    lcd.print("/");
    lcd.print(maxAttempts);
    lcd.print("   ");

    // Неблокирующая анимация и ожидание (до 3 секунд)
    unsigned long animationStart = millis();
    unsigned long lastDotUpdate = 0;
    int dotAnimation = 0;

    while (millis() - animationStart < 3000 && WiFi.status() != WL_CONNECTED) {
      if (millis() - lastDotUpdate > 500) {
        lastDotUpdate = millis();
        lcd.setCursor(15, 1);
        switch (dotAnimation % 3) {
          case 0: lcd.print(".  "); break;
          case 1: lcd.print(".. "); break;
          case 2: lcd.print("..."); break;
        }
        dotAnimation++;
      }
      yield();
    }
  }

  if (WiFi.status() == WL_CONNECTED) {
    lcd.clear();
    lcd.setCursor(0, 0);
    lcd.print("WiFi: OK        ");
    lcd.setCursor(0, 1);
    lcd.print("IP: ");
    lcd.print(WiFi.localIP());
    delay(800);
    return true;
  }

  return false;
}

// Подключение к MQTT (5 попыток)
bool connectToMQTT() {
  lcd.clear();
  lcd.createChar(7, bukva_B);
  lcd.createChar(6, bukva_P);
  lcd.createChar(5, bukva_D);
  lcd.createChar(4, bukva_Y);
  lcd.setCursor(0, 0);
  lcd.print("MQTT \7POKEP");
  mqtt.setDeviceId("greenhouse_01");

  int attempts = 0;
  const int maxAttempts = 5;

  while (attempts < maxAttempts) {
    attempts++;

    lcd.setCursor(0, 1);
    lcd.print("\6O\6b|TKA ");
    lcd.print(attempts);
    lcd.print("/");
    lcd.print(maxAttempts);
    lcd.print("   ");

    // Неблокирующая анимация и ожидание (до 3 секунд)
    int dotAnimation = 0;
    unsigned long animationStart = millis();
    unsigned long lastDotUpdate = 0;

    while (millis() - animationStart < 3000) {
      mqtt.loop();  // Проверяем подключение постоянно

      // Анимация точек каждые 500ms
      if (millis() - lastDotUpdate > 500) {
        lastDotUpdate = millis();

        lcd.setCursor(15, 1);
        switch (dotAnimation % 3) {
          case 0: lcd.print(".  "); break;
          case 1: lcd.print(".. "); break;
          case 2: lcd.print("..."); break;
        }
        dotAnimation++;
      }

      if (mqtt.connected()) {
        lcd.clear();
        lcd.setCursor(0, 0);
        lcd.print("MQTT: OK       ");
        lcd.setCursor(0, 1);
        lcd.print("\7POKEP \5OCT\4\6EH");
        delay(800);
        return true;
      }
      yield();
    }

    // Если не удалось за 3 секунды, подождём небольшую паузу и повторим
    if (attempts < maxAttempts) {
      unsigned long waitStart = millis();
      while (millis() - waitStart < 800) {
        mqtt.loop();
        yield();
      }
    }
  }
  
  return false;
}

// Получить состояние bluetooth
bool isBluetoothConnected() {
  int stateValue = analogRead(A0);
  float voltage = stateValue * (3.3 / 1024.0);
  return (voltage > 2.5);
}

// Запросить погоду
void requestForecast() {
  // Если руками включен оффлайн режим или бекенд неактивен
  if (isOfflineModeActive || mqtt.connected() == false) {
    return;
  }

  mqtt.publish("weather/request", "{}");
}

// Установка обработчиков MQTT
void setupMQTTHandlers() {

  // Обработчик погоды на ESP32
  mqtt.addHandler(weather_topic, [](const String& topic, const String& msg) {
      
      StaticJsonDocument<512> doc;
      DeserializationError error = deserializeJson(doc, msg);
      
      if (error) {
          return;
      }
      
      current_weather.temp = doc["temp"];
      current_weather.feels_like = doc["feels_like"];
      current_weather.condition = doc["condition"].as<String>();
      current_weather.humidity = doc["humidity"];
      current_weather.wind_speed = doc["wind_speed"];
      
      // Прогноз
      current_weather.morning_temp = doc["morning_temp"];
      current_weather.day_temp = doc["day_temp"];
      current_weather.evening_temp = doc["evening_temp"];
      current_weather.night_temp = doc["night_temp"];
      
      // Время получения (сама плата ставит)
      current_weather.received_at = millis();
      current_weather.update_at = doc["update_at"].as<String>();
  });
  
  // Установка настройек с бекенда
  mqtt.addHandler(set_config_topic, [](const String& topic, const String& msg) {
    settings.fromJSON(msg);
    
    loadSettingsInMemory();
  });

  // Бекенд просит актуальные настройки
  mqtt.addHandler(get_config_topic, [](const String& topic, const String& msg) {

    sendSettings();

  });

  // Бекенд высылает время
  mqtt.addHandler(set_time_topic, [](const String& topic, const String& msg) {

    StaticJsonDocument<512> doc;
    DeserializationError error = deserializeJson(doc, msg);
    
    if (error) {
        return;
    }

    int year = doc["year"];      // 2024
    int month = doc["month"];    // 3
    int day = doc["day"];        // 25
    int hour = doc["hour"];      // 18
    int minute = doc["minute"];  // 45
    int second = doc["second"];  // 30 (или 0)

    // Установить время на ESP
    rtc.adjust(DateTime(year, month, day, hour, minute, second));

    // Дослать время (только часы и минуты) на Arduino
    sendTimeToBluetooth(hour, minute);

    mqtt.publish("time/ready", "{}");

  });
}

// Отправка настроек
void sendSettings() {

  // Если руками включен оффлайн режим или бекенд неактивен
  if (isOfflineModeActive || mqtt.connected() == false) {
    return;
  }

  String json = settings.toJSON(false);
  
  mqtt.publish("config/update", json);

}

// Отправка телеметрии
void sendTelemetry() {

  // Если руками включен оффлайн режим или бекенд неактивен
  if (isOfflineModeActive || mqtt.connected() == false) {
    return;
  }

  StaticJsonDocument<512> doc;
  
  doc["temperature"] = tf;
  doc["humidity"] = hf;
  
  // Системная информация
  doc["uptime"] = millis() / 1000;
  doc["free_memory"] = ESP.getFreeHeap();
  doc["bluetooth_is_active"] = isBluetoothConnected();
  
  mqtt.publish("telemetry", doc);
}

// Инициализация кнопок
void initButtons() {
  pinMode(YELLOW_BUTTON_PIN, INPUT);  // LOW при нажатии
  pinMode(GREEN_BUTTON_PIN, INPUT);          // HIGH при нажатии
  
  yellowBtn.lastState = digitalRead(YELLOW_BUTTON_PIN);
  greenBtn.lastState = digitalRead(GREEN_BUTTON_PIN);
}

// Обновление состояния кнопок (без дебаунса)
void updateButtons() {
  // === ЖЕЛТАЯ КНОПКА (INPUT_PULLUP) ===
  // LOW = нажата, HIGH = отпущена
  bool yellowCurrent = digitalRead(YELLOW_BUTTON_PIN);
  
  // Если состояние изменилось
  if (yellowCurrent != yellowBtn.lastState) {
    // Если нажали (HIGH -> LOW)
    if (yellowCurrent == HIGH && yellowBtn.lastState == LOW) {
      yellowBtn.waitingRelease = true;
    }
    
    // Если отпустили (LOW -> HIGH) И ждали отпускания
    if (yellowCurrent == LOW && yellowBtn.lastState == HIGH && yellowBtn.waitingRelease) {
      yellowPressed = true;
      yellowBtn.waitingRelease = false;
    }
    
    yellowBtn.lastState = yellowCurrent;
  }
  
  // === ЗЕЛЕНАЯ КНОПКА (INPUT) ===
  // HIGH = нажата, LOW = отпущена
  bool greenCurrent = digitalRead(GREEN_BUTTON_PIN);
  
  // Если состояние изменилось
  if (greenCurrent != greenBtn.lastState) {
    // Если нажали (LOW -> HIGH)
    if (greenCurrent == HIGH && greenBtn.lastState == LOW) {
      greenBtn.waitingRelease = true;
    }
    
    // Если отпустили (HIGH -> LOW) И ждали отпускания
    if (greenCurrent == LOW && greenBtn.lastState == HIGH && greenBtn.waitingRelease) {
      greenPressed = true;
      greenBtn.waitingRelease = false;
    }
    
    greenBtn.lastState = greenCurrent;
  }
}

// Сброс флагов (вызывай после обработки)
void resetButtonFlags() {
  yellowPressed = false;
  greenPressed = false;
}

// Загрузка данных из json в оперативную память.
void loadSettingsInMemory() {

  // Режим работы дисплея:
  // 0 - Постоянный
  // 1 - Автоматический
  // 2 - Умный
  displayMode = settings.getDisplayMode();

  // Режим работы дневного реле
  dayRelay.startHour = settings.getDayOnHour();
  dayRelay.startMinute = settings.getDayOnMinute();
  dayRelay.stopHour = settings.getDayOffHour();
  dayRelay.stopMinute = settings.getDayOffMinute();

  // Режим работы ночного реле
  nightRelay.startHour = settings.getNightOnHour();
  nightRelay.startMinute = settings.getNightOnMinute();
  nightRelay.stopHour = settings.getNightOffHour();
  nightRelay.stopMinute = settings.getNightOffMinute();

  // Режим работы реле в уборной
  toiletRelay.startHour = settings.getToiletOnHour();
  toiletRelay.startMinute = settings.getToiletOnMinute();
  toiletRelay.stopHour = settings.getToiletOffHour();
  toiletRelay.stopMinute = settings.getToiletOffMinute();

  // Режим работы всех реле - автоматический\ручной
  isManualModeRelayEnabled = settings.getRelayMode();
  // Состояние дневного реле в ручном режиме
  isDayRelayForcedOn = settings.getManualDayState();
  // Состояние ночного реле в ручном режиме
  isNightRelayForcedOn = settings.getManualNightState();

  // Таймаут дисплея
  displayTimeoutSeconds = settings.getDisplayTimeout();
  
  // Задержка включения вентилятора
  fanDelay = settings.getFanDelay();
  // Время работы вентилятора
  fanDuration = settings.getFanDuration();
  // Статус оффлайн режима
  isOfflineModeActive = settings.getOfflineMode();

  // ВНИМАНИЕ! Функция вызывается после изменений настроек для загрузки их
  // в оперативную память. Это центральное место для примененя настроек.
  
  sendSettingsToBluetooth();

}

// Проверка условий на включение\отключение реле ночь\день
void relayLoop() {
  if (isManualModeRelayEnabled) {
    digitalWrite(RelayNightPin, isNightRelayForcedOn ? HIGH : LOW);
    digitalWrite(RelayDayPin, isDayRelayForcedOn ? HIGH : LOW);
  } else {
    // Дневное реле
    bool dayOn = false;
    if (Hour > dayRelay.startHour || (Hour == dayRelay.startHour && Minute >= dayRelay.startMinute)) {
      if (Hour < dayRelay.stopHour || (Hour == dayRelay.stopHour && Minute < dayRelay.stopMinute)) {
        dayOn = true;
      }
    }
    digitalWrite(RelayDayPin, dayOn ? HIGH : LOW);
    
    // Ночное реле (с поддержкой перехода через полночь)
    bool nightOn = false;
    
    // Если ночное время не переходит через полночь
    if (nightRelay.startHour < nightRelay.stopHour) {
      if (Hour > nightRelay.startHour || (Hour == nightRelay.startHour && Minute >= nightRelay.startMinute)) {
        if (Hour < nightRelay.stopHour || (Hour == nightRelay.stopHour && Minute < nightRelay.stopMinute)) {
          nightOn = true;
        }
      }
    } 
    // Если ночное время переходит через полночь (например 22:00-06:00)
    else {
      if (Hour > nightRelay.startHour || (Hour == nightRelay.startHour && Minute >= nightRelay.startMinute) ||
          Hour < nightRelay.stopHour || (Hour == nightRelay.stopHour && Minute < nightRelay.stopMinute)) {
        nightOn = true;
      }
    }
    
    digitalWrite(RelayNightPin, nightOn ? HIGH : LOW);
  }
}

// Сброс таймера бездействия
void resetInactivityTimer() {
  timer = 0;
}

// Проверка условий на режимы экрана
void displayLoop() {
  
  if (displayMode == 0) {
    timer = 0;  
    lcd.backlight();
  }

  if (displayMode  == 1) {                // Если "авто-режим" работы экрана включен
      if (timer > displayTimeoutSeconds)                   // Если прошло ~10 секунд
        lcd.noBacklight();              // Выключение подсветки дисплея
  }

  if (displayMode  == 2) {                     // Если включен "умный режим" дисплея, осуществим переключение между под режимами согласно времени суток
    if (!(Hour >= dayRelay.startHour && (Hour != dayRelay.startHour || Minute >= dayRelay.startMinute) && Hour <= dayRelay.stopHour && (Hour != dayRelay.stopHour || Minute < dayRelay.stopMinute))) {  // Если ночь, то:
      if(timer > displayTimeoutSeconds) lcd.noBacklight();                 // Если прошло ~10 секунд -  выключение подсветки дисплея   
    } else {  
      timer = 0;  
      lcd.backlight();
    }
  }

}

// Обновление таймера бездействия
void updateTimer() {
  static unsigned long lastTimerUpdate = 0;
  
  if (millis() - lastTimerUpdate >= 1000) {
    lastTimerUpdate = millis();
    timer++;
  }
}

// Чтение данных с датчиков
void updateSensorData() {
  sensors_event_t humidity, temp;
  if (myAHT10.getEvent(&humidity, &temp)) {
    h = hf = humidity.relative_humidity;
    t = tf = temp.temperature;
    needRedraw = true; // Помечаем для перерисовки при новых данных
  }
}

// Получение текущего времени
void updateTime() {
  DateTime now = rtc.now();

  Hour = now.hour();
  Minute = now.minute();
  Second = now.second();

  Date = now.day();          // День месяца (1-31)
  Month = now.month();       // Месяц (1-12)
  DayOf = now.dayOfTheWeek(); // День недели (0-6, где 0 = воскресенье)
  Year = now.year();         // Год (например, 2023)
}

// Отправить данные настроек по bluetooth
void sendSettingsToBluetooth() {
  Serial.print("S(");
  Serial.print(fanDelay);
  Serial.print("-");
  Serial.print(fanDuration);
  Serial.print("-");
  Serial.print(0);
  Serial.print("-");
  Serial.print(0);
  Serial.print("-");
  Serial.print(toiletRelay.startHour);
  Serial.print("-");
  Serial.print(toiletRelay.startMinute);
  Serial.print("-");
  Serial.print(toiletRelay.stopHour);
  Serial.print("-");
  Serial.print(toiletRelay.stopMinute);
  Serial.print("-");
  Serial.print(isManualModeRelayEnabled ? 0 : 1);
  Serial.print("-");
  Serial.print(isDayRelayForcedOn ? 1 : 0);
  Serial.print(")");
}

// Синхронизировать время по bluetooth (только часы и минуты)
void sendTimeToBluetooth(int hour, int minute) {
  Serial.print("T(");
  Serial.print(String(hour));
  Serial.print(":");
  Serial.print(String(minute));
  Serial.print(")");
}

// Установить время для реле
void relaySetTime(int hour, int minute, int minLimit, int highLimit, byte paramIndex) {  
  
  boolean x = true;
  
  while (x) {            // Универсальная функция настройки минут и часов для любого реле

    yield();

    if (needRedraw) {                          // Цикл настройки реле (часов)
      lcd.setCursor(14, k);
      lcd.print(">");
      lcd.print(hour / 10);
      lcd.print(hour % 10);
      lcd.print(":  ");
      needRedraw = false;  
    }

    if (enc.isTurn()) {               // Если был поворот в любую сторону
              
      if (checkEncIsRightRotate()) {     // Был поворов вправо
        ++hour;
        if (hour>highLimit) 
          hour = minLimit;
      }
              
      if (checkEncIsRightRotate()) {     // Был поворот влево
        --hour;
        if (hour<minLimit) 
          hour = highLimit;
      }
      
      needRedraw = true;   // Есть изменения - необходимо отрисовать
      
    }
    
    if (enc.isPress()) {
      x = false;
      needRedraw = true;
    }

  }
  x = true;
            
  while (x) {                      // Цикл настройки минут

    yield();

    if (needRedraw) {            
      lcd.setCursor(18, k);
      lcd.print(minute / 10);
      lcd.print(minute % 10);
      needRedraw = false;  
    }

    if (enc.isTurn()) {               // Если был поворот в любую сторону
      
      if (checkEncIsLeftRotate()) {     // Был поворов вправо
        minute += 5;
        if (minute > 55) 
          minute = 0;
      }
                          
      if (checkEncIsRightRotate()) {     // Был поворот влево
        minute -= 5;
        if (minute < 0) 
          minute = 55;
      }
        
      needRedraw = true;   // Есть изменения - необходимо отрисовать

    }
                
    if (enc.isPress()) {

      x = false;
      needRedraw = true;

    }

  }
    
  switch (paramIndex) {

    case 0:
      // Установка значений только для старта
      settings.setDaySchedule(hour, minute, dayRelay.stopHour, dayRelay.stopMinute);
      break;
    case 1:
      settings.setDaySchedule(dayRelay.startHour, dayRelay.startMinute, hour, minute);
      break;
    case 2:
      settings.setNightSchedule(hour, minute, nightRelay.stopHour, nightRelay.stopMinute);
      break;
    case 3:
      settings.setNightSchedule(nightRelay.startHour, nightRelay.startMinute, hour, minute);
      break;
    case 4:
      settings.setToiletSchedule(hour, minute, toiletRelay.stopHour, toiletRelay.stopMinute);
      break;
    case 5:
      settings.setToiletSchedule(toiletRelay.startHour, toiletRelay.startMinute, hour, minute);
      break;

  }

  // Важно. Сохранение.
  settings.save();
  loadSettingsInMemory();
    
  lcd.createChar(4, bukva_P);
  lcd.createChar(5, bukva_L);
  lcd.clear();
  lcd.setCursor(0, 1);
  lcd.print("     Bb|\4O\5HEHO");
  delay(2000);
  lcd.clear();
  return;                 // Возврат на экран настройки реле.
          
}

// Функция для настройки одного параметра времени
bool setTimeParam(TimeParam &param, int* A, bool isLast = false) {

  boolean x = true;
  String result = "";
  
  while(x) {

    yield();

    enc.tick();
    updateButtons();
    
    if(needRedraw) {

      // Очищаем область отображения
      lcd.clear();
      // Отображаем значение
      lcd.setCursor(param.xPos, param.yPos);
      if(param.isDayOfWeek) {
        // СНАЧАЛА создаем символы, ПОТОМ печатаем
        switch(param.currentValue) {
          case 0: // воскресенье (BC - ВС)
            result = "VOSKRESENIE";
            break;
          case 1: // понедельник (ПН)
            result = "PONEDELNIK";  // Н
            break;
          case 2: // вторник (BT - ВТ)
            result = "VTORNIK";
            break;
          case 3: // среда (CP - СР)
            result = "SREDA";
            break;
          case 4: // четверг (ЧТ)
            result = "CHETVERG";  // Т
            break;
          case 5: // пятница (ПТ)
            result = "PYATNICA";  // Т
            break;
          case 6: // суббота (СБ)
            result = "SUBBOTA";  // Т
            break;
        }
        lcd.print(result);
      } else if(param.isYear) {
        lcd.print(param.currentValue);
      } else {
        lcd.print(param.currentValue / 10);
        lcd.print(param.currentValue % 10);
      }
      
      // Отображаем подпись
      lcd.setCursor(6, 1);
      lcd.print(param.label);
      needRedraw = false;
    }
    
    // Обработка энкодера
    if(enc.isTurn()) {
      if(checkEncIsLeftRotate()) {
        param.currentValue++;
        if(param.currentValue > param.maxValue) {
          param.currentValue = param.minValue;
        }
      }
      if(checkEncIsRightRotate()) {
        param.currentValue--;
        if(param.currentValue < param.minValue) {
          param.currentValue = param.maxValue;
        }
      }
      needRedraw = true;
    }
    
    // Нажатие энкодера - сохранение и выход
    if(enc.isPress()) {
      if(param.isYear) {
        A[param.saveIndex] = param.currentValue % 2000;
      } else {
        A[param.saveIndex] = param.currentValue;
      }
      needRedraw = true;
      return true;  // Успешное завершение
    }
    
    // Нажатие желтой кнопки - отмена
    if(yellowPressed) {
      resetButtonFlags();
      lcd.clear();
      needRedraw = true;
      return false;  // Отмена
    }
  }
  return false;
}

// Переписанная функция настройки времени
void setTime() {
  needRedraw = true;
  int A[7];

  DateTime now = rtc.now();
  
  // Массив параметров для настройки
  TimeParam params[] = {
    // Часы
    {"\1AC", 0, 23, now.hour(), 5, 0, false, false, 2},
    // Минуты
    {"M\1H\2TA", 0, 59, now.minute(), 8, 0, false, false, 1},
    // День недели
    {"\1EHb HE\1E\2\3", 0, 6, now.dayOfTheWeek(), 0, 0, true, false, 6},
    // Дата
    {"\1ATA", 1, 31, now.day(), 15, 0, false, false, 3},
    // Месяц
    {"MEC\1\2", 1, 12, now.month(), 18, 0, false, false, 4},
    // Год
    {"\1O\2", 2021, 2049, now.year(), 15, 1, false, true, 5}
  };
  
  // Настраиваем каждый параметр
  for(int i = 0; i < 6; i++) {
    // Создаем пользовательские символы для текущего параметра
    switch(i) {
      case 0:  // Часы
        lcd.createChar(1, bukva_CH);
        break;
      case 1:  // Минуты
        lcd.createChar(1, bukva_I);
        lcd.createChar(2, bukva_Y);
        break;
      case 2:  // День недели
        lcd.createChar(1, bukva_D);
        lcd.createChar(2, bukva_L);
        lcd.createChar(3, bukva_I);
        break;
      case 3:  // Дата
        lcd.createChar(1, bukva_D);
        break;
      case 4:  // Месяц
        lcd.createChar(1, bukva_Ya);
        lcd.createChar(2, bukva_TS);
        break;
      case 5:  // Год
        lcd.createChar(1, bukva_G);
        lcd.createChar(2, bukva_D);
        break;
    }
    
    // Настраиваем параметр
    bool isLast = (i == 5); // Последний параметр - год
    if(!setTimeParam(params[i], A, isLast)) {
      // Отмена настройки
      return;
    }
  }
  
  // Все параметры настроены - устанавливаем время
  rtc.adjust(DateTime(A[5], A[4], A[3], A[2], A[1], 0));

  // Отправить минуты и часы на плату в уборной
  sendTimeToBluetooth(A[2], A[1]);
  
  // Выводим сообщение о завершении
  lcd.createChar(4, bukva_P);
  lcd.createChar(5, bukva_L);
  lcd.clear();
  lcd.setCursor(0, 1);
  lcd.print("     Bb|\4O\5HEHO");
  delay(2000);
  
  lcd.clear();
  timer = 0;
}

// Установить таймаут экрана
byte functionSet(int Param, int limit, byte interval) {

  needRedraw = true; 

  while (true) {              // Цикл настройки таймаута дисплея

    yield();

    if (needRedraw) {                         
      lcd.setCursor(14, k);
      lcd.print(" >   ");
      lcd.setCursor(16, k);
      lcd.print(Param);
      needRedraw = false;  
    }
    
    if (enc.isTurn()) {               // Если был поворот в любую сторону
      
      if (checkEncIsLeftRotate()) {     // Был поворов вправо
        Param += interval;
        if (Param>limit) Param = 0;
      }
             
      if (checkEncIsRightRotate()) {     // Был поворот влево
        Param -= interval;
        if (Param<=-1) Param = limit;
      }
      
      needRedraw = true;   // Есть изменения - необходимо отрисовать
    }

    if (enc.isPress()) {
      lcd.createChar(4, bukva_P);
      lcd.createChar(5, bukva_L);
      lcd.clear();
      lcd.setCursor(0, 1);
      lcd.print("     Bb|\4O\5HEHO");
      delay(2000);
      needRedraw = true;
      lcd.clear();
      return(Param);
    }
    
  }
}