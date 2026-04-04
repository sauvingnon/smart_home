import { useAuth } from '../context/AuthContext';
// Прод?
export const API_BASE_URL = false 
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

  async setCameraResolution(cameraId: string, resolution: 'QVGA' | 'VGA' | 'HD'): Promise<any> {
    console.log('🎯 setCameraResolution called:', { cameraId, resolution, accessKey: this.accessKey });
    
    if (!this.accessKey) {
      console.error('❌ No access key available');
      throw new AuthError('No access key available');
    }
    
    // 👇 Используем fetch с ключом в headers, а не в URL
    return this.fetch(`/esp_service/camera/${cameraId}/resolution`, {
      method: 'POST',
      body: JSON.stringify({ resolution }) // тело запроса
    });
  }

  async getCameraStatus(cameraId: string): Promise<any> {
    if (!this.accessKey) {
      console.error('❌ No access key available');
      throw new AuthError('No access key available');
    }
    
    // GET запрос с ключом в headers
    return this.fetch(`/esp_service/camera/${cameraId}/status`, {
      method: 'GET'
    });
  }

  async getVideos(params?: {
    camera_id?: string;
  }): Promise<any[]> {
    const queryParams = new URLSearchParams();
    
    if (params?.camera_id) queryParams.append('camera_id', params.camera_id);
    
    const queryString = queryParams.toString();
    const endpoint = `/esp_service/videos${queryString ? `?${queryString}` : ''}`;
    
    console.log('🔍 GET Videos request:', `${API_BASE_URL}${endpoint}`);
    console.log('🔑 Access key present:', !!this.accessKey);
    
    const response = await this.fetch(endpoint);
    
    console.log('📦 Raw videos response:', response);
    console.log('📊 Response type:', typeof response);
    console.log('📈 Is array?', Array.isArray(response));
    console.log('🔢 Length:', response?.length);
    
    return response;
  }

  getVideoStreamUrl(key: string): string {
    return `${API_BASE_URL}/esp_service/videos/stream?key=${encodeURIComponent(key)}`;
  }

  async getVideoDownloadUrl(key: string): Promise<{ url: string; key: string }> {
    return this.fetch(`/esp_service/videos/download?key=${encodeURIComponent(key)}`);
  }

  getVideoThumbnailUrl(cameraId: string, timestamp: number): string {
    return `${API_BASE_URL}/esp_service/videos/thumbnail?camera_id=${encodeURIComponent(cameraId)}&timestamp=${timestamp}`;
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
      ws.binaryType = 'arraybuffer';
      
      let reconnectAttempts = 0;
      const maxReconnectAttempts = 5;
      
      const connect = () => {
          ws.onopen = () => {
              console.log(`🟢 WebSocket connected for camera ${cameraId}`);
              reconnectAttempts = 0;
              (ws as any).isManualClose = false;
              
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
                  // event.data - это ArrayBuffer
                  const blob = new Blob([event.data], { type: 'image/jpeg' });
                  options.onFrame?.(blob);
              }
          };
          
          ws.onerror = (error) => {
              console.error(`🔴 WebSocket error for camera ${cameraId}:`, error);
              console.error(`Error event:`, error);
              options.onError?.(error);
          };
          
          ws.onclose = (event) => {
              const isManual = (ws as any).isManualClose;
              console.log(`🔌 WebSocket closed for camera ${cameraId}:`);
              console.log(`  Code: ${event.code}, Reason: ${event.reason}`);
              console.log(`  Was clean: ${event.wasClean}`);
              console.log(`  Is manual close: ${isManual}`);
              
              if ((ws as any).pingInterval) {
                  clearInterval((ws as any).pingInterval);
              }
              
              this.wsConnections.delete(cameraId);
              options.onClose?.(event.code, event.reason);
              
              // Пробуем переподключиться
              if (!isManual && reconnectAttempts < maxReconnectAttempts) {
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
      console.log(`🔌 Closing WebSocket for camera ${cameraId}, current state: ${ws.readyState}`);
      
      // Убираем слушатели событий, чтобы избежать утечек
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      
      // Помечаем как ручное закрытие
      (ws as any).isManualClose = true;
      
      // Останавливаем ping интервал
      if ((ws as any).pingInterval) {
        clearInterval((ws as any).pingInterval);
      }
      
      // Закрываем соединение, если оно не закрыто
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, 'Closed by client');
      }
      
      this.wsConnections.delete(cameraId);
      console.log(`✅ WebSocket for camera ${cameraId} closed and removed from Map`);
    } else {
      console.log(`ℹ️ No active WebSocket found for camera ${cameraId}`);
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