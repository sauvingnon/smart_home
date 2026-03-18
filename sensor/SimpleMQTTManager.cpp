#include "SimpleMQTTManager.h"

// Флаг для отладки - true = вывод в Serial, false = тишина
static const bool MQTT_DEBUG = false;

#define MQTT_DEBUG_PRINT(...) do { if (MQTT_DEBUG) Serial.print(__VA_ARGS__); } while(0)
#define MQTT_DEBUG_PRINTLN(...) do { if (MQTT_DEBUG) Serial.println(__VA_ARGS__); } while(0)
#define MQTT_DEBUG_PRINTF(...) do { if (MQTT_DEBUG) Serial.printf(__VA_ARGS__); } while(0)

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
  mqttClient->setKeepAlive(60);
  
  mqttClient->setBufferSize(1024);
  
  mqttClient->setCallback([this](char* topic, byte* payload, unsigned int length) {
    String topicStr = String(topic);
    String message;
    
    for (int i = 0; i < length; i++) {
      message += (char)payload[i];
    }
    
    MQTT_DEBUG_PRINT("[MQTT] RX: ");
    MQTT_DEBUG_PRINT(topicStr);
    MQTT_DEBUG_PRINT(" -> ");
    MQTT_DEBUG_PRINTLN(message);
    
    for (int i = 0; i < handlerCount; i++) {
      if (handlers[i].topic == topicStr) {
        handlers[i].callback(topicStr, message);
        break;
      }
    }
  });
  
  return true;
}

bool SimpleMQTTManager::tryConnect() {
  String clientId = deviceId;
  
  unsigned long start = millis();
  bool connected = false;
  
  MQTT_DEBUG_PRINTLN("[MQTT] Attempting connection...");
  
  while (millis() - start < CONNECT_TIMEOUT) {
    if (mqttUser.length() > 0 && mqttPassword.length() > 0) {
      connected = mqttClient->connect(
        clientId.c_str(), 
        mqttUser.c_str(), 
        mqttPassword.c_str()
      );
      
      MQTT_DEBUG_PRINT("[MQTT] Connecting as: ");
      MQTT_DEBUG_PRINT(clientId);
      MQTT_DEBUG_PRINT(" with user: ");
      MQTT_DEBUG_PRINT(mqttUser);
      MQTT_DEBUG_PRINT(" password: ");
      MQTT_DEBUG_PRINTLN(mqttPassword.length() > 0 ? "***" : "(empty)");
    } else {
      connected = mqttClient->connect(clientId.c_str());
      MQTT_DEBUG_PRINT("[MQTT] Connecting without auth as: ");
      MQTT_DEBUG_PRINTLN(clientId);
    }
    
    if (connected) break;
    
    yield();
    delay(10);
  }
  
  if (connected) {
    MQTT_DEBUG_PRINTLN("[MQTT] Connected to broker");
    isConnected = true;
    resubscribeAll();
    return true;
  }
  
  MQTT_DEBUG_PRINT("[MQTT] Connection failed, state: ");
  MQTT_DEBUG_PRINTLN(mqttClient->state());
  isConnected = false;
  return false;
}

void SimpleMQTTManager::resubscribeAll() {
  for (int i = 0; i < handlerCount; i++) {
    if (handlers[i].isSubscribed) {
      mqttClient->subscribe(handlers[i].topic.c_str());
      MQTT_DEBUG_PRINT("[MQTT] Subscribed to: ");
      MQTT_DEBUG_PRINTLN(handlers[i].topic);
    }
  }
}

bool SimpleMQTTManager::loop() {
  bool clientOk = mqttClient->loop();
  
  isConnected = mqttClient->connected();
  
  static unsigned long lastConnectTry = 0;
  if (!isConnected && millis() - lastConnectTry > 15000) {
    lastConnectTry = millis();
    MQTT_DEBUG_PRINTLN("[MQTT] Reconnecting...");
    tryConnect();
  }
  
  yield();
  return isConnected;
}

bool SimpleMQTTManager::addHandler(const String& topic, 
                                   std::function<void(const String&, 
                                   const String&)> callback) {
  if (handlerCount >= MAX_HANDLERS) {
    MQTT_DEBUG_PRINTLN("[ERROR] Too many handlers");
    return false;
  }
  
  handlers[handlerCount].topic = topic;
  handlers[handlerCount].callback = callback;
  handlers[handlerCount].isSubscribed = true;
  handlerCount++;
  
  if (isConnected) {
    mqttClient->subscribe(topic.c_str());
    MQTT_DEBUG_PRINT("[MQTT] Subscribed to: ");
    MQTT_DEBUG_PRINTLN(topic);
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
      MQTT_DEBUG_PRINT("[MQTT] Removed handler for: ");
      MQTT_DEBUG_PRINTLN(topic);
      return true;
    }
  }
  return false;
}

bool SimpleMQTTManager::publish(const String& topic, const String& message) {
  MQTT_DEBUG_PRINTLN("\n=== PUBLISH DEBUG ===");
  MQTT_DEBUG_PRINT("1. isConnected: ");
  MQTT_DEBUG_PRINTLN(isConnected);
  
  if (!isConnected) {
    MQTT_DEBUG_PRINTLN("❌ FAIL: not connected");
    return false;
  }
  
  String fullTopic = deviceId + "/" + topic;
  MQTT_DEBUG_PRINT("2. Topic: ");
  MQTT_DEBUG_PRINTLN(fullTopic);
  MQTT_DEBUG_PRINT("3. Msg length: ");
  MQTT_DEBUG_PRINT(message.length());
  MQTT_DEBUG_PRINTLN(" chars");
  
  MQTT_DEBUG_PRINT("4. Calling mqttClient->publish()... ");
  bool result = mqttClient->publish(fullTopic.c_str(), message.c_str(), true);
  
  MQTT_DEBUG_PRINT("Result: ");
  MQTT_DEBUG_PRINTLN(result);
  
  MQTT_DEBUG_PRINT("5. After publish, connected: ");
  MQTT_DEBUG_PRINTLN(mqttClient->connected());
  MQTT_DEBUG_PRINT("6. State: ");
  MQTT_DEBUG_PRINTLN(mqttClient->state());
  
  isConnected = mqttClient->connected();
  
  if (result) {
    MQTT_DEBUG_PRINT("✅ TX: ");
    MQTT_DEBUG_PRINT(fullTopic);
    MQTT_DEBUG_PRINT(" -> ");
    if (message.length() > 50) {
      MQTT_DEBUG_PRINT(message.substring(0, 50));
      MQTT_DEBUG_PRINTLN("...");
    } else {
      MQTT_DEBUG_PRINTLN(message);
    }
  } else {
    MQTT_DEBUG_PRINTLN("❌ PUBLISH FAILED");
  }
  
  MQTT_DEBUG_PRINTLN("=== END DEBUG ===\n");
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