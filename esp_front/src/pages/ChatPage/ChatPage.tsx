import React, { useEffect, useRef, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Send, Mic, Trash2, Loader2, Bell, BellOff, Paperclip, X, Play, Video, VideoOff, Pin, PinOff, ChevronDown, Sun, Moon, Settings } from 'lucide-react';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { useChat, previewForMessage } from '../../context/ChatContext';
import { apiClient } from '../../api/client';
import type { ChatMessage, PushStatusEntry } from '../../api/client';
import { BottomNavBar } from '../../components/BottomNavBar/BottomNavBar';
import { VoiceMessage } from './VoiceMessage';
import './ChatPage.css';

const MAX_RECORD_MS = 60_000;
const HOLD_THRESHOLD_MS = 400; // дольше этого — считаем "держит", отпустил — отправить сразу
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
  const { theme, toggleTheme } = useTheme();
  const { userId } = useAuth();
  const {
    messages, pendingUploads, reads, connectionState, loadingHistory, historyReady, hasMoreHistory, loadMoreHistory, sendMessage, markRead,
    pinnedMessage, pinMessage, unpinMessage,
  } = useChat();

  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState(false);
  const [micPressed, setMicPressed] = useState(false);
  const [lightbox, setLightbox] = useState<{ src: string; type: 'image' | 'video'; seq?: number } | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [inputFocused, setInputFocused] = useState(false);
  const [mediaErrors, setMediaErrors] = useState<Set<number>>(new Set());
  const [pinTarget, setPinTarget] = useState<ChatMessage | null>(null);
  const [pushStatuses, setPushStatuses] = useState<PushStatusEntry[]>([]);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const nearBottomRef = useRef(true);

  const [notifStatus, setNotifStatus] = useState<NotifStatus>('default');
  const [pushBusy, setPushBusy] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  const messagesContentRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const inputBarRef = useRef<HTMLDivElement>(null);
  const inputRowRef = useRef<HTMLDivElement>(null);
  const [scrollBtnBottom, setScrollBtnBottom] = useState(90);
  const [scrollBtnSize, setScrollBtnSize] = useState(38);
  const [headerPadTop, setHeaderPadTop] = useState(76);
  const [messagesPadBottom, setMessagesPadBottom] = useState(78);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textInputRef = useRef<HTMLTextAreaElement>(null);
  const lastSeqRef = useRef<number | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heldLongEnoughRef = useRef(false);
  const pressWasSecondTapRef = useRef(false);

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
  // подгрузке истории вверх — там последний seq не меняется), и только если
  // юзер и так был внизу ленты или сообщение своё — иначе, читая историю,
  // его будет каждый раз выдёргивать к новому сообщению. В обратном случае
  // просто показываем стрелку "вниз" вместо принудительного скролла.
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (!last) return;
    // Первое заполнение ленты при заходе на страницу — прыгаем вниз мгновенно
    // (как Telegram/WhatsApp), а не анимированно: 'smooth' на моментальном же
    // requestAnimationFrame ещё и гонится с ResizeObserver-коррекцией ниже за
    // тот же scrollTop, если картинки/видео в ленте досчитывают размеры чуть
    // позже первого рендера — smooth-анимация может "выиграть" гонку и
    // застрять на промежуточной, ещё не окончательной высоте контента.
    const isInitialLoad = lastSeqRef.current === null;
    if (lastSeqRef.current !== last.seq) {
      lastSeqRef.current = last.seq;
      if (last.user_id === userId || nearBottomRef.current) {
        requestAnimationFrame(() => {
          listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: isInitialLoad ? 'auto' : 'smooth' });
        });
      } else {
        setShowScrollDown(true);
      }
    }
  }, [messages, userId]);

  // Картинки/видео в ленте догружают реальные размеры позже первого рендера —
  // разовый scrollTo выше целится в scrollHeight на момент вызова и промахивается
  // мимо настоящего низа, если медиа раздвигает список уже после. Пока юзер и так
  // внизу — держим его там же при любом росте контента ленты, а не только по
  // приходу нового сообщения.
  // Кнопка "вниз" — position: fixed относительно всего экрана (не относительно
  // ленты сообщений), иначе она едет вместе со скроллом чата и может залезать
  // под инпут/навбар. Держим её всегда впритык над реальной верхней гранью
  // .chat-input-bar, чей отступ от низа экрана меняется (растущий textarea,
  // скрытие BottomNavBar при фокусе, safe-area) — поэтому меряем, а не хардкодим.
  useEffect(() => {
    const bar = inputBarRef.current;
    if (!bar) return;
    const recalc = () => {
      const rect = bar.getBoundingClientRect();
      const clearance = Math.max(0, window.innerHeight - rect.top);
      setScrollBtnBottom(clearance + 12);
      // .chat-input-bar сам теперь position: fixed (иначе на iOS его вместе
      // с шапкой утаскивало скроллом body при фокусе поля — см. комментарий
      // у .chat-header ниже), поэтому лента больше не получает это место
      // бесплатно через flex-раскладку — резервируем его явно отступом.
      setMessagesPadBottom(clearance + 8);
    };
    recalc();
    const ro = new ResizeObserver(recalc);
    ro.observe(bar);
    window.addEventListener('resize', recalc);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', recalc);
    };
  }, [inputFocused]);

  // Размер кнопки — 0.8 от реальной высоты пилюли поля ввода (а не хардкод),
  // чтобы она всегда была соразмерна инпуту, а не своей произвольной величиной.
  useEffect(() => {
    const row = inputRowRef.current;
    if (!row) return;
    const recalc = () => setScrollBtnSize(row.getBoundingClientRect().height * 0.8);
    recalc();
    const ro = new ResizeObserver(recalc);
    ro.observe(row);
    return () => ro.disconnect();
  }, []);

  // Шапка чата тоже переехала в position: fixed (та же причина, что у
  // инпута), так что и под неё лента с баннерами больше не подстраивается
  // сама — меряем реальную высоту (с учётом safe-area) и подкладываем это
  // как padding-top всей странице.
  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const recalc = () => {
      setHeaderPadTop(header.getBoundingClientRect().bottom);
    };
    recalc();
    const ro = new ResizeObserver(recalc);
    ro.observe(header);
    window.addEventListener('resize', recalc);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', recalc);
    };
  }, []);

  useEffect(() => {
    const container = listRef.current;
    const content = messagesContentRef.current;
    if (!container || !content) return;
    const ro = new ResizeObserver(() => {
      if (nearBottomRef.current) {
        container.scrollTop = container.scrollHeight;
      }
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);


  // Отпускаем камеру/микрофон при уходе со страницы
  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (recordTimeoutRef.current) clearTimeout(recordTimeoutRef.current);
      if (recordingIntervalRef.current) clearInterval(recordingIntervalRef.current);
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
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

  // Кто из юзеров сейчас подписан на пуш — рефетчим и при собственной смене
  // статуса (например, только что включил уведомления сам).
  useEffect(() => {
    apiClient.getChatPushStatus().then((res) => setPushStatuses(res.statuses)).catch(() => {});
  }, [notifStatus]);

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

  const NEAR_BOTTOM_PX = 120;

  const handleScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;

    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const near = distanceFromBottom < NEAR_BOTTOM_PX;
    nearBottomRef.current = near;
    setShowScrollDown(!near);

    if (el.scrollTop > 80 || !hasMoreHistory || loadingHistory) return;
    const prevHeight = el.scrollHeight;
    loadMoreHistory().then(() => {
      requestAnimationFrame(() => {
        if (listRef.current) {
          listRef.current.scrollTop = listRef.current.scrollHeight - prevHeight;
        }
      });
    });
  }, [hasMoreHistory, loadingHistory, loadMoreHistory]);

  const scrollToBottom = () => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
    nearBottomRef.current = true;
    setShowScrollDown(false);
  };

  const handleSendText = async () => {
    const text = inputText.trim();
    if (!text || sending) return;
    if (connectionState !== 'connected') {
      setSendError('Нет соединения — дождись переподключения и отправь ещё раз');
      return;
    }
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
    if (connectionState !== 'connected') {
      setSendError('Нет соединения — дождись переподключения и отправь ещё раз');
      return;
    }

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
    if (connectionState !== 'connected') {
      setSendError('Нет соединения — запись потеряна, дождись переподключения и попробуй снова');
      return;
    }

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

  // Одна и та же кнопка обслуживает оба сценария записи:
  // 1) короткий тап — запись стартует по pointerdown и остаётся идти, ждём
  //    второй тап (или крестик), чтобы отправить/отменить.
  // 2) удержание дольше HOLD_THRESHOLD_MS — отпустил палец → сразу отправляем,
  //    как в Telegram/WhatsApp.
  // setPointerCapture держит все дальнейшие события на этой кнопке, даже если
  // палец во время удержания уехал за её физические границы — не нужно отдельно
  // расширять hit-area, отпускание/движение всё равно долетит до нас.
  const handleMicPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (sending) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setMicPressed(true);
    const wasAlreadyRecording = recording;
    pressWasSecondTapRef.current = wasAlreadyRecording;
    if (!wasAlreadyRecording) {
      startRecording();
      heldLongEnoughRef.current = false;
      holdTimerRef.current = setTimeout(() => {
        heldLongEnoughRef.current = true;
      }, HOLD_THRESHOLD_MS);
    }
  };

  const handleMicPointerUp = () => {
    setMicPressed(false);
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    // Отправляем, если это было удержание (успело сработать heldLongEnoughRef)
    // ИЛИ это уже второй тап поверх идущей записи. Короткий первый тап —
    // просто остаёмся в режиме ожидания.
    if (pressWasSecondTapRef.current || heldLongEnoughRef.current) {
      stopRecording();
    }
  };

  // pointercancel (система прервала жест — например распознала скролл) —
  // намеренно ничего не отменяем и не отправляем: реальный звук мог уже
  // записаться, юзер сам решит через крестик или повторный тап.
  const handleMicPointerCancel = () => {
    setMicPressed(false);
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  };

  const formatDuration = (totalSeconds: number) => {
    const m = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
    const s = (totalSeconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  // Long-press (и правый клик на десктопе) по пузырю открывает мини-меню
  // закрепить/открепить — тап-и-клик на медиа внутри пузыря при этом должен
  // молчать один раз, иначе после долгого нажатия ещё и лайтбокс откроется.
  const LONG_PRESS_MS = 450;

  const startLongPress = (message: ChatMessage) => {
    longPressFiredRef.current = false;
    longPressTimerRef.current = setTimeout(() => {
      longPressFiredRef.current = true;
      navigator.vibrate?.(10);
      setPinTarget(message);
    }, LONG_PRESS_MS);
  };

  const cancelLongPress = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const suppressClickIfLongPress = (e: React.MouseEvent): boolean => {
    if (longPressFiredRef.current) {
      e.preventDefault();
      e.stopPropagation();
      longPressFiredRef.current = false;
      return true;
    }
    return false;
  };

  const scrollToMessage = (seq: number) => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-seq="${seq}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
          onClick={(e) => { if (suppressClickIfLongPress(e)) return; setLightbox({ src: url, type: 'image' }); }}
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
      // Раньше тут был <video preload="metadata"> на каждое сообщение — при
      // рендере ленты с несколькими видео это давало залп параллельных
      // range-запросов (до 14 в секунду на проде), похожий на флуд для
      // anti-DDoS хостера. Теперь в ленте только статичная картинка (если
      // есть thumbnail_key — только у видео, расшаренных из архива камеры)
      // либо просто плейсхолдер; настоящий <video> грузится только в
      // лайтбоксе по клику.
      return (
        <div
          className={`chat-video-thumb ${message.media_kind === 'circle' ? 'circle' : ''}`}
          onClick={(e) => { if (suppressClickIfLongPress(e)) return; setLightbox({ src: url, type: 'video', seq: message.seq }); }}
        >
          {message.thumbnail_key && (
            <img
              src={apiClient.getChatMediaSrc(message.thumbnail_key)}
              alt=""
              loading="lazy"
              className="chat-video-thumb-el"
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
          )}
          <span className="chat-video-play-overlay">
            <Play size={22} fill="currentColor" />
          </span>
        </div>
      );
    }
    return null;
  };

  return (
    <div className={`chat-page ${theme} ${inputFocused ? 'chat-page--composing' : ''}`} style={{ paddingTop: headerPadTop }}>
      <div className="chat-header" ref={headerRef}>
        <div className="chat-header-top">
          <h1>Чат</h1>
          {connectionState !== 'connected' && (
            <span className="chat-connection-hint">
              {connectionState === 'connecting' ? 'Подключение…' : 'Переподключение…'}
            </span>
          )}
          {/* Пока просто заглушка в шапке — действия нет, экран настроек ещё не сделан. */}
          <button className="chat-header-icon-button chat-settings-button" title="Настройки">
            <Settings size={18} />
          </button>
          <button
            className="chat-header-icon-button"
            onClick={toggleTheme}
            title={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
          >
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </div>

        {pushStatuses.length > 0 && (
          <div className="chat-push-status">
            <Bell size={12} />
            <span>
              {(() => {
                const names = pushStatuses.filter((s) => s.subscribed).map((s) => s.display_name);
                return names.length > 0 ? `Уведомления получат: ${names.join(', ')}` : 'Никто не включил уведомления';
              })()}
            </span>
          </div>
        )}
      </div>

      {pinnedMessage && (
        <div className="chat-pinned-banner" onClick={() => scrollToMessage(pinnedMessage.seq)}>
          <Pin size={18} />
          <span className="chat-pinned-text">{previewForMessage(pinnedMessage)}</span>
          <button onClick={(e) => { e.stopPropagation(); unpinMessage(); }} title="Открепить">
            <X size={20} />
          </button>
        </div>
      )}

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

      <div className="chat-messages" ref={listRef} onScroll={handleScroll} style={{ paddingBottom: messagesPadBottom }}>
        {loadingHistory && messages.length === 0 && (
          <div className="chat-loading"><Loader2 size={20} className="spin" /></div>
        )}
        {hasMoreHistory && messages.length > 0 && (
          <div className="chat-load-more-hint">
            {loadingHistory ? 'Загружаем историю…' : 'Прокрутите вверх для истории'}
          </div>
        )}

        <div
          className={`chat-messages-content ${historyReady ? 'chat-messages-content--ready' : ''}`}
          ref={messagesContentRef}
        >
        <AnimatePresence initial={false}>
          {messages.map((message, idx) => {
            const isMine = message.user_id === userId;
            const isLast = idx === messages.length - 1;
            const readers = isLast
              ? reads.filter((r) => r.user_id !== message.user_id && r.last_read_seq >= message.seq)
              : [];

            const isPinned = pinnedMessage?.seq === message.seq;
            // Булавка сидит в "пустом" гуттере рядом с пузырём — у своих слева
            // (пузырь прижат к правому краю), у чужих справа (пузырь у левого
            // края), поэтому порядок в DOM буквально разный, не просто CSS order.
            const pinButton = (
              <button
                className={`chat-pin-toggle ${isPinned ? 'pinned' : ''}`}
                onClick={() => setPinTarget(message)}
                title={isPinned ? 'Открепить' : 'Закрепить'}
              >
                <Pin size={18} />
              </button>
            );

            return (
              <motion.div
                key={message.seq}
                data-seq={message.seq}
                className={`chat-bubble-outer ${isMine ? 'mine' : ''}`}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
              >
                {isMine && pinButton}
                <div className="chat-bubble-col">
                  <div
                    className="chat-bubble"
                    onPointerDown={() => startLongPress(message)}
                    onPointerUp={cancelLongPress}
                    onPointerCancel={cancelLongPress}
                    onContextMenu={(e) => { e.preventDefault(); setPinTarget(message); }}
                  >
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
                </div>
                {!isMine && pinButton}
              </motion.div>
            );
          })}

          {pendingUploads.map((upload) => (
            <motion.div
              key={upload.localId}
              className="chat-bubble-outer mine"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
            >
              <div className="chat-bubble-col">
              <div className="chat-bubble chat-bubble--uploading">
                <div className={`chat-upload-preview ${upload.type === 'audio' ? 'chat-upload-preview--audio' : ''}`}>
                  {upload.type === 'image' && upload.previewUrl && (
                    <img src={upload.previewUrl} alt="" />
                  )}
                  {upload.type === 'video' && upload.previewUrl && (
                    <video src={upload.previewUrl} muted preload="metadata" />
                  )}
                  {upload.type === 'video' && !upload.previewUrl && (
                    <div className="chat-upload-audio-placeholder"><Video size={22} /></div>
                  )}
                  <div className="chat-upload-overlay">
                    {upload.type === 'audio' && <Mic size={18} />}
                    <svg className="chat-upload-ring" viewBox="0 0 40 40">
                      <circle className="chat-upload-ring-track" cx="20" cy="20" r="17" />
                      <circle
                        className="chat-upload-ring-progress"
                        cx="20" cy="20" r="17"
                        strokeDasharray={2 * Math.PI * 17}
                        strokeDashoffset={2 * Math.PI * 17 * (1 - upload.progress)}
                      />
                    </svg>
                    <span className="chat-upload-percent">{Math.round(upload.progress * 100)}%</span>
                  </div>
                </div>
              </div>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
        </div>

      </div>

      {showScrollDown && (
        <button
          className="chat-scroll-bottom-btn"
          style={{ bottom: scrollBtnBottom, width: scrollBtnSize, height: scrollBtnSize }}
          onClick={scrollToBottom}
          title="К последним сообщениям"
        >
          <ChevronDown size={Math.round(scrollBtnSize * 0.5)} />
        </button>
      )}

      <div className="chat-input-bar" ref={inputBarRef}>
        {sendError && (
          <div className="chat-send-error">
            <span>{sendError}</span>
            <button onClick={() => setSendError(null)} title="Закрыть">
              <X size={14} />
            </button>
          </div>
        )}

        <div className="chat-input-row" ref={inputRowRef}>
          {!recording && (
            <>
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
                enterKeyHint="send"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSendText();
                  }
                }}
                placeholder="Сообщение…"
              />
            </>
          )}

          {recording && (
            <>
              <button className="chat-recording-cancel" onClick={cancelRecording} title="Отменить">
                <Trash2 size={18} />
              </button>
              <span className="chat-recording-dot" />
              <span className="chat-recording-timer">{formatDuration(recordingSeconds)}</span>
            </>
          )}

          {/* Одна и та же кнопка живёт и как "начать голосовое", и как "тап/отпускание
              чтобы отправить" — специально НЕ размонтируется между этими состояниями
              (см. handleMicPointerDown), иначе setPointerCapture слетит на середине
              удержания. */}
          {!recording && inputText.trim() ? (
            <button
              className={`chat-send-button ${connectionState !== 'connected' ? 'chat-send-button--offline' : ''}`}
              disabled={sending}
              onMouseDown={(e) => e.preventDefault()}
              onClick={handleSendText}
              title={connectionState !== 'connected' ? 'Нет соединения — отправка не пройдёт' : undefined}
            >
              {sending ? <Loader2 size={18} className="spin" /> : <Send size={18} />}
            </button>
          ) : (
            <button
              className={`chat-icon-button chat-mic-button ${recording ? 'recording' : ''} ${micPressed ? 'chat-mic-button--pressed' : ''}`}
              disabled={sending}
              onPointerDown={handleMicPointerDown}
              onPointerUp={handleMicPointerUp}
              onPointerCancel={handleMicPointerCancel}
              title={recording ? 'Отпустите, чтобы отправить, или тапните ещё раз' : 'Голосовое: тап — начать, ещё тап — отправить; или удержите и отпустите'}
            >
              {recording ? <Send size={18} /> : <Mic size={20} />}
            </button>
          )}
        </div>
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
            {/* Свайп вниз закрывает — как на странице "Видео"/большинстве
                чатов. drag только на самом медиа (не на бэкдропе), чтобы не
                перехватывать тап по крестику; при отпускании дальше 100px
                или с достаточной скоростью — закрываем, иначе framer сам
                пружинит обратно в 0 (dragConstraints top:0 bottom:0). */}
            {lightbox.type === 'image' ? (
              <motion.img
                src={lightbox.src}
                alt=""
                className="chat-lightbox-image"
                onClick={(e) => e.stopPropagation()}
                drag="y"
                dragConstraints={{ top: 0, bottom: 0 }}
                dragElastic={0.8}
                onDragEnd={(_, info) => {
                  if (Math.abs(info.offset.y) > 100 || Math.abs(info.velocity.y) > 500) setLightbox(null);
                }}
              />
            ) : (
              <motion.div
                className="chat-lightbox-video-container"
                onClick={(e) => e.stopPropagation()}
                drag="y"
                dragConstraints={{ top: 0, bottom: 0 }}
                dragElastic={0.8}
                onDragEnd={(_, info) => {
                  if (Math.abs(info.offset.y) > 100 || Math.abs(info.velocity.y) > 500) setLightbox(null);
                }}
              >
                <video
                  src={lightbox.src}
                  controls
                  autoPlay
                  className="chat-lightbox-video"
                  onError={() => {
                    if (lightbox.seq !== undefined) setMediaErrors((prev) => new Set(prev).add(lightbox.seq!));
                    setLightbox(null);
                  }}
                />
              </motion.div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {pinTarget && (
          <motion.div
            className="chat-pin-sheet-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setPinTarget(null)}
          >
            <motion.div
              className="chat-pin-sheet"
              initial={{ y: 40, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 40, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={async () => {
                  const target = pinTarget;
                  setPinTarget(null);
                  if (pinnedMessage?.seq === target.seq) {
                    await unpinMessage();
                  } else {
                    await pinMessage(target.seq);
                  }
                }}
              >
                {pinnedMessage?.seq === pinTarget.seq ? <PinOff size={18} /> : <Pin size={18} />}
                {pinnedMessage?.seq === pinTarget.seq ? 'Открепить сообщение' : 'Закрепить сообщение'}
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
