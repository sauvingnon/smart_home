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

// Базовый набор реакций. Дублирует ALLOWED_REACTIONS на бэке (он же и
// валидирует) — здесь это и кнопки пикера, и порядок чипсов под сообщением:
// сортировка по этому списку, а не по тому, кто отреагировал первым, иначе
// чипсы перетасовывались бы на каждую чужую реакцию.
export const REACTION_EMOJI: readonly string[] = ['👍', '❤️', '🔥', '😁', '😢', '👎'];

export interface ChatReaction {
  emoji: string;
  // Кто поставил. Не счётчик: по этим id подсвечивается своя реакция, и из них
  // же берутся имена (они уже есть в presence) для подписи «кто отреагировал».
  user_ids: number[];
}

export interface ChatMessage {
  seq: number;
  user_id: number;
  username: string;
  type: 'text' | 'image' | 'audio' | 'video' | 'system';
  text: string;
  media_key: string;
  media_kind: string; // '' | 'circle'
  // Превью для ленты: у video — первый кадр, у image — уменьшенная копия.
  // Оригинал в ленту не тянем, он нужен только в лайтбоксе.
  thumbnail_key: string;
  // Геометрия кадра (только image) — пропорции пузыря известны до того, как
  // приедут байты. 0 у сообщений, отправленных до появления полей: у них
  // рамка остаётся прежнего фиксированного размера.
  media_w: number;
  media_h: number;
  // Крошка-заглушка: 16px кадр data-URI'ем прямо в сообщении. Приезжает по WS
  // вместе с ним и рисуется размытым пятном, пока из S3 едет превью.
  media_preview: string;
  ts: string;
  // Ответ на сообщение. Автор и текст цитаты — снимком с момента ответа, а не
  // ссылкой: исходник может быть уже удалён или вне подгруженной истории.
  reply_to: number | null;
  reply_to_username: string;
  reply_to_preview: string;
  edited_at: string | null;
  // Только у type === 'system': 'pinned' | 'unpinned'. Кто — user_id/username,
  // какое сообщение — reply_to/reply_to_preview (тот же снимок, что у ответов).
  system_kind: string;
  // Реакции на сообщении. Необязательное поле: в localStorage лежит кеш
  // последней страницы, записанный ещё до появления реакций (см. CHAT_CACHE_KEY
  // в ChatContext) — оттуда сообщения приезжают вообще без этого ключа.
  reactions?: ChatReaction[];
}

export interface ChatReadState {
  user_id: number;
  display_name: string;
  last_read_seq: number;
  read_at: string | null;
}

// Темы уведомлений. Push-подписка на устройство одна общая (см. useChatPush) —
// она мастер-выключатель, а это темы под ним. Путь эндпоинта исторический
// (/videos/notify_prefs), содержимое давно шире видео.
export interface NotifyPrefs {
  visit_people: Record<string, boolean>;
  board_offline: boolean;
  chat_messages: boolean;
}

export interface PushStatusEntry {
  user_id: number;
  display_name: string;
  subscribed: boolean;
}

export interface ChatPresenceEntry {
  user_id: number;
  display_name: string;
  online: boolean;
  last_seen: string | null;
}

