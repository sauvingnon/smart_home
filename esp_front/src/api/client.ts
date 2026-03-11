import { useAuth } from '../context/AuthContext';
// Прод?
export const API_BASE_URL = true 
  ? 'https://tgapp.dotnetdon.ru:4444'
  : 'http://localhost:8005';

// Определяем WebSocket URL на основе API_BASE_URL
export const getWebSocketBaseUrl = (): string => {
  if (API_BASE_URL.startsWith('https')) {
    return API_BASE_URL.replace('https', 'wss');
  } else {
    return API_BASE_URL.replace('http', 'ws');
  }
};

class ApiClient {
  private accessKey: string | null = null;
  private wsConnections: Map<string, WebSocket> = new Map();

  setAccessKey(key: string | null) {
    this.accessKey = key;
  }

  getAccessKey(): string | null {
    return this.accessKey;
  }

  // HTTP методы (твои существующие)
  async fetchRaw(endpoint: string, options: RequestInit = {}) {
    const headers: HeadersInit = {
      ...options.headers,
    };

    if (this.accessKey) {
      headers['X-Access-Key'] = this.accessKey;
    }

    return fetch(`${API_BASE_URL}${endpoint}`, {
      ...options,
      headers,
    });
  }

  async fetch(endpoint: string, options: RequestInit = {}) {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    if (this.accessKey) {
      headers['X-Access-Key'] = this.accessKey;
    }

    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      ...options,
      headers,
    });

    if (response.status === 401 || response.status === 403) {
      throw new AuthError('Invalid or expired key');
    }

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    return response.json();
  }

    // 👇 НОВЫЙ МЕТОД: создание WebSocket подключения к камере с ключом в заголовках
  createCameraWebSocket(cameraId: string, options: any = {}) {
      if (!this.accessKey) {
          console.error('❌ No access key available for WebSocket');
          throw new AuthError('No access key available');
      }

      const wsBaseUrl = getWebSocketBaseUrl();
      const wsUrl = `${wsBaseUrl}/esp_service/ws/view/${cameraId}`;
      
      console.log(`🔌 Creating WebSocket for camera ${cameraId}`);
      console.log(`📍 WS URL: ${wsUrl}`);
      console.log(`🔑 Access key: ${this.accessKey.substring(0, 5)}...`);
      console.log(`📤 Will send protocols: ['access_key', '${this.accessKey}']`);
      
      const ws = new WebSocket(wsUrl, ['access_key', this.accessKey]);
      ws.binaryType = 'blob';
      
      let reconnectAttempts = 0;
      const maxReconnectAttempts = 5;
      
      const connect = () => {
          ws.onopen = () => {
              console.log(`🟢 WebSocket connected for camera ${cameraId}`);
              reconnectAttempts = 0;
              
              // Отправляем ping сразу
              ws.send('ping');
              
              // И каждые 5 секунд
              const pingInterval = setInterval(() => {
                  if (ws.readyState === WebSocket.OPEN) {
                      ws.send('ping');
                  }
              }, 5000);
              
              (ws as any).pingInterval = pingInterval;
              
              if (options.fps) {
                  ws.send(`fps:${options.fps}`);
              }
              options.onOpen?.();
          };
          
          ws.onmessage = (event) => {
              if (typeof event.data === 'string') {
                  console.log(`📨 WS text from ${cameraId}:`, event.data);
                  options.onMessage?.(event.data);
              } else {
                  options.onFrame?.(event.data);
              }
          };
          
          ws.onerror = (error) => {
              console.error(`🔴 WebSocket error for camera ${cameraId}:`, error);
              console.error(`Error event:`, error);
              options.onError?.(error);
          };
          
          ws.onclose = (event) => {
              console.log(`🔌 WebSocket closed for camera ${cameraId}:`);
              console.log(`  Code: ${event.code}, Reason: ${event.reason}`);
              console.log(`  Was clean: ${event.wasClean}`);
              
              if ((ws as any).pingInterval) {
                  clearInterval((ws as any).pingInterval);
              }
              
              this.wsConnections.delete(cameraId);
              options.onClose?.(event.code, event.reason);
              
              // Пробуем переподключиться
              if (reconnectAttempts < maxReconnectAttempts) {
                  reconnectAttempts++;
                  console.log(`🔄 Reconnect attempt ${reconnectAttempts}/${maxReconnectAttempts} for ${cameraId}`);
                  setTimeout(() => {
                      if (!this.wsConnections.has(cameraId)) {
                          this.createCameraWebSocket(cameraId, options);
                      }
                  }, 2000 * reconnectAttempts);
              }
          };
      };
      
      connect();
      
      this.wsConnections.set(cameraId, ws);
      return ws;
  }

  // Закрыть WebSocket для конкретной камеры
  closeCameraWebSocket(cameraId: string) {
    const ws = this.wsConnections.get(cameraId);
    if (ws) {
      ws.close(1000, 'Closed by client');
      this.wsConnections.delete(cameraId);
    }
  }

  // Закрыть все WebSocket соединения
  closeAllWebSockets() {
    this.wsConnections.forEach((ws) => {
      ws.close(1000, 'Closing all connections');
    });
    this.wsConnections.clear();
  }
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export const apiClient = new ApiClient();