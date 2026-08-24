import React, { useEffect, useRef, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Send, Image as ImageIcon, Mic, Video as VideoIcon, Square, Loader2, Bell, BellRing } from 'lucide-react';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { useChat } from '../../context/ChatContext';
import { apiClient } from '../../api/client';
import type { ChatMessage } from '../../api/client';
import { BottomNavBar } from '../../components/BottomNavBar/BottomNavBar';
import './ChatPage.css';

const MAX_RECORD_MS = 60_000;

const formatTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

// Пережимаем фото на клиенте перед аплоадом — сервер не транскодирует ничего,
// вся тяжесть кодирования лежит на клиенте (см. обсуждение с пользователем).
async function resizeImage(file: File, maxDim = 1600): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    return blob ?? file;
  } catch {
    return file;
  }
}

// VAPID-ключ приходит в URL-safe base64, а PushManager.subscribe хочет Uint8Array.
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export const ChatPage: React.FC = () => {
  const { theme } = useTheme();
  const { userId } = useAuth();
  const { messages, reads, connectionState, loadingHistory, hasMoreHistory, loadMoreHistory, sendMessage, markRead } = useChat();

  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState<'audio' | 'video' | null>(null);
  const [circleMode, setCircleMode] = useState(false);
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});

  const [pushSupported] = useState(() => 'serviceWorker' in navigator && 'PushManager' in window);
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastSeqRef = useRef<number | null>(null);
  const mediaUrlCacheRef = useRef<Set<string>>(new Set());

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const recordTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    markRead();
  }, [messages.length, markRead]);

  // Автоскролл вниз только когда добавилось НОВОЕ сообщение в конец (не при
  // подгрузке истории вверх — там последний seq не меняется).
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (!last) return;
    if (lastSeqRef.current !== last.seq) {
      lastSeqRef.current = last.seq;
      requestAnimationFrame(() => {
        listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
      });
    }
  }, [messages]);

  // Резолвим presigned URL для медиа лениво, по мере появления сообщений
  useEffect(() => {
    messages.forEach((m) => {
      if (!m.media_key || mediaUrlCacheRef.current.has(m.media_key)) return;
      mediaUrlCacheRef.current.add(m.media_key);
      apiClient.getChatMediaUrl(m.media_key)
        .then(({ url }) => setMediaUrls((prev) => ({ ...prev, [m.media_key]: url })))
        .catch(() => mediaUrlCacheRef.current.delete(m.media_key));
    });
  }, [messages]);

  // Отпускаем камеру/микрофон при уходе со страницы
  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (recordTimeoutRef.current) clearTimeout(recordTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (!pushSupported) return;
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setPushSubscribed(!!sub))
      .catch(() => {});
  }, [pushSupported]);

  const enablePush = async () => {
    if (!pushSupported || pushBusy || pushSubscribed) return;
    setPushBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return;

      const { public_key } = await apiClient.getVapidPublicKey();
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(public_key),
      });
      await apiClient.subscribeChatPush(subscription.toJSON() as PushSubscriptionJSON);
      setPushSubscribed(true);
    } catch (err) {
      console.error('Не удалось включить push-уведомления', err);
    } finally {
      setPushBusy(false);
    }
  };

  const handleScroll = useCallback(() => {
    const el = listRef.current;
    if (!el || el.scrollTop > 80 || !hasMoreHistory || loadingHistory) return;
    const prevHeight = el.scrollHeight;
    loadMoreHistory().then(() => {
      requestAnimationFrame(() => {
        if (listRef.current) {
          listRef.current.scrollTop = listRef.current.scrollHeight - prevHeight;
        }
      });
    });
  }, [hasMoreHistory, loadingHistory, loadMoreHistory]);

  const handleSendText = async () => {
    const text = inputText.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await sendMessage({ type: 'text', text });
      setInputText('');
    } catch (err) {
      console.error('Не удалось отправить сообщение', err);
    } finally {
      setSending(false);
    }
  };

  const handlePhotoSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || sending) return;
    setSending(true);
    try {
      const resized = await resizeImage(file);
      await sendMessage({ type: 'image', file: resized, fileName: 'photo.jpg' });
    } catch (err) {
      console.error('Не удалось отправить фото', err);
    } finally {
      setSending(false);
    }
  };

  const startRecording = async (kind: 'audio' | 'video') => {
    if (recording || sending) return;
    try {
      const constraints: MediaStreamConstraints = kind === 'audio'
        ? { audio: true }
        : { audio: true, video: { facingMode: 'user' } };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;
      recordedChunksRef.current = [];

      const mimeType = kind === 'audio' ? 'audio/webm' : 'video/webm';
      const recorder = new MediaRecorder(
        stream,
        MediaRecorder.isTypeSupported(mimeType) ? { mimeType } : undefined
      );
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunksRef.current.push(e.data);
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecording(kind);

      recordTimeoutRef.current = setTimeout(() => stopRecording(), MAX_RECORD_MS);
    } catch (err) {
      console.error('Нет доступа к камере/микрофону', err);
    }
  };

  const stopRecording = async () => {
    const recorder = mediaRecorderRef.current;
    const kind = recording;
    if (!recorder || !kind) return;

    if (recordTimeoutRef.current) {
      clearTimeout(recordTimeoutRef.current);
      recordTimeoutRef.current = null;
    }

    await new Promise<void>((resolve) => {
      recorder.addEventListener('stop', () => resolve(), { once: true });
      recorder.stop();
    });

    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    mediaRecorderRef.current = null;
    setRecording(null);

    const blob = new Blob(recordedChunksRef.current, { type: kind === 'audio' ? 'audio/webm' : 'video/webm' });
    recordedChunksRef.current = [];
    if (blob.size === 0) return;

    setSending(true);
    try {
      await sendMessage({
        type: kind,
        file: blob,
        fileName: kind === 'audio' ? 'voice.webm' : 'video.webm',
        mediaKind: kind === 'video' && circleMode ? 'circle' : undefined,
      });
    } catch (err) {
      console.error('Не удалось отправить запись', err);
    } finally {
      setSending(false);
    }
  };

  const renderMedia = (message: ChatMessage) => {
    const url = mediaUrls[message.media_key];
    if (!url) {
      return (
        <div className="chat-media-placeholder">
          <Loader2 size={18} className="spin" />
        </div>
      );
    }
    if (message.type === 'image') {
      return <img src={url} alt="" className="chat-media-image" loading="lazy" />;
    }
    if (message.type === 'audio') {
      return <audio src={url} controls className="chat-media-audio" />;
    }
    if (message.type === 'video') {
      return (
        <video
          src={url}
          controls
          playsInline
          className={`chat-media-video ${message.media_kind === 'circle' ? 'circle' : ''}`}
        />
      );
    }
    return null;
  };

  return (
    <div className={`chat-page ${theme}`}>
      <div className="chat-header">
        <h1>Чат</h1>
        {connectionState !== 'connected' && (
          <span className="chat-connection-hint">
            {connectionState === 'connecting' ? 'Подключение…' : 'Нет соединения — переподключаемся…'}
          </span>
        )}
        {pushSupported && (
          <button
            className="chat-push-toggle"
            onClick={enablePush}
            disabled={pushBusy || pushSubscribed}
            title={pushSubscribed ? 'Уведомления включены' : 'Включить уведомления, когда приложение закрыто'}
          >
            {pushSubscribed ? <BellRing size={18} /> : <Bell size={18} />}
          </button>
        )}
      </div>

      <div className="chat-messages" ref={listRef} onScroll={handleScroll}>
        {loadingHistory && messages.length === 0 && (
          <div className="chat-loading"><Loader2 size={20} className="spin" /></div>
        )}
        {hasMoreHistory && messages.length > 0 && (
          <div className="chat-load-more-hint">
            {loadingHistory ? 'Загружаем историю…' : 'Прокрутите вверх для истории'}
          </div>
        )}

        <AnimatePresence initial={false}>
          {messages.map((message, idx) => {
            const isMine = message.user_id === userId;
            const isLast = idx === messages.length - 1;
            const readers = isLast
              ? reads.filter((r) => r.user_id !== message.user_id && r.last_read_seq >= message.seq)
              : [];

            return (
              <motion.div
                key={message.seq}
                className={`chat-bubble-row ${isMine ? 'mine' : ''}`}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
              >
                <div className="chat-bubble">
                  {!isMine && <div className="chat-bubble-author">{message.username}</div>}
                  {message.text && <div className="chat-bubble-text">{message.text}</div>}
                  {message.media_key && renderMedia(message)}
                  <div className="chat-bubble-time">{formatTime(message.ts)}</div>
                </div>
                {readers.length > 0 && (
                  <div className="chat-read-receipt">
                    Прочитано: {readers.map((r) => `${r.display_name} в ${r.read_at ? formatTime(r.read_at) : ''}`).join(', ')}
                  </div>
                )}
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

      <div className="chat-input-bar">
        {recording && (
          <div className="chat-recording-indicator">
            <span className="chat-recording-dot" />
            {recording === 'audio' ? 'Запись голосового…' : 'Запись видео…'}
            {recording === 'video' && (
              <label className="chat-circle-toggle">
                <input type="checkbox" checked={circleMode} onChange={(e) => setCircleMode(e.target.checked)} />
                кружок
              </label>
            )}
            <button className="chat-stop-recording" onClick={() => stopRecording()}>
              <Square size={16} /> Стоп
            </button>
          </div>
        )}

        {!recording && (
          <div className="chat-input-row">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              onChange={handlePhotoSelected}
            />
            <button
              className="chat-icon-button"
              disabled={sending}
              onClick={() => fileInputRef.current?.click()}
              title="Фото"
            >
              <ImageIcon size={20} />
            </button>
            <button
              className="chat-icon-button"
              disabled={sending}
              onClick={() => startRecording('audio')}
              title="Голосовое"
            >
              <Mic size={20} />
            </button>
            <button
              className="chat-icon-button"
              disabled={sending}
              onClick={() => startRecording('video')}
              title="Видео"
            >
              <VideoIcon size={20} />
            </button>
            <input
              className="chat-text-input"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSendText();
                }
              }}
              placeholder="Сообщение…"
              disabled={sending}
            />
            <button
              className="chat-send-button"
              disabled={sending || !inputText.trim()}
              onClick={handleSendText}
            >
              {sending ? <Loader2 size={18} className="spin" /> : <Send size={18} />}
            </button>
          </div>
        )}
      </div>

      <BottomNavBar />
    </div>
  );
};
