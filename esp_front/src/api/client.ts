// Для локальной разработки: VITE_API_URL=http://localhost:8005
// В продакшене nginx проксирует /api/ → backend, VITE_API_URL не нужен
export const API_BASE_URL: string = import.meta.env.VITE_API_URL ?? '/api';

export const getWebSocketBaseUrl = (): string => {
  if (API_BASE_URL.startsWith('http')) {
    return API_BASE_URL.replace(/^http/, 'ws');
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${API_BASE_URL}`;
};

class ApiClient {
  private wsConnections: Map<string, WebSocket> = new Map();

  async fetchRaw(endpoint: string, options: RequestInit = {}) {
    return fetch(`${API_BASE_URL}${endpoint}`, {
      ...options,
      credentials: 'include',
    });
  }

  async fetch(endpoint: string, options: RequestInit = {}) {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
      credentials: 'include',
    });

    if (response.status === 401 || response.status === 403) {
      throw new AuthError('Invalid or expired session');
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
    return this.fetch(`/esp_service/camera/${cameraId}/resolution`, {
      method: 'POST',
      body: JSON.stringify({ resolution }),
    });
  }

  async getCameraStatus(cameraId: string): Promise<any> {
    return this.fetch(`/esp_service/camera/${cameraId}/status`);
  }

  async getVideos(camera_id: string): Promise<any> {
    const queryParams = new URLSearchParams();
    if (camera_id) queryParams.append('camera_id', camera_id);
    const queryString = queryParams.toString();
    return this.fetch(`/esp_service/videos${queryString ? `?${queryString}` : ''}`);
  }

  async downloadVideo(cameraId: string, videoId: string): Promise<Blob> {
    const response = await this.fetchRaw(
      `/esp_service/videos/download?video_id=${encodeURIComponent(videoId)}&camera_id=${encodeURIComponent(cameraId)}`
    );
    if (!response.ok) {
      throw new Error(`Failed to download video: ${response.status}`);
    }
    return response.blob();
  }

  async setCameraFan(cameraId: string, mode: 0 | 1 | 2): Promise<any> {
    return this.fetch(`/esp_service/camera/${cameraId}/fan`, {
      method: 'POST',
      body: JSON.stringify({ mode }),
    });
  }

  createCameraWebSocket(cameraId: string, options: any = {}) {
    const wsUrl = `${getWebSocketBaseUrl()}/esp_service/ws/view/${cameraId}`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    let reconnectAttempts = 0;
    const maxReconnectAttempts = 5;

    ws.onopen = () => {
      reconnectAttempts = 0;
      (ws as any).isManualClose = false;

      if (options.fps) {
        ws.send(`fps:${options.fps}`);
      }

      options.onOpen?.();
    };

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        if (event.data === 'ping') {
          ws.send('pong');
        }
        options.onMessage?.(event.data);
      } else {
        const blob = new Blob([event.data], { type: 'image/jpeg' });
        options.onFrame?.(blob);
      }
    };

    ws.onerror = (error) => {
      options.onError?.(error);
    };

    ws.onclose = (event) => {
      if ((ws as any).pingInterval) {
        clearInterval((ws as any).pingInterval);
      }

      this.wsConnections.delete(cameraId);
      options.onClose?.(event.code, event.reason);

      const isManual = (ws as any).isManualClose;
      if (!isManual && reconnectAttempts < maxReconnectAttempts) {
        reconnectAttempts++;
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
