import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { apiClient } from '../api/client';
import type { ChatMessage, ChatPresenceEntry, ChatReadState, ChatWsEvent } from '../api/client';
import { useAuth } from './AuthContext';
import { useTheme } from './ThemeContext';
import './ChatContext.css';

type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';

// Локальный превью-пузырь "идёт загрузка" — существует только у отправителя,
// пока апложится файл (как в Telegram/VK); другим участникам ничего не шлём,
// они просто увидят готовое сообщение через WS, когда оно появится.
export interface PendingUpload {
  localId: string;
  type: 'image' | 'audio' | 'video';
  previewUrl: string | null;
  progress: number;
}

export interface TypingUser {
  user_id: number;
  display_name: string;
}

interface ChatContextType {
  messages: ChatMessage[];
  pendingUploads: PendingUpload[];
  reads: ChatReadState[];
  unreadCount: number;
  connectionState: ConnectionState;
  loadingHistory: boolean;
  historyReady: boolean;
  hasMoreHistory: boolean;
  loadMoreHistory: () => Promise<void>;
  sendMessage: (payload: Parameters<typeof apiClient.sendChatMessage>[0]) => Promise<void>;
  markRead: () => Promise<void>;
  pinnedMessage: ChatMessage | null;
  pinMessage: (seq: number) => Promise<void>;
  unpinMessage: () => Promise<void>;
  deleteMessage: (seq: number) => Promise<void>;
  editMessage: (seq: number, text: string) => Promise<void>;
  presence: ChatPresenceEntry[];
  typingUsers: TypingUser[];
  notifyTyping: () => void;
}

const ChatContext = createContext<ChatContextType | undefined>(undefined);

const HISTORY_PAGE_SIZE = 50;

// Кеш последней страницы сообщений в localStorage — только тело истории, без
// reads/presence/typing/unreadCount/pinnedMessage: те слишком волатильны, и
// показ устаревшего "прочитано"/"онлайн"/закрепа будет откровенно врать, а не
// просто на секунду отставать, как текст сообщений. Переживает холодный
// старт PWA (тот же приём, что и кеш HomePage) — без него /chat при первом
// заходе после перезапуска всегда открывался с пустой лентой на все ~500мс+
// сети, пока не придёт реальная история.
const CHAT_CACHE_KEY = 'chat_messages_cache_v1';

