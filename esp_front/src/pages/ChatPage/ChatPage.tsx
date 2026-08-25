import React, { useEffect, useRef, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Send, Mic, Trash2, Loader2, Bell, BellOff, Paperclip, X, Play, VideoOff } from 'lucide-react';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { useChat } from '../../context/ChatContext';
import { apiClient } from '../../api/client';
import type { ChatMessage } from '../../api/client';
import { BottomNavBar } from '../../components/BottomNavBar/BottomNavBar';
import { VoiceMessage } from './VoiceMessage';
import './ChatPage.css';

const MAX_RECORD_MS = 60_000;
const MAX_TEXTAREA_HEIGHT = 120; // px, ~5 строк — дальше внутренний скролл

type NotifStatus = 'unsupported' | 'ios-not-installed' | 'default' | 'denied' | 'granted';

const isIosNotStandalone = (): boolean => {
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true;
  return isIos && !isStandalone;
};

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

// iOS Safari часто не поддерживает audio/webm вообще — MediaRecorder тогда
// сам выбирает дефолт (обычно audio/mp4). Раньше тут было жёстко зашито
// audio/webm независимо от того, что браузер реально записал — на айфоне это
// тихо подписывало mp4-файл как webm и ломало проигрывание у получателей.
const AUDIO_MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];

const EXT_BY_AUDIO_MIME: Record<string, string> = {
  webm: 'webm',
  mp4: 'm4a',
  ogg: 'ogg',
  mpeg: 'mp3',
};

const audioFileName = (mimeType: string) => {
  const base = mimeType.split(';')[0].split('/')[1] ?? 'webm';
  return `voice.${EXT_BY_AUDIO_MIME[base] ?? 'webm'}`;
};

// file.type у видео из галереи иногда пустой (некоторые Android-пикеры не
// проставляют MIME) — тогда сервер отклонит файл как "недопустимый тип" без
// объяснений. Подстраховываемся расширением из имени файла.
const EXT_TO_VIDEO_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};

