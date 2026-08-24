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

export interface ChatMessage {
  seq: number;
  user_id: number;
  username: string;
  type: 'text' | 'image' | 'audio' | 'video';
  text: string;
  media_key: string;
  media_kind: string; // '' | 'circle'
  ts: string;
}

export interface ChatReadState {
  user_id: number;
  display_name: string;
  last_read_seq: number;
  read_at: string | null;
}

export type ChatWsEvent =
  | { type: 'message'; data: ChatMessage }
  | { type: 'read'; data: { user_id: number; seq: number; at: string } };

class ApiClient {
  private wsConnections: Map<string, WebSocket> = new Map();
  private reconnectTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

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

  async getSettings(): Promise<any> {
    return this.fetch('/esp_service/settings');
  }

  async updateSettings(settings: any): Promise<any> {
    return this.fetch('/esp_service/settings', {
      method: 'POST',
      body: JSON.stringify(settings),
    });
  }

  createCameraWebSocket(cameraId: string, options: any = {}, attempt: number = 0) {
    const wsUrl = `${getWebSocketBaseUrl()}/esp_service/ws/view/${cameraId}`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    const maxReconnectAttempts = 5;

    ws.onopen = () => {
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
          return;
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
      this.wsConnections.delete(cameraId);
      options.onClose?.(event.code, event.reason);

      const isManual = (ws as any).isManualClose;
      if (isManual) return;

      if (attempt < maxReconnectAttempts) {
        const nextAttempt = attempt + 1;
        const timer = setTimeout(() => {
          this.reconnectTimers.delete(cameraId);
          if (!this.wsConnections.has(cameraId)) {
            this.createCameraWebSocket(cameraId, options, nextAttempt);
          }
        }, 2000 * nextAttempt);
        this.reconnectTimers.set(cameraId, timer);
      } else {
        options.onReconnectExhausted?.();
      }
    };

    this.wsConnections.set(cameraId, ws);
    return ws;
  }

  closeCameraWebSocket(cameraId: string) {
    const timer = this.reconnectTimers.get(cameraId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(cameraId);
    }

    const ws = this.wsConnections.get(cameraId);
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      (ws as any).isManualClose = true;

      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, 'Closed by client');
      }

      this.wsConnections.delete(cameraId);
    }
  }

  closeAllWebSockets() {
    this.reconnectTimers.forEach((timer) => clearTimeout(timer));
    this.reconnectTimers.clear();
    this.wsConnections.forEach((ws) => {
      ws.close(1000, 'Closing all connections');
    });
    this.wsConnections.clear();
  }

  // ───────────────────── ЧАТ ─────────────────────

  async getChatMessages(beforeSeq?: number, limit = 50): Promise<{ messages: ChatMessage[] }> {
    const params = new URLSearchParams();
    if (beforeSeq !== undefined) params.append('before_seq', String(beforeSeq));
    params.append('limit', String(limit));
    return this.fetch(`/chat/messages?${params.toString()}`);
  }

  async sendChatMessage(payload: {
    type: 'text' | 'image' | 'audio' | 'video';
    text?: string;
    mediaKind?: string;
    file?: Blob;
    fileName?: string;
  }): Promise<ChatMessage> {
    const form = new FormData();
    form.append('type', payload.type);
    if (payload.text) form.append('text', payload.text);
    if (payload.mediaKind) form.append('media_kind', payload.mediaKind);
    if (payload.file) form.append('file', payload.file, payload.fileName ?? 'upload');

    const response = await fetch(`${API_BASE_URL}/chat/messages`, {
      method: 'POST',
      body: form,
      credentials: 'include',
    });

    if (response.status === 401 || response.status === 403) {
      throw new AuthError('Invalid or expired session');
    }
    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      throw new Error(detail?.detail ?? `HTTP error! status: ${response.status}`);
    }
    return response.json();
  }

  async markChatRead(): Promise<{ user_id: number; seq: number; at: string }> {
    return this.fetch('/chat/read', { method: 'POST' });
  }

  async getChatReadStates(): Promise<{ reads: ChatReadState[] }> {
    return this.fetch('/chat/read_states');
  }

  async getChatUnreadCount(): Promise<{ unread_count: number }> {
    return this.fetch('/chat/unread_count');
  }

  async getChatMediaUrl(mediaKey: string): Promise<{ url: string }> {
    return this.fetch(`/chat/media/${mediaKey}`);
  }

  async getVapidPublicKey(): Promise<{ public_key: string }> {
    return this.fetch('/chat/push/vapid_public_key');
  }

  async subscribeChatPush(subscription: PushSubscriptionJSON): Promise<{ status: string }> {
    return this.fetch('/chat/push/subscribe', {
      method: 'POST',
      body: JSON.stringify(subscription),
    });
  }

  async unsubscribeChatPush(): Promise<{ status: string }> {
    return this.fetch('/chat/push/unsubscribe', { method: 'POST' });
  }

  createChatWebSocket(options: {
    onOpen?: () => void;
    onEvent?: (event: ChatWsEvent) => void;
    onError?: (error: any) => void;
    onClose?: (code: number, reason: string) => void;
  } = {}) {
    const wsKey = 'chat';
    const wsUrl = `${getWebSocketBaseUrl()}/chat/ws`;
    const ws = new WebSocket(wsUrl);

    let reconnectAttempts = 0;
    const maxReconnectAttempts = 5;

    ws.onopen = () => {
      reconnectAttempts = 0;
      (ws as any).isManualClose = false;
      options.onOpen?.();
    };

    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return;

      if (event.data === 'ping') {
        ws.send('pong');
        return;
      }
      if (event.data === 'pong' || event.data === 'AUTH_OK') return;
      if (event.data.startsWith('ERROR')) {
        options.onError?.(event.data);
        return;
      }

      try {
        const parsed = JSON.parse(event.data) as ChatWsEvent;
        options.onEvent?.(parsed);
      } catch {
        // не JSON-событие — игнорируем
      }
    };

    ws.onerror = (error) => {
      options.onError?.(error);
    };

    ws.onclose = (event) => {
      this.wsConnections.delete(wsKey);
      options.onClose?.(event.code, event.reason);

      const isManual = (ws as any).isManualClose;
      if (!isManual && reconnectAttempts < maxReconnectAttempts) {
        reconnectAttempts++;
        setTimeout(() => {
          if (!this.wsConnections.has(wsKey)) {
            this.createChatWebSocket(options);
          }
        }, 2000 * reconnectAttempts);
      }
    };

    this.wsConnections.set(wsKey, ws);
    return ws;
  }

  closeChatWebSocket() {
    const ws = this.wsConnections.get('chat');
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      (ws as any).isManualClose = true;

      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, 'Closed by client');
      }

      this.wsConnections.delete('chat');
    }
  }
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export const apiClient = new ApiClient();