function readChatMessagesCache(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(CHAT_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistChatMessagesCache(messages: ChatMessage[]) {
  try {
    // Срез до последней страницы — сколько бы истории юзер ни подгрузил
    // скроллом наверх за сессию (loadMoreHistory), на диск идёт только хвост:
    // кеш нужен для мгновенного первого кадра, а не как полная копия истории.
    localStorage.setItem(CHAT_CACHE_KEY, JSON.stringify(messages.slice(-HISTORY_PAGE_SIZE)));
  } catch {
    // приватный режим / забита квота — просто не кешируем на диск
  }
}

const TOAST_DURATION_MS = 4000;
// Разводим холодный старт чата по времени с HomePage (её запросы уже
// разнесены на 0/150/300/450мс) — иначе история чата и WS-хендшейк всё
// равно стартуют в тот же тик, что и телеметрия HomePage, и вместе дают
// залп новых соединений в первую секунду.
const HISTORY_FETCH_DELAY_MS = 500;
const WS_CONNECT_DELAY_MS = 700;
// Сколько держим "печатает…" после последнего typing-события от юзера, если
// не пришло следующее (сам факт остановки набора сервер не транслирует).
const TYPING_EXPIRY_MS = 4000;
// Не чаще, чем раз в столько шлём typing-фрейм при непрерывном наборе —
// иначе каждое нажатие клавиши было бы отдельным сообщением по WS.
const TYPING_THROTTLE_MS = 2500;

export const previewForMessage = (message: ChatMessage): string => {
  if (message.text) return message.text;
  if (message.type === 'image') return '📷 Фото';
  if (message.type === 'audio') return '🎤 Голосовое сообщение';
  if (message.type === 'video') return '🎬 Видео';
  return 'Новое сообщение';
};

// Глобальный провайдер чата — держит WS-соединение на уровне приложения (а не
// страницы /chat), поэтому оно живёт, пока открыт сам PWA, вне зависимости от
// текущего роута. Это и даёт три уровня уведомлений без отдельной логики на
// бэкенде: на /chat сообщение просто видно, на других страницах — тост +
// бейдж, а когда приложение закрыто целиком (WS отсутствует) — сервер сам
// шлёт Web Push тем, кого нет среди подключённых.
export const ChatProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { userId } = useAuth();
  const { theme } = useTheme();
  const location = useLocation();
  const isOnChatPage = location.pathname === '/chat';

  const [messages, setMessages] = useState<ChatMessage[]>(() => readChatMessagesCache());
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
  const [reads, setReads] = useState<ChatReadState[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [loadingHistory, setLoadingHistory] = useState(false);
  // Once true, stays true for the whole app session — историю грузим один
  // раз на уровне App-шелла (см. комментарий у ChatProvider), а не заново
  // при каждом заходе на /chat, так что и плавное появление ленты должно
  // случиться один раз, а не при каждом возврате на страницу.
  // Если из localStorage уже есть чем заполнить ленту — считаем её готовой
  // сразу, не дожидаясь настоящего fetch: точно так же, как loading у
  // HomePage стартует false, если homeCache уже не пуст.
  const [historyReady, setHistoryReady] = useState(() => readChatMessagesCache().length > 0);
  const [hasMoreHistory, setHasMoreHistory] = useState(true);
  const [toast, setToast] = useState<ChatMessage | null>(null);
  const [pinnedMessage, setPinnedMessage] = useState<ChatMessage | null>(null);
  const [presence, setPresence] = useState<ChatPresenceEntry[]>([]);
  const [typingUsers, setTypingUsers] = useState<TypingUser[]>([]);

  const isOnChatPageRef = useRef(isOnChatPage);
  useEffect(() => {
    isOnChatPageRef.current = isOnChatPage;
  }, [isOnChatPage]);

  // Авто-скрытие "печатает…" — сервер шлёт только сам факт набора, не его
  // окончание, поэтому таймер сброса живёт на клиенте, по одному на юзера.
  const typingTimersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const lastTypingSentRef = useRef(0);

  const notifyTyping = useCallback(() => {
    const now = Date.now();
    if (now - lastTypingSentRef.current < TYPING_THROTTLE_MS) return;
    lastTypingSentRef.current = now;
    apiClient.sendChatTyping();
  }, []);

  const markRead = useCallback(async () => {
    try {
      await apiClient.markChatRead();
      setUnreadCount(0);
    } catch {
      // best-effort — не критично, попробуем при следующем событии
    }
  }, []);

  // Начальная загрузка: последняя страница истории + текущие unread/read состояния
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    // Сам по себе этот эффект уже растянут по времени последовательными await,
    // но он всё равно стартует в тот же тик, что и телеметрия HomePage (t=0) —
    // задержка перед стартом разводит его с остальным холодным залпом на входе.
    const startTimer = setTimeout(async () => {
      setLoadingHistory(true);
      try {
        // Раньше это были пять последовательных await — сеть между ними
        // отдаёт JS-поток браузеру, и он успевает отрисовать промежуточные
        // кадры (шапка → потом баннер закрепа → потом лента), из-за чего
        // было видно, как страница "достраивается". Promise.all не зависимые
        // друг от друга запросы, все setState ниже происходят одним синхронным
        // блоком без пауз для рендера между ними — один кадр вместо пяти.
        const [historyRes, unreadRes, readsRes, pinnedRes, presenceRes] = await Promise.all([
          apiClient.getChatMessages(),
          apiClient.getChatUnreadCount(),
          apiClient.getChatReadStates(),
          apiClient.getPinnedChatMessage(),
          apiClient.getChatPresence(),
        ]);
        if (cancelled) return;
        setMessages(historyRes.messages);
        setHasMoreHistory(historyRes.messages.length >= HISTORY_PAGE_SIZE);
        setUnreadCount(unreadRes.unread_count);
        setReads(readsRes.reads);
        setPinnedMessage(pinnedRes.message);
        setPresence(presenceRes.entries);
      } catch {
        // WS всё равно досинхронизирует новые события
      } finally {
        if (!cancelled) {
          setLoadingHistory(false);
          setHistoryReady(true);
        }
      }
    }, HISTORY_FETCH_DELAY_MS);

    return () => {
      cancelled = true;
      clearTimeout(startTimer);
    };
  }, [userId]);

  const connectionStateRef = useRef<ConnectionState>('connecting');
  useEffect(() => {
    connectionStateRef.current = connectionState;
  }, [connectionState]);

  useEffect(() => {
    if (!userId) return;

    setConnectionState('connecting');

    const wsOptions = {
      onOpen: () => setConnectionState('connected'),
      onEvent: (event: ChatWsEvent) => {
        if (event.type === 'message') {
          const incoming = event.data;
          setMessages((prev) => (prev.some((m) => m.seq === incoming.seq) ? prev : [...prev, incoming]));

          // Системные (закрепил/открепил) — видны в ленте, но не считаются
          // непрочитанным и не всплывают тостом: это служебная отметка, а не
          // контент, который юзер мог бы "пропустить".
          if (incoming.type === 'system' || incoming.user_id === userId || isOnChatPageRef.current) return;

          setUnreadCount((prev) => prev + 1);
          setToast(incoming);
        } else if (event.type === 'read') {
          setReads((prev) => {
            const existing = prev.find((r) => r.user_id === event.data.user_id);
            // Повтор того же (или более старого) seq — например, юзер просто заново
            // открыл чат: время прочтения уже зафиксировано, перетирать его нельзя.
            if (existing && existing.last_read_seq >= event.data.seq) return prev;
            const next = prev.filter((r) => r.user_id !== event.data.user_id);
            next.push({
              user_id: event.data.user_id,
              display_name: existing?.display_name ?? '',
              last_read_seq: event.data.seq,
              read_at: event.data.at,
            });
            return next;
          });
        } else if (event.type === 'pinned') {
          setPinnedMessage(event.data);
        } else if (event.type === 'unpinned') {
          setPinnedMessage(null);
        } else if (event.type === 'edited') {
          const edited = event.data;
          setMessages((prev) => prev.map((m) => (m.seq === edited.seq ? edited : m)));
          setPinnedMessage((prev) => (prev?.seq === edited.seq ? edited : prev));
        } else if (event.type === 'deleted') {
          // Сервер шлёт это всем, включая автора удаления: у него сообщение
          // уже убрано оптимистично, повторное удаление из массива безвредно.
          setMessages((prev) => prev.filter((m) => m.seq !== event.data.seq));
        } else if (event.type === 'presence_snapshot') {
          setPresence(event.data);
        } else if (event.type === 'presence') {
          setPresence((prev) => [...prev.filter((p) => p.user_id !== event.data.user_id), event.data]);
          // Юзер явно объявился онлайн/офлайн — "печатает…" для него больше не актуально.
          const timers = typingTimersRef.current;
          const pending = timers.get(event.data.user_id);
          if (pending) {
            clearTimeout(pending);
            timers.delete(event.data.user_id);
          }
          setTypingUsers((prev) => prev.filter((t) => t.user_id !== event.data.user_id));
        } else if (event.type === 'typing') {
          const { user_id: typingUserId, display_name } = event.data;
          setTypingUsers((prev) =>
            prev.some((t) => t.user_id === typingUserId) ? prev : [...prev, { user_id: typingUserId, display_name }]
          );
          const timers = typingTimersRef.current;
          const existing = timers.get(typingUserId);
          if (existing) clearTimeout(existing);
          timers.set(typingUserId, setTimeout(() => {
            setTypingUsers((prev) => prev.filter((t) => t.user_id !== typingUserId));
            timers.delete(typingUserId);
          }, TYPING_EXPIRY_MS));
        }
      },
      onError: () => setConnectionState('error'),
      onClose: () => setConnectionState('disconnected'),
    };

    // Задержка перед первым коннектом — иначе WS-хендшейк стартует в тот же
    // тик, что и история чата и телеметрия HomePage, и это снова залп новых
    // соединений на холодном старте.
    const connectTimer = setTimeout(() => {
      apiClient.createChatWebSocket(wsOptions);
    }, WS_CONNECT_DELAY_MS);

    // Телефон разблокировали — не ждём, пока браузер сам заметит мёртвый
    // сокет (может тянуться долго), а сразу форсируем реконнект. Дебаунс —
    // чтобы серия visibilitychange (быстрое переключение между табами/аппами)
    // не долбила сервер новыми соединениями поверх уже идущего реконнекта.
    let lastForceReconnect = 0;
    const handleVisibility = () => {
      const now = Date.now();
      if (
        document.visibilityState === 'visible' &&
        connectionStateRef.current !== 'connected' &&
        now - lastForceReconnect > 5000
      ) {
        lastForceReconnect = now;
        apiClient.closeChatWebSocket();
        setConnectionState('connecting');
        apiClient.createChatWebSocket(wsOptions);
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    const typingTimers = typingTimersRef.current;
    return () => {
      clearTimeout(connectTimer);
      document.removeEventListener('visibilitychange', handleVisibility);
      apiClient.closeChatWebSocket();
      typingTimers.forEach((timer) => clearTimeout(timer));
      typingTimers.clear();
    };
  }, [userId]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_DURATION_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  // Один эффект на все источники изменений messages (начальная загрузка, WS,
  // отправка, правка, удаление, подгрузка истории) вместо ручного вызова в
  // каждом из них — persistChatMessagesCache сам обрезает до последней
  // страницы, так что это дёшево и не зависит от того, сколько истории
  // подгружено скроллом.
  useEffect(() => {
    persistChatMessagesCache(messages);
  }, [messages]);

  const loadMoreHistory = useCallback(async () => {
    if (loadingHistory || !hasMoreHistory || messages.length === 0) return;
    setLoadingHistory(true);
    try {
      const oldestSeq = messages[0].seq;
      const res = await apiClient.getChatMessages(oldestSeq);
      setMessages((prev) => [...res.messages, ...prev]);
      setHasMoreHistory(res.messages.length >= HISTORY_PAGE_SIZE);
    } catch {
      // остаёмся с уже загруженным
    } finally {
      setLoadingHistory(false);
    }
  }, [loadingHistory, hasMoreHistory, messages]);

  const pinMessage = useCallback(async (seq: number) => {
    const message = await apiClient.pinChatMessage(seq);
    setPinnedMessage(message);
  }, []);

  const unpinMessage = useCallback(async () => {
    await apiClient.unpinChatMessage();
    setPinnedMessage(null);
  }, []);

  // Оптимистично убираем пузырь сразу, не дожидаясь WS-события: иначе между
  // тапом "Удалить" и ответом сервера сообщение продолжает висеть на экране.
  // Если сервер откажет (чужое или старше часа) — возвращаем на место и даём
  // ошибку наверх, чтобы UI показал причину.
  const deleteMessage = useCallback(async (seq: number) => {
    let removed: ChatMessage | undefined;
    setMessages((prev) => {
      removed = prev.find((m) => m.seq === seq);
      return prev.filter((m) => m.seq !== seq);
    });
    try {
      await apiClient.deleteChatMessage(seq);
    } catch (e) {
      if (removed) {
        setMessages((prev) => [...prev, removed as ChatMessage].sort((a, b) => a.seq - b.seq));
      }
      throw e;
    }
  }, []);

  // Как и удаление — оптимистично: правка видна сразу, WS-событие потом просто
  // подтвердит её. Откат на прежний текст, если сервер отказал (чужое, не
  // текстовое, просрочено).
  const editMessage = useCallback(async (seq: number, text: string) => {
    let previous: ChatMessage | undefined;
    setMessages((prev) => prev.map((m) => {
      if (m.seq !== seq) return m;
      previous = m;
      return { ...m, text };
    }));
    try {
      const updated = await apiClient.editChatMessage(seq, text);
      setMessages((prev) => prev.map((m) => (m.seq === seq ? updated : m)));
      setPinnedMessage((prev) => (prev?.seq === seq ? updated : prev));
    } catch (e) {
      if (previous) {
        const restored = previous;
        setMessages((prev) => prev.map((m) => (m.seq === seq ? restored : m)));
      }
      throw e;
    }
  }, []);

  const sendMessage = useCallback(async (payload: Parameters<typeof apiClient.sendChatMessage>[0]) => {
    // Прогресс-пузырь только для медиа (текст улетает мгновенно, показывать
    // нечего) и только локально у отправителя — превью из локального Blob,
    // не с сервера.
    const localId = payload.file && payload.type !== 'text'
      ? `${Date.now()}-${Math.random().toString(36).slice(2)}`
      : null;
    if (localId && payload.file) {
      const previewUrl = payload.type === 'audio' ? null : URL.createObjectURL(payload.file);
      setPendingUploads((prev) => [
        ...prev,
        { localId, type: payload.type as 'image' | 'audio' | 'video', previewUrl, progress: 0 },
      ]);
    }
    try {
      const message = await apiClient.sendChatMessage({
        ...payload,
        onProgress: localId
          ? (ratio) => setPendingUploads((prev) => prev.map((p) => (p.localId === localId ? { ...p, progress: ratio } : p)))
          : undefined,
      });
      setMessages((prev) => (prev.some((m) => m.seq === message.seq) ? prev : [...prev, message]));
    } finally {
      if (localId) {
        setPendingUploads((prev) => {
          const found = prev.find((p) => p.localId === localId);
          if (found?.previewUrl) URL.revokeObjectURL(found.previewUrl);
          return prev.filter((p) => p.localId !== localId);
        });
      }
    }
    // markRead — за пределами try/finally для загрузки: раньше он стоял между
    // setMessages и уборкой pending-плейсхолдера, а сам делает сетевой запрос
    // (см. markRead ниже). Пока он не резолвился, в ленте одновременно висели
    // и финальное сообщение (уже в messages), и ещё не убранный "грузится"
    // пузырь (pendingUploads) — на медиа/войсах это давало на кадр лишнюю
    // высоту, а следом за ней резкий скачок скролла вверх при уборке
    // плейсхолдера. Теперь плейсхолдер убирается сразу вслед за сообщением,
    // без ожидания сети.
    // Своё сообщение считается прочитанным собой сразу — иначе после
    // перезахода бейдж покажет непрочитанным то, что сам же и отправил.
    await markRead();
  }, [markRead]);

  return (
    <ChatContext.Provider value={{
      messages,
      pendingUploads,
      reads,
      unreadCount,
      connectionState,
      loadingHistory,
      historyReady,
      hasMoreHistory,
      loadMoreHistory,
      sendMessage,
      markRead,
      pinnedMessage,
      pinMessage,
      unpinMessage,
      deleteMessage,
      editMessage,
      presence,
      typingUsers,
      notifyTyping,
    }}>
      {children}
      <AnimatePresence>
        {toast && !isOnChatPage && (
          <motion.div
            className={`chat-toast ${theme}`}
            initial={{ opacity: 0, y: -40 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -40 }}
            onClick={() => setToast(null)}
          >
            <span className="chat-toast-author">{toast.username}</span>
            <span className="chat-toast-text">{previewForMessage(toast)}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </ChatContext.Provider>
  );
};

export const useChat = () => {
  const context = useContext(ChatContext);
  if (context === undefined) {
    throw new Error('useChat must be used within a ChatProvider');
  }
  return context;
};