const guessVideoMimeType = (file: File): string | null => {
  if (file.type.startsWith('video/')) return file.type;
  if (file.type) return null; // известный не-видео тип, доверяем ему
  const ext = file.name.split('.').pop()?.toLowerCase();
  return ext ? EXT_TO_VIDEO_MIME[ext] ?? null : null;
};

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : 'Не удалось отправить сообщение';

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
  const [recording, setRecording] = useState(false);
  const [lightbox, setLightbox] = useState<{ src: string; type: 'image' | 'video' } | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [inputFocused, setInputFocused] = useState(false);
  const [mediaErrors, setMediaErrors] = useState<Set<number>>(new Set());

  const [notifStatus, setNotifStatus] = useState<NotifStatus>('default');
  const [pushBusy, setPushBusy] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textInputRef = useRef<HTMLTextAreaElement>(null);
  const lastSeqRef = useRef<number | null>(null);

  const [recordingSeconds, setRecordingSeconds] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const recordTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    markRead();
  }, [messages.length, markRead]);

  useEffect(() => {
    if (!sendError) return;
    const timer = setTimeout(() => setSendError(null), 6000);
    return () => clearTimeout(timer);
  }, [sendError]);

  // Авто-рост textarea под содержимое (как в Telegram) — растягиваем до
  // MAX_TEXTAREA_HEIGHT, дальше собственный скролл внутри поля.
  useEffect(() => {
    const el = textInputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }, [inputText]);

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


  // Отпускаем камеру/микрофон при уходе со страницы
  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (recordTimeoutRef.current) clearTimeout(recordTimeoutRef.current);
      if (recordingIntervalRef.current) clearInterval(recordingIntervalRef.current);
    };
  }, []);

  // Пока открыт полноэкранный просмотр фото — блокируем скролл фона и
  // вешаем Escape для закрытия (пинч-зум самого фото — нативный, ничего
  // руками не реализуем, viewport это уже разрешает).
  useEffect(() => {
    if (!lightbox) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [lightbox]);

  // Определяем статус один раз при заходе на экран чата. Настоящий системный
  // диалог (requestNotificationAccess) НЕ дёргаем автоматически — он выдаётся
  // браузером только один раз, и случайный отказ обратно не открыть через JS.
  // Баннер — наш собственный UI, ничего не жжёт, можно показывать смело.
  useEffect(() => {
    if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      setNotifStatus(isIosNotStandalone() ? 'ios-not-installed' : 'unsupported');
      return;
    }
    if (Notification.permission === 'denied') {
      setNotifStatus('denied');
      return;
    }
    if (Notification.permission === 'granted') {
      setNotifStatus('granted');
      ensureSubscribed();
      return;
    }
    setNotifStatus('default');
  }, []);

  // Разрешение уже есть (выдано раньше) — просто синхронизируем подписку с
  // сервером молча, без всякого UI и без повторного системного диалога.
  const ensureSubscribed = async () => {
    try {
      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        const { public_key } = await apiClient.getVapidPublicKey();
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(public_key),
        });
      }
      await apiClient.subscribeChatPush(subscription.toJSON() as PushSubscriptionJSON);
    } catch (err) {
      console.error('Не удалось синхронизировать push-подписку', err);
    }
  };

  // Единственное место, где реально вызывается системный диалог — по тапу
  // юзера на баннер, никогда автоматически.
  const requestNotificationAccess = async () => {
    if (pushBusy) return;
    setPushBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission === 'granted') {
        setNotifStatus('granted');
        await ensureSubscribed();
      } else if (permission === 'denied') {
        setNotifStatus('denied');
      }
      // permission === 'default' — юзер закрыл диалог без выбора, баннер
      // остаётся, можно попробовать снова позже
    } catch (err) {
      console.error('Не удалось запросить разрешение на уведомления', err);
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
      setSendError(null);
    } catch (err) {
      console.error('Не удалось отправить сообщение', err);
      setSendError(errorMessage(err));
    } finally {
      setSending(false);
      // Поле не disabled во время отправки специально — но фокус браузер всё
      // равно может увести на кнопку отправки, возвращаем его в поле ввода.
      textInputRef.current?.focus();
    }
  };

  // Галерея — обычный файловый пикер (без capture), поэтому сюда прилетает
  // и фото, и видео из библиотеки, а не только снимки с камеры.
  const handleGallerySelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || sending) return;

    setSending(true);
    try {
      const videoMime = guessVideoMimeType(file);
      if (videoMime) {
        const videoFile = videoMime === file.type ? file : new Blob([file], { type: videoMime });
        await sendMessage({ type: 'video', file: videoFile, fileName: file.name || 'video.mp4' });
      } else {
        const resized = await resizeImage(file);
        await sendMessage({ type: 'image', file: resized, fileName: 'photo.jpg' });
      }
      setSendError(null);
    } catch (err) {
      console.error('Не удалось отправить файл из галереи', err);
      setSendError(errorMessage(err));
    } finally {
      setSending(false);
    }
  };

  const startRecording = async () => {
    if (recording || sending) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      recordedChunksRef.current = [];

      const mimeType = AUDIO_MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunksRef.current.push(e.data);
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecording(true);
      setRecordingSeconds(0);
      recordingIntervalRef.current = setInterval(() => {
        setRecordingSeconds((s) => s + 1);
      }, 1000);

      recordTimeoutRef.current = setTimeout(() => stopRecording(), MAX_RECORD_MS);
    } catch (err) {
      console.error('Нет доступа к микрофону', err);
    }
  };

  const clearRecordingTimers = () => {
    if (recordTimeoutRef.current) {
      clearTimeout(recordTimeoutRef.current);
      recordTimeoutRef.current = null;
    }
    if (recordingIntervalRef.current) {
      clearInterval(recordingIntervalRef.current);
      recordingIntervalRef.current = null;
    }
  };

  const stopRecording = async () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || !recording) return;

    clearRecordingTimers();

    await new Promise<void>((resolve) => {
      recorder.addEventListener('stop', () => resolve(), { once: true });
      recorder.stop();
    });

    // Реальный тип того, что браузер записал (а не что мы просили) — на
    // Safari это часто не совпадает с запрошенным audio/webm.
    const actualMimeType = recorder.mimeType || 'audio/webm';

    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    mediaRecorderRef.current = null;
    setRecording(false);

    const blob = new Blob(recordedChunksRef.current, { type: actualMimeType });
    recordedChunksRef.current = [];
    if (blob.size === 0) return;

    setSending(true);
    try {
      await sendMessage({
        type: 'audio',
        file: blob,
        fileName: audioFileName(actualMimeType),
      });
      setSendError(null);
    } catch (err) {
      console.error('Не удалось отправить запись', err);
      setSendError(errorMessage(err));
    } finally {
      setSending(false);
    }
  };

  // Отмена без отправки — тот самый "мусорный бачок", которого не хватало.
  const cancelRecording = () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;

    clearRecordingTimers();
    recorder.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    mediaRecorderRef.current = null;
    recordedChunksRef.current = [];
    setRecording(false);
    setRecordingSeconds(0);
  };

  const formatDuration = (totalSeconds: number) => {
    const m = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
    const s = (totalSeconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  const renderMedia = (message: ChatMessage, isMine: boolean) => {
    const url = apiClient.getChatMediaSrc(message.media_key);
    if (message.type === 'image') {
      return (
        <img
          src={url}
          alt=""
          className="chat-media-image"
          loading="lazy"
          onClick={() => setLightbox({ src: url, type: 'image' })}
        />
      );
    }
    if (message.type === 'audio') {
      return <VoiceMessage src={url} mine={isMine} />;
    }
    if (message.type === 'video') {
      // Видео с камеры не копируется при пересылке в чат — если камера уже
      // почистила его по своему retention, ссылка мертва, показываем это
      // явно, а не битый плеер.
      if (mediaErrors.has(message.seq)) {
        return (
          <div className="chat-video-error">
            <VideoOff size={22} />
            <span>Видео недоступно</span>
          </div>
        );
      }
      return (
        <div
          className={`chat-video-thumb ${message.media_kind === 'circle' ? 'circle' : ''}`}
          onClick={() => setLightbox({ src: url, type: 'video' })}
        >
          <video
            src={url}
            muted
            playsInline
            preload="metadata"
            className="chat-video-thumb-el"
            onError={() => setMediaErrors((prev) => new Set(prev).add(message.seq))}
          />
          <span className="chat-video-play-overlay">
            <Play size={22} fill="currentColor" />
          </span>
        </div>
      );
    }
    return null;
  };

  return (
    <div className={`chat-page ${theme} ${inputFocused ? 'chat-page--composing' : ''}`}>
      <div className="chat-header">
        <h1>Чат</h1>
        {connectionState !== 'connected' && (
          <span className="chat-connection-hint">
            {connectionState === 'connecting' ? 'Подключение…' : 'Нет соединения — переподключаемся…'}
          </span>
        )}
      </div>

      {notifStatus !== 'granted' && (
        <div className={`chat-notif-banner chat-notif-banner--${notifStatus}`}>
          {notifStatus === 'default' && (
            <>
              <Bell size={16} />
              <span>Получать уведомления о новых сообщениях, когда чат закрыт?</span>
              <button className="chat-notif-banner-action" onClick={requestNotificationAccess} disabled={pushBusy}>
                {pushBusy ? <Loader2 size={14} className="spin" /> : 'Включить'}
              </button>
            </>
          )}
          {notifStatus === 'denied' && (
            <>
              <BellOff size={16} />
              <span>Уведомления заблокированы браузером — включить можно только вручную, в настройках сайта.</span>
            </>
          )}
          {notifStatus === 'ios-not-installed' && (
            <>
              <BellOff size={16} />
              <span>Чтобы получать уведомления, добавь приложение на экран «Домой» (Поделиться → На экран «Домой»).</span>
            </>
          )}
          {notifStatus === 'unsupported' && (
            <>
              <BellOff size={16} />
              <span>Этот браузер не поддерживает уведомления.</span>
            </>
          )}
        </div>
      )}

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
                  {message.media_key && renderMedia(message, isMine)}
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
        {sendError && (
          <div className="chat-send-error">
            <span>{sendError}</span>
            <button onClick={() => setSendError(null)} title="Закрыть">
              <X size={14} />
            </button>
          </div>
        )}

        {recording && (
          <div className="chat-recording-indicator">
            <button className="chat-recording-cancel" onClick={cancelRecording} title="Отменить">
              <Trash2 size={18} />
            </button>

            <span className="chat-recording-dot" />
            <span className="chat-recording-timer">{formatDuration(recordingSeconds)}</span>

            <button className="chat-recording-send" onClick={() => stopRecording()} title="Отправить">
              <Send size={18} />
            </button>
          </div>
        )}

        {!recording && (
          <div className="chat-input-row">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,video/*"
              hidden
              onChange={handleGallerySelected}
            />

            <button
              className="chat-icon-button"
              disabled={sending}
              onClick={() => fileInputRef.current?.click()}
              title="Галерея"
            >
              <Paperclip size={20} />
            </button>

            <textarea
              ref={textInputRef}
              className="chat-text-input"
              rows={1}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSendText();
                }
              }}
              placeholder="Сообщение…"
            />

            {inputText.trim() ? (
              <button className="chat-send-button" disabled={sending} onClick={handleSendText}>
                {sending ? <Loader2 size={18} className="spin" /> : <Send size={18} />}
              </button>
            ) : (
              <button
                className="chat-icon-button"
                disabled={sending}
                onClick={() => startRecording()}
                title="Голосовое"
              >
                <Mic size={20} />
              </button>
            )}
          </div>
        )}
      </div>

      {!inputFocused && <BottomNavBar />}

      <AnimatePresence>
        {lightbox && (
          <motion.div
            className="chat-lightbox-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setLightbox(null)}
          >
            <button
              className="chat-lightbox-close"
              onClick={() => setLightbox(null)}
              title="Закрыть"
            >
              <X size={22} />
            </button>
            {lightbox.type === 'image' ? (
              <img
                src={lightbox.src}
                alt=""
                className="chat-lightbox-image"
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <video
                src={lightbox.src}
                controls
                autoPlay
                playsInline
                className="chat-lightbox-video"
                onClick={(e) => e.stopPropagation()}
              />
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