export type ChatWsEvent =
  | { type: 'message'; data: ChatMessage }
  // display_name приходит прямо в событии: оно вполне может опередить полный
  // снимок из /chat/read_states (сокет поднимается позже первого запроса
  // истории, а снимок мог и не доехать), и без имени в самом событии кружок
  // прочтения оставался безымянным до следующей пересинхронизации.
  | { type: 'read'; data: { user_id: number; display_name?: string; seq: number; at: string } }
  | { type: 'pinned'; data: ChatMessage }
  | { type: 'unpinned'; data: Record<string, never> }
  | { type: 'deleted'; data: { seq: number } }
  | { type: 'edited'; data: ChatMessage }
  // Не дельта, а весь агрегат по сообщению: мержить дельты на клиенте — лишний
  // источник расхождения, а участников чата всего четверо.
  | { type: 'reaction'; data: { seq: number; reactions: ChatReaction[] } }
  | { type: 'presence'; data: ChatPresenceEntry }
  | { type: 'presence_snapshot'; data: ChatPresenceEntry[] }
  | { type: 'typing'; data: { user_id: number; display_name: string } };

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

  async getNotifyPrefs(): Promise<NotifyPrefs> {
    return this.fetch('/esp_service/videos/notify_prefs');
  }

  async saveNotifyPrefs(prefs: NotifyPrefs): Promise<{ status: string }> {
    return this.fetch('/esp_service/videos/notify_prefs', {
      method: 'POST',
      body: JSON.stringify(prefs),
    });
  }

  async shareVideoToChat(cameraId: string, videoId: string): Promise<ChatMessage> {
    return this.fetch('/chat/share_video', {
      method: 'POST',
      body: JSON.stringify({ camera_id: cameraId, video_id: videoId }),
    });
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

      // Как и у чата — бэкофф с потолком 30с, но без сдачи насовсем: если
      // телефон был заблокирован дольше, чем хватало 5 попыток (~30с), поток
      // просто умирал до ручного нажатия "Повторить".
      const nextAttempt = attempt + 1;
      const delay = Math.min(2000 * nextAttempt, 30_000);
      const timer = setTimeout(() => {
        this.reconnectTimers.delete(cameraId);
        if (!this.wsConnections.has(cameraId)) {
          this.createCameraWebSocket(cameraId, options, nextAttempt);
        }
      }, delay);
      this.reconnectTimers.set(cameraId, timer);
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

  // Используется при логауте. В отличие от close*WebSocket() выше, раньше не
  // выставлял isManualClose и не снимал обработчики перед close() — onclose
  // соединения (chat/camera) считал разрыв случайным и продолжал бэкоффом
  // переоткрывать сокет уже без валидной cookie, вечно, даже стоя на экране
  // логина.
  closeAllWebSockets() {
    this.reconnectTimers.forEach((timer) => clearTimeout(timer));
    this.reconnectTimers.clear();
    this.wsConnections.forEach((ws) => {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      (ws as any).isManualClose = true;
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
    replyTo?: number | null;
    // Всё, что клиент готовит из фото сам (см. prepareImage в ChatPage):
    // уменьшенное превью в ленту, размеры кадра и крошка-заглушка.
    thumb?: Blob | null;
    width?: number;
    height?: number;
    preview?: string;
    onProgress?: (ratio: number) => void;
  }): Promise<ChatMessage> {
    const form = new FormData();
    form.append('type', payload.type);
    if (payload.text) form.append('text', payload.text);
    if (payload.mediaKind) form.append('media_kind', payload.mediaKind);
    if (payload.replyTo) form.append('reply_to', String(payload.replyTo));
    if (payload.file) form.append('file', payload.file, payload.fileName ?? 'upload');
    if (payload.thumb) form.append('thumb', payload.thumb, 'thumb.jpg');
    if (payload.width && payload.height) {
      form.append('media_w', String(payload.width));
      form.append('media_h', String(payload.height));
    }
    if (payload.preview) form.append('media_preview', payload.preview);

    // fetch() не даёт событий прогресса загрузки (только скачивания, через
    // ReadableStream) — для полосы аплоада большого фото/видео нужен именно
    // XHR, у него есть upload.onprogress.
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_BASE_URL}/chat/messages`);
      xhr.withCredentials = true;

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) payload.onProgress?.(e.loaded / e.total);
      };

      xhr.onload = () => {
        if (xhr.status === 401 || xhr.status === 403) {
          reject(new AuthError('Invalid or expired session'));
          return;
        }
        if (xhr.status < 200 || xhr.status >= 300) {
          const detail = (() => {
            try { return JSON.parse(xhr.responseText)?.detail; } catch { return null; }
          })();
          reject(new Error(detail ?? `HTTP error! status: ${xhr.status}`));
          return;
        }
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          reject(new Error('Некорректный ответ сервера'));
        }
      };
      xhr.onerror = () => reject(new Error('Сетевая ошибка'));

      xhr.send(form);
    });
  }

  async markChatRead(): Promise<{ user_id: number; display_name: string; seq: number; at: string }> {
    return this.fetch('/chat/read', { method: 'POST' });
  }

  // Явная отметка "я реально открыл раздел X" для ленты активности — шлётся
  // самой страницей при монтировании (см. usePageVisit), не выводится из
  // факта запроса: раньше на бэке любой хит по пути раздела засчитывался
  // визитом, включая фоновые синки глобальных провайдеров (чат синкает
  // историю всем при старте приложения, а не только на /chat).
  async recordPageVisit(section: string): Promise<void> {
    await this.fetch('/esp_service/activity/visit', {
      method: 'POST',
      body: JSON.stringify({ section }),
    });
  }

  async getChatReadStates(): Promise<{ reads: ChatReadState[] }> {
    return this.fetch('/chat/read_states');
  }

  // Время прочтения ОДНОГО сообщения каждым — спрашивается по тапу, под
  // карточку "Прочитали". read_at: null значит "точного времени нет" (не
  // дочитал, либо прочитал ещё до того, как бэк начал вести историю).
  async getChatReadAt(seq: number): Promise<{ reads: { user_id: number; read_at: string | null }[] }> {
    return this.fetch(`/chat/read_at?seq=${seq}`);
  }

  async getChatUnreadCount(): Promise<{ unread_count: number }> {
    return this.fetch('/chat/unread_count');
  }

  async pinChatMessage(seq: number): Promise<ChatMessage> {
    return this.fetch('/chat/pin', { method: 'POST', body: JSON.stringify({ seq }) });
  }

  async unpinChatMessage(): Promise<{ status: string }> {
    return this.fetch('/chat/unpin', { method: 'POST' });
  }

  async deleteChatMessage(seq: number): Promise<{ status: string }> {
    return this.fetch(`/chat/messages/${seq}`, { method: 'DELETE' });
  }

  async editChatMessage(seq: number, text: string): Promise<ChatMessage> {
    return this.fetch(`/chat/messages/${seq}`, { method: 'PATCH', body: JSON.stringify({ text }) });
  }

  /** Тоггл своей реакции: тот же эмодзи повторно снимает её, другой — заменяет
      (реакция на человека одна). Возвращает агрегат по сообщению целиком, он же
      уходит всем остальным событием reaction по WS. */
  async toggleChatReaction(seq: number, emoji: string): Promise<{ reactions: ChatReaction[] }> {
    return this.fetch(`/chat/messages/${seq}/reaction`, { method: 'POST', body: JSON.stringify({ emoji }) });
  }

  async getPinnedChatMessage(): Promise<{ message: ChatMessage | null }> {
    return this.fetch('/chat/pinned');
  }

  async getChatPushStatus(): Promise<{ statuses: PushStatusEntry[] }> {
    return this.fetch('/chat/push/status');
  }

  async getChatPresence(): Promise<{ entries: ChatPresenceEntry[] }> {
    return this.fetch('/chat/presence');
  }

  // Бэкенд стримит байты сам (как /esp_service/videos/stream) — Garage/S3
  // никогда не выставляется наружу, поэтому это просто URL, а не отдельный
  // запрос за presigned-ссылкой. Cookie-сессия уходит с запросом автоматически
  // (тот же origin), <img>/<audio>/<video> её сами подхватывают.
  getChatMediaSrc(mediaKey: string): string {
    return `${API_BASE_URL}/chat/media/${mediaKey}`;
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
    // Ответ на наш pingChatWebSocket() — единственное доказательство, что
    // сокет жив на самом деле, а не только по мнению readyState.
    onPong?: () => void;
  } = {}, attempt: number = 0) {
    const wsKey = 'chat';
    const wsUrl = `${getWebSocketBaseUrl()}/chat/ws`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      (ws as any).isManualClose = false;
      options.onOpen?.();
    };

    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return;

      if (event.data === 'ping') {
        ws.send('pong');
        return;
      }
      if (event.data === 'pong') {
        options.onPong?.();
        return;
      }
      if (event.data === 'AUTH_OK') return;
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
      if (isManual) return;

      // Раньше реконнект сдавался насовсем после 5 попыток (~30с) — если
      // разрыв (например тот самый код 1005) пришёлся на момент, когда юзер
      // не смотрит в экран, чат отваливался до перезагрузки страницы.
      // Теперь бэкофф просто упирается в потолок 30с и пробует бесконечно.
      const nextAttempt = attempt + 1;
      const delay = Math.min(2000 * nextAttempt, 30_000);
      const timer = setTimeout(() => {
        this.reconnectTimers.delete(wsKey);
        if (!this.wsConnections.has(wsKey)) {
          this.createChatWebSocket(options, nextAttempt);
        }
      }, delay);
      this.reconnectTimers.set(wsKey, timer);
    };

    this.wsConnections.set(wsKey, ws);
    return ws;
  }

  // Индикатор "печатает…" — тем же сырым текстовым фреймом, что и ping/pong,
  // без обёртки в JSON. Best-effort: если сокет сейчас не открыт, просто молчим.
  sendChatTyping() {
    const ws = this.wsConnections.get('chat');
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send('typing');
    }
  }

  // Health-check сокета: сервер на 'ping' отвечает 'pong' (см. handle_ws).
  // Возвращает false, если слать было некуда — соединения нет вовсе, и это
  // само по себе ответ: живым его считать нельзя.
  pingChatWebSocket(): boolean {
    const ws = this.wsConnections.get('chat');
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send('ping');
      return true;
    } catch {
      return false;
    }
  }

  closeChatWebSocket() {
    const timer = this.reconnectTimers.get('chat');
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete('chat');
    }

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
