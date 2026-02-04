#include "SimpleMQTTManager.h"

SimpleMQTTManager::SimpleMQTTManager(WiFiClient* wifi, 
                                     const String& server, 
                                     int port,
                                     const String& user,
                                     const String& password) 
  : wifiClient(wifi), mqttServer(server), mqttPort(port),
    mqttUser(user), mqttPassword(password) {
  mqttClient = new PubSubClient(*wifiClient);
}

SimpleMQTTManager::~SimpleMQTTManager() {
  delete mqttClient;
}

void SimpleMQTTManager::setDeviceId(const String& id) {
  deviceId = id;
}

bool SimpleMQTTManager::begin() {
  mqttClient->setServer(mqttServer.c_str(), mqttPort);
  mqttClient->setKeepAlive(60); // 60 секунд keepalive

  mqttClient->setBufferSize(512);
  
  mqttClient->setCallback([this](char* topic, byte* payload, unsigned int length) {
    String topicStr = String(topic);
    String message;
    
    for (int i = 0; i < length; i++) {
      message += (char)payload[i];
    }
    
    Serial.print("[MQTT] RX: ");
    Serial.print(topicStr);
    Serial.print(" -> ");
    Serial.println(message);
    
    for (int i = 0; i < handlerCount; i++) {
      if (handlers[i].topic == topicStr) {
        handlers[i].callback(topicStr, message);
        break;
      }
    }
  });
  
  // Не пытаемся подключиться сразу - пусть это делает loop()
  return true;
}

bool SimpleMQTTManager::tryConnect() {
  
  String clientId = deviceId;
  
  unsigned long start = millis();
  bool connected = false;
  
  while (millis() - start < CONNECT_TIMEOUT) {
    // +++ ДОБАВЬ ЭТОТ БЛОК +++
    if (mqttUser.length() > 0 && mqttPassword.length() > 0) {
      // Подключение с аутентификацией
      connected = mqttClient->connect(
        clientId.c_str(), 
        mqttUser.c_str(), 
        mqttPassword.c_str()
      );
      Serial.print("[MQTT] Connecting as: ");
      Serial.print(clientId);
      Serial.print(" with user: ");
      Serial.print(mqttUser);
      Serial.print(" password: ");
      Serial.println(mqttPassword.length() > 0 ? "***" : "(empty)");
    } else {
      // Подключение без аутентификации (старый код)
      connected = mqttClient->connect(clientId.c_str());
    }
    // +++ КОНЕЦ БЛОКА +++
    
    if (connected) break;
    
    yield();
    delay(10);
  }
  
  if (connected) {
    Serial.println("[MQTT] Connected to broker");
    isConnected = true;
    resubscribeAll();
    return true;
  }
  
  Serial.print("[MQTT] Connection failed, state: ");
  Serial.println(mqttClient->state());
  isConnected = false;
  return false;
}

void SimpleMQTTManager::resubscribeAll() {
  for (int i = 0; i < handlerCount; i++) {
    if (handlers[i].isSubscribed) {
      mqttClient->subscribe(handlers[i].topic.c_str());
      Serial.print("[MQTT] Subscribed to: ");
      Serial.println(handlers[i].topic);
    }
  }
}

bool SimpleMQTTManager::loop() {
  // ВСЕГДА вызываем loop() клиента - он сам разберется
  bool clientOk = mqttClient->loop();
  
  // Обновляем статус ПОСЛЕ вызова loop()
  isConnected = mqttClient->connected();
  
  // ТОЛЬКО если отключены, пробуем переподключиться
  static unsigned long lastConnectTry = 0;
  if (!isConnected && millis() - lastConnectTry > 15000) {
    lastConnectTry = millis();
    Serial.println("[MQTT] Reconnecting...");
    tryConnect();
  }
  
  yield();
  return isConnected;
}

bool SimpleMQTTManager::addHandler(const String& topic, 
                                   std::function<void(const String&, 
                                   const String&)> callback) {
  if (handlerCount >= MAX_HANDLERS) {
    Serial.println("[ERROR] Too many handlers");
    return false;
  }
  
  handlers[handlerCount].topic = topic;
  handlers[handlerCount].callback = callback;
  handlers[handlerCount].isSubscribed = true;
  handlerCount++;
  
  if (isConnected) {
    mqttClient->subscribe(topic.c_str());
  }
  
  return true;
}

bool SimpleMQTTManager::removeHandler(const String& topic) {
  for (int i = 0; i < handlerCount; i++) {
    if (handlers[i].topic == topic) {
      for (int j = i; j < handlerCount - 1; j++) {
        handlers[j] = handlers[j + 1];
      }
      handlerCount--;
      return true;
    }
  }
  return false;
}

bool SimpleMQTTManager::publish(const String& topic, const String& message) {
  Serial.println("\n=== PUBLISH DEBUG ===");
  Serial.print("1. isConnected: ");
  Serial.println(isConnected);
  
  if (!isConnected) {
    Serial.println("❌ FAIL: not connected");
    return false;
  }
  
  String fullTopic = deviceId + "/" + topic;
  Serial.print("2. Topic: ");
  Serial.println(fullTopic);
  Serial.print("3. Msg length: ");
  Serial.print(message.length());
  Serial.println(" chars");
  
  Serial.print("4. Calling mqttClient->publish()... ");
  bool result = mqttClient->publish(fullTopic.c_str(), message.c_str(), true);
  
  Serial.print("Result: ");
  Serial.println(result);
  
  Serial.print("5. After publish, connected: ");
  Serial.println(mqttClient->connected());
  Serial.print("6. State: ");
  Serial.println(mqttClient->state());
  
  isConnected = mqttClient->connected();
  
  if (result) {
    Serial.print("✅ TX: ");
    Serial.print(fullTopic);
    Serial.print(" -> ");
    if (message.length() > 50) {
      Serial.print(message.substring(0, 50));
      Serial.println("...");
    } else {
      Serial.println(message);
    }
  } else {
    Serial.println("❌ PUBLISH FAILED");
  }
  
  Serial.println("=== END DEBUG ===\n");
  return result;
}

bool SimpleMQTTManager::publish(const String& topic, const JsonDocument& doc) {
  String json;
  serializeJson(doc, json);
  return publish(topic, json);
}

String SimpleMQTTManager::status() {
  if (!isConnected) return "disconnected";
  return "connected (handlers: " + String(handlerCount) + ")";
}