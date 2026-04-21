import { useAuth } from '../context/AuthContext';

export const API_BASE_URL = true 
  ? 'https://api.tgapp.dotnetdon.ru'
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

  // HTTP методы
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

  getBaseUrl(): string {
    return API_BASE_URL;
  }

  async setCameraResolution(cameraId: string, resolution: 'QVGA' | 'VGA' | 'HD'): Promise<any> {
    console.log('🎯 setCameraResolution called:', { cameraId, resolution, accessKey: this.accessKey });
    
    if (!this.accessKey) {
      console.error('❌ No access key available');
      throw new AuthError('No access key available');
    }
    
    return this.fetch(`/esp_service/camera/${cameraId}/resolution`, {
      method: 'POST',
      body: JSON.stringify({ resolution })
    });
  }

  async getCameraStatus(cameraId: string): Promise<any> {
    if (!this.accessKey) {
      console.error('❌ No access key available');
      throw new AuthError('No access key available');
    }
    
    return this.fetch(`/esp_service/camera/${cameraId}/status`, {
      method: 'GET'
    });
  }

  // 🔧 ИСПРАВЛЕНО: getVideos возвращает полный ответ API
  async getVideos(camera_id: string): Promise<any> {
      const queryParams = new URLSearchParams();
      
      if (camera_id) queryParams.append('camera_id', camera_id);
      
      const queryString = queryParams.toString();
      const endpoint = `/esp_service/videos${queryString ? `?${queryString}` : ''}`;
      
      console.log('🔍 GET Videos request:', `${API_BASE_URL}${endpoint}`);
      
      const response = await this.fetch(endpoint);
      
      console.log('📦 Videos response:', response);
      console.log('📼 Videos count:', response?.videos?.length || response?.length);
      
      // 🔧 Возвращаем как есть - API сам решит формат
      return response;
  }

  // 🔧 ИСПРАВЛЕНО: download использует video_id вместо key
  async downloadVideo(cameraId: string, videoId: string): Promise<Blob> {
    const response = await this.fetchRaw(
      `/esp_service/videos/download?video_id=${encodeURIComponent(videoId)}&camera_id=${encodeURIComponent(cameraId)}`
    );
    
    if (!response.ok) {
      throw new Error(`Failed to download video: ${response.status}`);
    }
    
    return await response.blob();
  }

  // 🔧 ДОБАВЛЕНО: управление вентилятором
  async setCameraFan(cameraId: string, enable: boolean): Promise<any> {
    if (!this.accessKey) {
      throw new AuthError('No access key available');
    }
    
    return this.fetch(`/esp_service/camera/${cameraId}/fan`, {
      method: 'POST',
      body: JSON.stringify({ enable })
    });
  }

  createCameraWebSocket(cameraId: string, options: any = {}) {
      if (!this.accessKey) {
          console.error('❌ No access key available for WebSocket');
          throw new AuthError('No access key available');
      }

      const wsBaseUrl = getWebSocketBaseUrl();
      const wsUrl = `${wsBaseUrl}/esp_service/ws/view/${cameraId}`;
      
      console.log(`🔌 Connecting to ${wsUrl}`);
      
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      
      let reconnectAttempts = 0;
      const maxReconnectAttempts = 5;
      
      ws.onopen = () => {
          console.log(`🟢 WebSocket connected for ${cameraId}`);
          reconnectAttempts = 0;
          (ws as any).isManualClose = false;
          
          // Отправляем авторизацию первым сообщением
          const authMessage = JSON.stringify({
              type: 'auth',
              access_key: this.accessKey
          });
          ws.send(authMessage);
          
          if (options.fps) {
              ws.send(`fps:${options.fps}`);
          }
          
          options.onOpen?.();
      };
      
      ws.onmessage = (event) => {
          if (typeof event.data === 'string') {
              // Только отвечаем на пинг от сервера
              if (event.data === 'ping') {
                  ws.send('pong');
              }
              options.onMessage?.(event.data);
          } else {
              // Бинарные данные — кадры JPEG
              const blob = new Blob([event.data], { type: 'image/jpeg' });
              options.onFrame?.(blob);
          }
      };
      
      ws.onerror = (error) => {
          console.error(`🔴 WebSocket error for ${cameraId}:`, error);
          options.onError?.(error);
      };
      
      ws.onclose = (event) => {
          console.log(`🔌 WebSocket closed for ${cameraId}: code=${event.code}, clean=${event.wasClean}`);
          
          if ((ws as any).pingInterval) {
              clearInterval((ws as any).pingInterval);
          }
          
          this.wsConnections.delete(cameraId);
          options.onClose?.(event.code, event.reason);
          
          const isManual = (ws as any).isManualClose;
          if (!isManual && reconnectAttempts < maxReconnectAttempts) {
              reconnectAttempts++;
              console.log(`🔄 Reconnect attempt ${reconnectAttempts}/${maxReconnectAttempts}`);
              setTimeout(() => {
                  if (!this.wsConnections.has(cameraId)) {
                      this.createCameraWebSocket(cameraId, options);
                  }
              }, 2000 * reconnectAttempts);
          }
      };
      
      this.wsConnections.set(cameraId, ws);
      return ws;
  }

  closeCameraWebSocket(cameraId: string) {
    const ws = this.wsConnections.get(cameraId);
    if (ws) {
      console.log(`🔌 Closing WebSocket for camera ${cameraId}, current state: ${ws.readyState}`);
      
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      
      (ws as any).isManualClose = true;
      
      if ((ws as any).pingInterval) {
        clearInterval((ws as any).pingInterval);
      }
      
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, 'Closed by client');
      }
      
      this.wsConnections.delete(cameraId);
      console.log(`✅ WebSocket for camera ${cameraId} closed and removed from Map`);
    }
  }

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