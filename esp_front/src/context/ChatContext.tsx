import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { apiClient } from '../api/client';
import type { ChatMessage, ChatReadState, ChatWsEvent } from '../api/client';
import { useAuth } from './AuthContext';
import { useTheme } from './ThemeContext';
import './ChatContext.css';

type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';

interface ChatContextType {
  messages: ChatMessage[];
  reads: ChatReadState[];
  unreadCount: number;
  connectionState: ConnectionState;
  loadingHistory: boolean;
  hasMoreHistory: boolean;
  loadMoreHistory: () => Promise<void>;
  sendMessage: (payload: Parameters<typeof apiClient.sendChatMessage>[0]) => Promise<void>;
  markRead: () => Promise<void>;
  pinnedMessage: ChatMessage | null;
  pinMessage: (seq: number) => Promise<void>;
  unpinMessage: () => Promise<void>;
}

const ChatContext = createContext<ChatContextType | undefined>(undefined);

const HISTORY_PAGE_SIZE = 50;
const TOAST_DURATION_MS = 4000;

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

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [reads, setReads] = useState<ChatReadState[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(true);
  const [toast, setToast] = useState<ChatMessage | null>(null);
  const [pinnedMessage, setPinnedMessage] = useState<ChatMessage | null>(null);

  const isOnChatPageRef = useRef(isOnChatPage);
  useEffect(() => {
    isOnChatPageRef.current = isOnChatPage;
  }, [isOnChatPage]);

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

    (async () => {
      setLoadingHistory(true);
      try {
        const [historyRes, unreadRes, readsRes, pinnedRes] = await Promise.all([
          apiClient.getChatMessages(),
          apiClient.getChatUnreadCount(),
          apiClient.getChatReadStates(),
          apiClient.getPinnedChatMessage(),
        ]);
        if (cancelled) return;
        setMessages(historyRes.messages);
        setHasMoreHistory(historyRes.messages.length >= HISTORY_PAGE_SIZE);
        setUnreadCount(unreadRes.unread_count);
        setReads(readsRes.reads);
        setPinnedMessage(pinnedRes.message);
      } catch {
        // WS всё равно досинхронизирует новые события
      } finally {
        if (!cancelled) setLoadingHistory(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userId]);

  useEffect(() => {
    if (!userId) return;

    setConnectionState('connecting');

    apiClient.createChatWebSocket({
      onOpen: () => setConnectionState('connected'),
      onEvent: (event: ChatWsEvent) => {
        if (event.type === 'message') {
          const incoming = event.data;
          setMessages((prev) => (prev.some((m) => m.seq === incoming.seq) ? prev : [...prev, incoming]));

          if (incoming.user_id === userId || isOnChatPageRef.current) return;

          setUnreadCount((prev) => prev + 1);
          setToast(incoming);
        } else if (event.type === 'read') {
          setReads((prev) => {
            const existing = prev.find((r) => r.user_id === event.data.user_id);
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
        }
      },
      onError: () => setConnectionState('error'),
      onClose: () => setConnectionState('disconnected'),
    });

    return () => {
      apiClient.closeChatWebSocket();
    };
  }, [userId]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_DURATION_MS);
    return () => clearTimeout(timer);
  }, [toast]);

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

  const sendMessage = useCallback(async (payload: Parameters<typeof apiClient.sendChatMessage>[0]) => {
    const message = await apiClient.sendChatMessage(payload);
    setMessages((prev) => (prev.some((m) => m.seq === message.seq) ? prev : [...prev, message]));
    // Своё сообщение считается прочитанным собой сразу — иначе после
    // перезахода бейдж покажет непрочитанным то, что сам же и отправил.
    await markRead();
  }, [markRead]);

  return (
    <ChatContext.Provider value={{
      messages,
      reads,
      unreadCount,
      connectionState,
      loadingHistory,
      hasMoreHistory,
      loadMoreHistory,
      sendMessage,
      markRead,
      pinnedMessage,
      pinMessage,
      unpinMessage,
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
