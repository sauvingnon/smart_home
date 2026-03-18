const int trigPin = 5;
const int echoPin = 4;
const int camWakePin = 12;
const int ledPin = 13;

// Параметры детектора движения
const int motionThreshold = 5;      // см - минимальное изменение для "движения"
const int stabilizationDelay = 100;  // мс - задержка между замерами
const int motionWindow = 5;          // сколько замеров подряд смотрим

float readings[motionWindow];       // буфер последних измерений
int readIndex = 0;
float total = 0;
float average = 0;

bool motionDetected = false;
unsigned long lastMotionTime = 0;
const unsigned long minTriggerInterval = 2000; // Минимум 2 сек между триггерами

void setup() {
  Serial.begin(115200);
  
  pinMode(trigPin, OUTPUT);
  pinMode(echoPin, INPUT);
  pinMode(camWakePin, OUTPUT);
  pinMode(ledPin, OUTPUT);
  
  digitalWrite(camWakePin, LOW);
  digitalWrite(ledPin, LOW);
  
  // Инициализируем буфер
  for (int i = 0; i < motionWindow; i++) {
    readings[i] = 0;
  }
  
  Serial.println("Motion detector (physics 8th grade edition)");
  Serial.println("Watching for CHANGES, not distance");
}

void loop() {
  float currentDistance = measureDistance();
  
  if (currentDistance > 0) {
    // Физика 8 класс: вычисляем изменение
    float change = abs(currentDistance - getAverageDistance());
    
    // Добавляем в буфер для следующего раза
    addToBuffer(currentDistance);
    
    // Если изменение больше порога - ЭТО ДВИЖЕНИЕ!
    if (change > motionThreshold) {
      Serial.print("MOTION DETECTED! Change: ");
      Serial.print(change);
      Serial.println(" cm");
      
      digitalWrite(ledPin, HIGH);
      
      // Проверяем не дёргали ли недавно
      if (millis() - lastMotionTime > minTriggerInterval) {
        triggerCamera();
        lastMotionTime = millis();
      }
    } else {
      digitalWrite(ledPin, LOW);
    }
    
    // Выводим инфу для понимания
    Serial.print("Dist: ");
    Serial.print(currentDistance);
    Serial.print(" cm | Avg: ");
    Serial.print(getAverageDistance());
    Serial.print(" cm | Change: ");
    Serial.print(change);
    Serial.println(" cm");
  }
  
  delay(stabilizationDelay);
}

float measureDistance() {
  digitalWrite(trigPin, LOW);
  delayMicroseconds(2);
  digitalWrite(trigPin, HIGH);
  delayMicroseconds(10);
  digitalWrite(trigPin, LOW);
  
  long duration = pulseIn(echoPin, HIGH, 30000);
  
  if (duration == 0) return 0;
  return duration * 0.034 / 2;
}

void addToBuffer(float value) {
  total = total - readings[readIndex];
  readings[readIndex] = value;
  total = total + readings[readIndex];
  readIndex = (readIndex + 1) % motionWindow;
}

float getAverageDistance() {
  return total / motionWindow;
}

void triggerCamera() {
  Serial.println(">>> CAMERA WAKE UP CALL! <<<");
  
  digitalWrite(camWakePin, HIGH);
  delay(500);  // Полсекунды импульс
  digitalWrite(camWakePin, LOW);
}