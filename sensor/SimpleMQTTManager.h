#ifndef SIMPLEMQTTMANAGER_H
#define SIMPLEMQTTMANAGER_H

#include <ESP8266WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <functional>

#define MAX_HANDLERS 30
#define MQTT_LOOP_TIMEOUT 50     // Максимум 50мс на mqtt.loop()
#define RECONNECT_INTERVAL 10000 // Переподключение раз в 10 секунд
#define CONNECT_TIMEOUT 3000     // Таймаут подключения 3 секунды

struct TopicHandler {
  String topic;
  std::function<void(const String&, const String&)> callback;
  bool isSubscribed;
};

class SimpleMQTTManager {
private:
  PubSubClient* mqttClient;
  WiFiClient* wifiClient;
  
  String deviceId;
  String mqttServer;
  int mqttPort;
  String mqttUser;
  String mqttPassword;
  
  TopicHandler handlers[MAX_HANDLERS];
  int handlerCount = 0;
  
  unsigned long lastConnectAttempt = 0;
  unsigned long lastMqttLoop = 0;
  bool isConnected = false;
  
  bool tryConnect(); // НЕБЛОКИРУЮЩЕЕ подключение
  void resubscribeAll();
  
public:
  SimpleMQTTManager(WiFiClient* wifi, 
                    const String& server, 
                    int port = 1883,
                    const String& user = "",
                    const String& password = "");
  ~SimpleMQTTManager();
  
  void setDeviceId(const String& id);
  bool begin();
  
  // НЕБЛОКИРУЮЩИЙ loop - возвращает true если нужно вызвать снова
  bool loop();
  
  bool addHandler(const String& topic, 
                  std::function<void(const String&, const String&)> callback);
  bool removeHandler(const String& topic);
  
  bool publish(const String& topic, const String& message);
  bool publish(const String& topic, const JsonDocument& doc);
  
  bool connected() { return isConnected; }
  String getClientId() { return deviceId; }
  String status();
};

#endif