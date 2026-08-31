import React, { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react';
import { motion, AnimatePresence, useMotionValue } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { Send, Mic, Trash2, Loader2, Bell, BellOff, Paperclip, X, Play, Video, VideoOff, Pin, PinOff, Copy, ChevronDown, Sun, Moon, Settings, MessageCircle, CornerUpLeft, Pencil, Check, Download } from 'lucide-react';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { useChat, previewForMessage } from '../../context/ChatContext';
import { apiClient } from '../../api/client';
import type { ChatMessage, ChatReadState } from '../../api/client';
import { useHideNavBar } from '../../context/NavBarContext';
import { useChatPush } from '../../hooks/useChatPush';
import { usePageVisit } from '../../hooks/usePageVisit';
import { VoiceMessage } from './VoiceMessage';
import './ChatPage.css';

const MAX_CHAT_FILE_BYTES = 50 * 1024 * 1024; // синхронно с CHAT_MEDIA_MAX_BYTES на бэке
const MAX_RECORD_MS = 60_000;
const MIN_RECORD_MS = 2_000; // короче — считаем случайным тапом, не отправляем
const HOLD_THRESHOLD_MS = 400; // дольше этого — считаем "держит", отпустил — отправить сразу
// Окно на удаление своего сообщения. Синхронно с CHAT_DELETE_WINDOW на бэке —
// там же оно и проверяется по-настоящему, тут только чтобы не показывать
// заведомо мёртвый пункт меню.
const DELETE_WINDOW_MS = 60 * 60 * 1000;
// Окно на правку — такое же, как на удаление, и так же синхронно с бэком
// (CHAT_EDIT_WINDOW), где оно и проверяется по-настоящему.
const EDIT_WINDOW_MS = 60 * 60 * 1000;
// Насколько пузырь подпрыгивает: коротко и сильно по тапу, чуть-чуть и
// надолго — пока висит меню по долгому нажатию. Вибро-отклик на большинстве
// телефонов из PWA не работает, поэтому подтверждение нажатия визуальное.
const BUBBLE_POP_SCALE = 1.07;
const BUBBLE_HOLD_SCALE = 1.03;
const BUBBLE_POP_MS = 280;

// Цвет кружка "прочитано" — по user_id, а не по позиции в списке: так буква
// у человека всегда одного цвета, независимо от порядка ответа сервера.
const READ_AVATAR_COLORS = ['#3b82f6', '#10b981', '#a855f7', '#f97316', '#ec4899', '#06b6d4'];
const readAvatarColor = (userId: number) => READ_AVATAR_COLORS[Math.abs(userId) % READ_AVATAR_COLORS.length];
const readAvatarLetter = (displayName: string) => displayName.trim().charAt(0).toUpperCase() || '?';

const formatTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

// Ключ дня для группировки — по локальным Y/M/D, а не по самой ISO-строке
// (та в UTC и может съехать на соседний день от локального).
const dayKey = (iso: string): string => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

// Плашка-разделитель дат в ленте — "Сегодня"/"Вчера"/"31 августа", как в Telegram.
const formatDateDivider = (iso: string): string => {
  const date = new Date(iso);
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (diffDays === 0) return 'Сегодня';
  if (diffDays === 1) return 'Вчера';
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString('ru-RU', sameYear
    ? { day: 'numeric', month: 'long' }
    : { day: 'numeric', month: 'long', year: 'numeric' });
};

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

export const ChatPage: React.FC = () => {
  usePageVisit('chat');
  const { theme, toggleTheme } = useTheme();
  const { userId } = useAuth();
  const navigate = useNavigate();
  const {
    messages, pendingUploads, reads, connectionState, loadingHistory, historyReady, hasMoreHistory, loadMoreHistory, sendMessage, markRead,
    pinnedMessage, pinMessage, unpinMessage, deleteMessage, editMessage, presence, typingUsers, notifyTyping,
  } = useChat();

  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState(false);
  const [micPressed, setMicPressed] = useState(false);
  const [lightbox, setLightbox] = useState<{ src: string; type: 'image' | 'video'; seq?: number; mediaKey?: string } | null>(null);
  const [downloadingMedia, setDownloadingMedia] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0); // -1 = подготовка, 0-100 = прогресс, как на странице "Видео"
  // Зум фото в лайтбоксе: scale — обычный стейт (щипок должен трекать палец 1:1,
  // без пружины), x/y — motion-values, их же двигает drag (см. проп style на
  // <motion.img> ниже) — так панорамирование зумленного фото и его сброс живут
  // в одном месте, а не расходятся с внутренним состоянием drag у framer.
  const [imgScale, setImgScale] = useState(1);
  const imgX = useMotionValue(0);
  const imgY = useMotionValue(0);
  const pinchStartRef = useRef<{ dist: number; scale: number } | null>(null);
  const lastTapRef = useRef(0);
  const [sendError, setSendError] = useState<string | null>(null);
  const [inputFocused, setInputFocused] = useState(false);
  // Клавиатура iOS открыта — убираем нав-бар с экрана (сам он живёт в App.tsx).
  useHideNavBar(inputFocused);
  const [mediaErrors, setMediaErrors] = useState<Set<number>>(new Set());
  const [actionTarget, setActionTarget] = useState<ChatMessage | null>(null);
  // Меню считает свою позицию уже после того, как отрисуется — до замера
  // собственных размеров непонятно, влезает ли оно под сообщение.
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);
  // Геометрия пузыря, над которым открыто меню — по ней рисуется его копия
  // поверх размытого фона.
  const [anchorRect, setAnchorRect] = useState<{ left: number; top: number; width: number } | null>(null);
  const actionMenuRef = useRef<HTMLDivElement>(null);
  const [poppedSeq, setPoppedSeq] = useState<number | null>(null);
  const popTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ответ и правка взаимоисключающие — поле ввода одно, и занято либо тем, либо другим.
  const [replyTarget, setReplyTarget] = useState<ChatMessage | null>(null);
  const [editTarget, setEditTarget] = useState<ChatMessage | null>(null);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const nearBottomRef = useRef(true);
  // Палец сейчас на ленте — пока это так, ничего не пишем в scrollTop сами
  // (см. ResizeObserver ниже): программная запись scrollTop поверх активного
  // тач-жеста на iOS — известный триггер "заморозки" слоя скролла в WKWebView,
  // тот же класс бага, что раньше ловили на backdrop-filter меню действий.
  const isTouchingListRef = useRef(false);
  const pendingBottomPinRef = useRef(false);

  const { notifStatus, busy: pushBusy, requestAccess: requestNotificationAccess } = useChatPush();

  // connectionState стартует как 'connecting' при каждом монтировании страницы
  // (см. ChatContext) — без этой отметки заголовок дёргался бы "Подключение…"
  // на любое первое открытие чата, а не только на реальный обрыв уже
  // установленной связи.
  const hasConnectedOnceRef = useRef(false);

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
  const textInputRef = useRef<HTMLDivElement>(null);
  const lastSeqRef = useRef<number | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);
  const longPressOriginRef = useRef<{ x: number; y: number } | null>(null);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heldLongEnoughRef = useRef(false);
  const pressWasSecondTapRef = useRef(false);

  const [recordingSeconds, setRecordingSeconds] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const recordStartRef = useRef(0);
  const recordTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Фейд-ин страницы завязан на этот флаг, а не на historyReady из
  // ChatContext напрямую: historyReady грузится фоном ещё в ChatProvider на
  // верху приложения (сразу после логина) и обратно в false никогда не
  // сбрасывается — так что к моменту реального захода на вкладку он почти
  // всегда уже true, и просто применить его классом в первом же рендере
  // означало бы отрисоваться сразу в конечном состоянии: transition нечего
  // отыгрывать, если "было" и "стало" совпадают на первом же кадре. rAF
  // гарантирует, что первый paint страницы всегда происходит в
  // "невидимом" состоянии — ровно как loading-стейт на Видео/Настройках,
  // которые тоже стартуют заново при каждом монтировании страницы.
  const [pageEntered, setPageEntered] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setPageEntered(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    markRead();
  }, [messages.length, markRead]);

  useEffect(() => {
    if (connectionState === 'connected') hasConnectedOnceRef.current = true;
  }, [connectionState]);

  useEffect(() => {
    if (!sendError) return;
    const timer = setTimeout(() => setSendError(null), 6000);
    return () => clearTimeout(timer);
  }, [sendError]);

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
      // Тут НЕ clearance (полное расстояние от бара до низа экрана) — та часть
      // (84px/safe-area под BottomNavBar) уже вычтена из высоты .chat-messages
      // самим .chat-page.padding-bottom (см. ChatPage.css), лента получает её
      // бесплатно через flex-раскладку. Плюс clearance сюда сложило бы этот
      // отступ ДВАЖДЫ — отсюда и лишняя дыра под последним сообщением. Тут
      // нужна только собственная высота бара (он оверлеит верхнюю кромку
      // ленты, а не весь зазор до низа экрана).
      setMessagesPadBottom(rect.height + 8);
    };
    recalc();
    const ro = new ResizeObserver(recalc);
    ro.observe(bar);
    window.addEventListener('resize', recalc);
    // .chat-input-bar анимирует свой bottom при фокусе/расфокусе (см. .chat-page--composing) —
    // ResizeObserver на это не реагирует (размер бара не меняется, только позиция), поэтому
    // recalc() выше застревал на значении из самого начала transition. Досчитываем ещё раз,
    // когда анимация bottom реально закончится.
    const onTransitionEnd = (e: TransitionEvent) => {
      if (e.propertyName === 'bottom') recalc();
    };
    bar.addEventListener('transitionend', onTransitionEnd);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', recalc);
      bar.removeEventListener('transitionend', onTransitionEnd);
    };
  }, [inputFocused]);

  // Размер кнопки — 1.2 от реальной высоты пилюли поля ввода (а не хардкод),
  // чтобы она всегда была соразмерна инпуту, а не своей произвольной величиной.
  useEffect(() => {
    const row = inputRowRef.current;
    if (!row) return;
    const recalc = () => setScrollBtnSize(row.getBoundingClientRect().height * 1.2);
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
      if (!nearBottomRef.current) return;
      // Палец на ленте (см. isTouchingListRef выше) — не пишем scrollTop
      // прямо сейчас, запоминаем и дописываем по touchend.
      if (isTouchingListRef.current) {
        pendingBottomPinRef.current = true;
        return;
      }
      container.scrollTop = container.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  const handleMessagesTouchStart = () => {
    isTouchingListRef.current = true;
  };

  const handleMessagesTouchEnd = () => {
    isTouchingListRef.current = false;
    if (!pendingBottomPinRef.current) return;
    pendingBottomPinRef.current = false;
    // Кадр запаса — чтобы не столкнуться с ещё не отыгравшей нативной
    // инерцией/отскоком у самого конца жеста.
    requestAnimationFrame(() => {
      if (listRef.current && nearBottomRef.current) {
        listRef.current.scrollTop = listRef.current.scrollHeight;
      }
    });
  };


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
  // вешаем Escape для закрытия. Пинч-зум фото приходится реализовывать самим
  // (колесо/трекпад + touch, см. handleImage*): у всего приложения в index.html
  // стоит viewport user-scalable=no, так что нативного зума тут нет.
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

  // Сброс зума при открытии нового медиа/закрытии — иначе следующее фото
  // открылось бы уже приближенным состоянием предыдущего.
  useEffect(() => {
    setImgScale(1);
    imgX.set(0);
    imgY.set(0);
  }, [lightbox?.src]);

  const NEAR_BOTTOM_PX = 120;

  // Как в Telegram/WhatsApp — начали скроллить ленту, значит уже не печатают:
  // убираем фокус с поля, чтобы клавиатура не торчала поверх сообщений.
  //
  // Вешаем на реальный жест (touchmove/wheel), а НЕ на событие scroll. Раньше
  // блюр стоял в handleScroll, и получалась петля: тап по полю → фокус →
  // .chat-page--composing и скрытие нав-бара меняют раскладку → .chat-messages
  // меняет высоту → браузер сам выдаёт scroll → handleScroll видит фокус на
  // поле и снимает его. Клавиатура закрывалась ровно в момент открытия, и с
  // первого тапа поле не открывалось вообще. Жест пользователя такой петли не
  // создаёт: раскладка сама по себе touchmove не генерирует.
  const dismissKeyboardOnUserScroll = useCallback(() => {
    if (document.activeElement === textInputRef.current) {
      textInputRef.current?.blur();
    }
  }, []);

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

  // Поле ввода — contenteditable div, а не textarea: на iOS textarea/input
  // всегда тянет за собой системную панель над клавиатурой со стрелками
  // "предыдущее/следующее поле" (WebKit строит её по фокусируемым элементам
  // страницы), а до contenteditable эта панель не добирается — так же, как в
  // Telegram Web. Раз это не textarea, содержимое не строка, а DOM (текст +
  // <br> на переносах) — ниже читаем/пишем его руками вместо value/onChange.
  const getComposerText = (el: HTMLElement): string => {
    let text = '';
    el.childNodes.forEach((node) => {
      text += node.nodeName === 'BR' ? '\n' : node.textContent ?? '';
    });
    return text;
  };

  // Вставляем чистый текст в позицию курсора как текстовые узлы + <br> на
  // переносах — без этого браузер на Enter/paste норовит навставлять <div>
  // на каждую строку или притащить форматирование из буфера обмена.
  const insertPlainTextAtCaret = (text: string) => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const fragment = document.createDocumentFragment();
    let lastNode: ChildNode | null = null;
    text.split('\n').forEach((line, i) => {
      if (i > 0) lastNode = fragment.appendChild(document.createElement('br'));
      if (line) lastNode = fragment.appendChild(document.createTextNode(line));
    });
    range.insertNode(fragment);
    if (lastNode) {
      const newRange = document.createRange();
      newRange.setStartAfter(lastNode);
      newRange.collapse(true);
      selection.removeAllRanges();
      selection.addRange(newRange);
    }
  };

  const syncComposerState = () => {
    const el = textInputRef.current;
    if (!el) return;
    const text = getComposerText(el);
    setInputText(text);
    if (text.trim()) notifyTyping();
  };

  const handleComposerPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    insertPlainTextAtCaret(e.clipboardData.getData('text/plain'));
    syncComposerState();
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
      if (editTarget) {
        await editMessage(editTarget.seq, text);
        setEditTarget(null);
      } else {
        await sendMessage({ type: 'text', text, replyTo: replyTarget?.seq ?? null });
        setReplyTarget(null);
      }
      setInputText('');
      if (textInputRef.current) textInputRef.current.textContent = '';
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

  const handleComposerKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && (replyTarget || editTarget)) {
      e.preventDefault();
      cancelComposerContext();
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (e.shiftKey) {
      insertPlainTextAtCaret('\n');
      syncComposerState();
    } else {
      handleSendText();
    }
  };

  // Галерея — обычный файловый пикер (без capture), поэтому сюда прилетает
  // и фото, и видео из библиотеки, а не только снимки с камеры.
  const handleGallerySelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || sending) return;
    if (file.size > MAX_CHAT_FILE_BYTES) {
      alert(`Файл слишком большой (${(file.size / (1024 * 1024)).toFixed(1)} МБ). Максимум — 50 МБ.`);
      return;
    }
    if (connectionState !== 'connected') {
      setSendError('Нет соединения — дождись переподключения и отправь ещё раз');
      return;
    }

    setSending(true);
    try {
      const replyTo = replyTarget?.seq ?? null;
      const videoMime = guessVideoMimeType(file);
      if (videoMime) {
        const videoFile = videoMime === file.type ? file : new Blob([file], { type: videoMime });
        await sendMessage({ type: 'video', file: videoFile, fileName: file.name || 'video.mp4', replyTo });
      } else {
        const resized = await resizeImage(file);
        await sendMessage({ type: 'image', file: resized, fileName: 'photo.jpg', replyTo });
      }
      setReplyTarget(null);
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
      recordStartRef.current = Date.now();
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
    if (Date.now() - recordStartRef.current < MIN_RECORD_MS) {
      alert('Голосовое слишком короткое — минимум 2 секунды');
      return;
    }
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
        replyTo: replyTarget?.seq ?? null,
      });
      setReplyTarget(null);
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

  // Long-press (и правый клик на десктопе) по пузырю открывает меню действий —
  // копировать/закрепить/удалить. Тап-и-клик на медиа внутри пузыря при этом
  // должен молчать один раз, иначе после долгого нажатия ещё и лайтбокс
  // откроется.
  const LONG_PRESS_MS = 450;
  // Палец почти всегда чуть ползёт даже при "неподвижном" удержании, так что
  // порог, а не любое движение. Сдвинулся дальше — это скролл ленты, а не
  // удержание: меню в таком случае открываться не должно.
  const LONG_PRESS_SLOP_PX = 10;

  // hold — пузырь остаётся приподнятым, пока над ним висит меню. Иначе просто
  // подпрыгивает и возвращается: это единственный отклик на нажатие, который
  // реально виден (navigator.vibrate из PWA на iOS не работает вовсе).
  const popBubble = (seq: number, hold = false) => {
    if (popTimerRef.current) clearTimeout(popTimerRef.current);
    setPoppedSeq(seq);
    if (!hold) {
      popTimerRef.current = setTimeout(() => setPoppedSeq(null), BUBBLE_POP_MS);
    }
  };

  useEffect(() => () => {
    if (popTimerRef.current) clearTimeout(popTimerRef.current);
  }, []);

  const closeActionMenu = () => {
    setActionTarget(null);
    setMenuPos(null);
    setAnchorRect(null);
    setPoppedSeq(null);
  };

  // Позиция меню — вплотную к самому сообщению, а не нижним листом: под
  // пузырём и прижато к тому же его краю, у своих справа, у чужих слева.
  // Этим же замером ставится копия пузыря поверх блюра, поэтому меряем именно
  // .chat-bubble, а не внешнюю обёртку (у чужих сообщений она растянута на всю
  // ширину ленты, её края к пузырю отношения не имеют).
  useLayoutEffect(() => {
    if (!actionTarget) {
      setMenuPos(null);
      setAnchorRect(null);
      return;
    }
    const menu = actionMenuRef.current;
    const anchor = messagesContentRef.current?.querySelector(`[data-seq="${actionTarget.seq}"] .chat-bubble`);
    if (!menu || !anchor) return;

    const box = anchor.getBoundingClientRect();
    setAnchorRect({ left: box.left, top: box.top, width: box.width });
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const GAP = 8;
    const MARGIN = 8;

    let top = box.bottom + GAP;
    // Под сообщением не помещается (последнее в ленте, над полем ввода) —
    // показываем над ним.
    if (top + height > window.innerHeight - MARGIN) {
      top = Math.max(MARGIN, box.top - GAP - height);
    }
    const preferredLeft = actionTarget.user_id === userId ? box.right - width : box.left;
    const maxLeft = Math.max(MARGIN, window.innerWidth - width - MARGIN);
    setMenuPos({ left: Math.min(Math.max(MARGIN, preferredLeft), maxLeft), top });
  }, [actionTarget, userId]);

  const startLongPress = (message: ChatMessage, e: React.PointerEvent) => {
    longPressFiredRef.current = false;
    longPressOriginRef.current = { x: e.clientX, y: e.clientY };
    longPressTimerRef.current = setTimeout(() => {
      longPressFiredRef.current = true;
      navigator.vibrate?.(10);
      // Оригинал не трогаем: подпрыгнет его копия поверх блюра, а масштаб на
      // оригинале только сбил бы замер его же геометрии под эту копию.
      setActionTarget(message);
    }, LONG_PRESS_MS);
  };

  const cancelLongPress = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const cancelLongPressIfMoved = (e: React.PointerEvent) => {
    const origin = longPressOriginRef.current;
    if (!origin || !longPressTimerRef.current) return;
    if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) > LONG_PRESS_SLOP_PX) {
      cancelLongPress();
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

  // Скачивание медиа из лайтбокса — тот же паттерн (стрим чанков с прогрессом),
  // что и на странице "Видео" (см. handleDownload в VideoPage.tsx).
  const handleDownloadMedia = async () => {
    if (!lightbox || downloadingMedia) return;

    setDownloadingMedia(true);
    setDownloadProgress(-1);

    try {
      const response = await fetch(lightbox.src, { credentials: 'include' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!response.body) throw new Error('No response body');

      const contentLength = response.headers.get('Content-Length');
      const total = contentLength ? parseInt(contentLength) : 0;

      const reader = response.body.getReader();
      const chunks: BlobPart[] = [];
      let received = 0;
      setDownloadProgress(0);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (total) setDownloadProgress(Math.round((received / total) * 100));
      }

      const blob = new Blob(chunks);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = lightbox.mediaKey?.split('/').pop() || `chat_media_${Date.now()}`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to download chat media:', error);
      alert('Не удалось скачать файл');
    } finally {
      setDownloadingMedia(false);
      setDownloadProgress(0);
    }
  };

  const IMAGE_MIN_SCALE = 1;
  const IMAGE_MAX_SCALE = 4;
  // Если зум почти вернулся к исходному размеру — досрочно защёлкиваем ровно
  // на 1 и сбрасываем панорамирование. Без этого порога щипок/колесо могли
  // оставить фото в промежуточном состоянии вроде 1.04x, где imgScale > 1
  // формально верно, drag остаётся в режиме панорамирования (см. проп drag
  // на <motion.img>) — и свайп вниз для закрытия лайтбокса перестаёт работать,
  // хотя визуально зум уже незаметен.
  const ZOOM_SNAP_BACK = 1.08;
  const clampImageScale = (s: number) => Math.min(IMAGE_MAX_SCALE, Math.max(IMAGE_MIN_SCALE, s));

  const resetImageZoom = () => {
    setImgScale(1);
    imgX.set(0);
    imgY.set(0);
  };

  // Единая точка применения нового масштаба — что бы его ни двигало (колесо,
  // щипок), логика "снапа" и сброса панорамирования одна и та же.
  const applyImageScale = (next: number) => {
    const clamped = clampImageScale(next);
    if (clamped <= ZOOM_SNAP_BACK) {
      resetImageZoom();
    } else {
      setImgScale(clamped);
    }
  };

  const toggleImageZoom = () => {
    if (imgScale > 1) resetImageZoom();
    else setImgScale(2.5);
  };

  const handleImageDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    toggleImageZoom();
  };

  // Колесо/трекпад — зум фото в лайтбоксе. На Mac пинч по трекпаду браузер
  // тоже репортит как wheel-событие (с ctrlKey), так что отдельно его ловить
  // не нужно — обрабатывается тем же путём.
  const handleImageWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    applyImageScale(imgScale - e.deltaY * 0.0015);
  };

  const getTouchDistance = (touches: React.TouchList) =>
    Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);

  const handleImageTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      pinchStartRef.current = { dist: getTouchDistance(e.touches), scale: imgScale };
      return;
    }
    if (e.touches.length === 1) {
      const now = Date.now();
      if (now - lastTapRef.current < 300) toggleImageZoom();
      lastTapRef.current = now;
    }
  };

  const handleImageTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && pinchStartRef.current) {
      const dist = getTouchDistance(e.touches);
      applyImageScale(pinchStartRef.current.scale * (dist / pinchStartRef.current.dist));
    }
  };

  const handleImageTouchEnd = (e: React.TouchEvent) => {
    if (e.touches.length < 2) {
      pinchStartRef.current = null;
      if (imgScale <= ZOOM_SNAP_BACK) resetImageZoom();
    }
  };

  // Своё и не старше часа. Ровно то же условие проверяет сервер — тут оно
  // только чтобы не показывать заведомо мёртвый пункт меню.
  const canDelete = (message: ChatMessage): boolean =>
    message.user_id === userId && Date.now() - new Date(message.ts).getTime() < DELETE_WINDOW_MS;

  // Медиа не правим: подписей у них тут нет, а поменять сам файл — это уже
  // новое сообщение. Условие дублирует серверное, чтобы не показывать
  // заведомо мёртвый пункт меню.
  const canEdit = (message: ChatMessage): boolean =>
    message.user_id === userId
    && message.type === 'text'
    && Date.now() - new Date(message.ts).getTime() < EDIT_WINDOW_MS;

  const focusComposerAtEnd = () => {
    const el = textInputRef.current;
    if (!el) return;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  };

  const startReply = (message: ChatMessage) => {
    closeActionMenu();
    setEditTarget(null);
    setReplyTarget(message);
    focusComposerAtEnd();
  };

  const startEdit = (message: ChatMessage) => {
    closeActionMenu();
    setReplyTarget(null);
    setEditTarget(message);
    setInputText(message.text);
    if (textInputRef.current) textInputRef.current.textContent = message.text;
    focusComposerAtEnd();
  };

  // Отмена ответа поле не трогает (там мог быть уже набранный текст), а отмена
  // правки — чистит: иначе в поле осталась бы чужая по смыслу старая редакция.
  const cancelComposerContext = () => {
    setReplyTarget(null);
    if (!editTarget) return;
    setEditTarget(null);
    setInputText('');
    if (textInputRef.current) textInputRef.current.textContent = '';
  };

  const copyMessageText = async (message: ChatMessage) => {
    closeActionMenu();
    try {
      await navigator.clipboard.writeText(message.text);
      navigator.vibrate?.(10);
    } catch {
      // clipboard недоступен (не-https, старый WebKit) — молча не притворяемся,
      // что скопировали, иначе юзер вставит не то и не поймёт почему.
      setSendError('Не удалось скопировать — буфер обмена недоступен');
    }
  };

  const confirmDelete = async (message: ChatMessage) => {
    closeActionMenu();
    if (!window.confirm('Удалить сообщение у всех? Это необратимо.')) return;
    try {
      await deleteMessage(message.seq);
    } catch (e) {
      setSendError(errorMessage(e));
    }
  };

  // Прыжок к сообщению — из баннера закреплённого и из цитаты в ответе. Его
  // может не быть в загруженной истории (или его удалили) — тогда просто
  // ничего не делаем: цитата самодостаточна, текст в ней сохранён снимком.
  // Подпрыгивание в конце — чтобы глаз нашёл, к чему именно приехали.
  const scrollToMessage = (seq: number) => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-seq="${seq}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    popBubble(seq);
  };

  // Содержимое пузыря отдельно от самого пузыря: этим же кодом рисуется его
  // копия поверх блюра при открытом меню (см. .chat-bubble-clone), чтобы
  // оригинал и копия не разъезжались при любой правке разметки.
  const renderBubbleContent = (message: ChatMessage, isMine: boolean, isMediaBubble: boolean, readers: ChatReadState[]) => (
    <>
      {!isMine && <div className="chat-bubble-author">{message.username}</div>}
      {message.reply_to !== null && (
        <div
          className="chat-reply-quote"
          role="button"
          onClick={(e) => {
            // Иначе клик всплывёт на сам пузырь и его подпрыгивание
            // перебьёт подсветку сообщения, к которому мы прыгнули.
            e.stopPropagation();
            if (!suppressClickIfLongPress(e)) scrollToMessage(message.reply_to!);
          }}
        >
          <span className="chat-reply-quote-author">{message.reply_to_username}</span>
          <span className="chat-reply-quote-text">{message.reply_to_preview}</span>
        </div>
      )}
      {message.text && (
        <div className="chat-bubble-text">
          {message.text}
          {/* Время текста — не своей строкой снизу, а "утоплено" в правый
              нижний угол последней строки (как в WhatsApp/Telegram): это
              последний узел внутри текста, float:right встаёт в конец
              последней строки, если там есть место, иначе уходит под неё
              вплотную к правому краю. У медиа-подписей (isMediaBubble) время
              не дублируем — оно уже на самом кадре (chat-bubble-time--overlay
              ниже). */}
          {!isMediaBubble && (
            <span className="chat-bubble-time chat-bubble-time--inline">
              {message.edited_at && <span className="chat-bubble-edited">изм. </span>}
              {formatTime(message.ts)}
            </span>
          )}
        </div>
      )}
      {message.media_key && (isMediaBubble ? (
        <div className={`chat-media-frame ${message.media_kind === 'circle' ? 'chat-media-frame--circle' : ''}`}>
          {renderMedia(message, isMine)}
          <span className="chat-bubble-time chat-bubble-time--overlay">{formatTime(message.ts)}</span>
        </div>
      ) : renderMedia(message, isMine))}
      {/* Голосовые (и другие немедийные сообщения без текста) — своей
          строкой под контентом, тут утапливать время некуда. */}
      {!isMediaBubble && !message.text && (
        <div className="chat-bubble-time">
          {message.edited_at && <span className="chat-bubble-edited">изм. </span>}
          {formatTime(message.ts)}
        </div>
      )}
      {readers.length > 0 && (
        <div className="chat-read-avatars">
          {readers.map((r) => (
            <span
              key={r.user_id}
              className="chat-read-avatar"
              style={{ background: readAvatarColor(r.user_id) }}
              title={`${r.display_name || 'Прочитано'}${r.read_at ? ` · прочитано в ${formatTime(r.read_at)}` : ''}`}
            >
              {readAvatarLetter(r.display_name)}
            </span>
          ))}
        </div>
      )}
    </>
  );

  const isMediaMessage = (message: ChatMessage): boolean => !!message.media_key
    && (message.type === 'image' || message.type === 'video');

  const renderMedia = (message: ChatMessage, isMine: boolean) => {
    const url = apiClient.getChatMediaSrc(message.media_key);
    if (message.type === 'image') {
      return (
        <img
          src={url}
          alt=""
          className="chat-media-image"
          loading="lazy"
          onClick={(e) => { if (suppressClickIfLongPress(e)) return; setLightbox({ src: url, type: 'image', mediaKey: message.media_key }); }}
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
          onClick={(e) => { if (suppressClickIfLongPress(e)) return; setLightbox({ src: url, type: 'video', seq: message.seq, mediaKey: message.media_key }); }}
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

  // Кто где остановился в чтении. Кружок с буквой вешаем на самое свежее
  // прочитанное юзером сообщение — так метка одна на человека и ползёт по
  // ленте вслед за ним, а не висит списком на последнем сообщении.
  const readMarkers = useMemo(() => {
    const bySeq = new Map<number, ChatReadState[]>();
    if (messages.length === 0) return bySeq;
    for (const r of reads) {
      if (r.user_id === userId || r.last_read_seq <= 0) continue;
      let target: ChatMessage | undefined;
      for (const m of messages) {
        if (m.seq > r.last_read_seq) break;
        // Системные (закрепил/открепил) — не настоящий контент, кружок
        // "прочитано" под служебной плашкой смотрелся бы странно.
        if (m.type === 'system') continue;
        target = m;
      }
      // Прочитанное вымылось из загруженной истории — вешать метку не на что.
      // На собственном сообщении она бессмысленна: автор его и так "прочитал".
      if (!target || target.user_id === r.user_id) continue;
      const existing = bySeq.get(target.seq);
      if (existing) existing.push(r);
      else bySeq.set(target.seq, [r]);
    }
    return bySeq;
  }, [messages, reads, userId]);

  // Сообщения, сгруппированные по дню. Каждая группа рендерится в своём
  // контейнере — это и есть containing block для sticky-плашки даты внутри
  // (см. .chat-day-group в CSS): плашка "прилипает" сверху только пока скролл
  // не прошёл границу СВОЕЙ группы, и корректно отлипает на стыке дней, а не
  // висит до конца ленты. Без этой обёртки при малом числе сообщений в дне
  // соседние плашки на стыке дней видны одновременно (see баг с "28 августа"
  // поверх "Вчера").
  type DayGroup = { day: string; label: string; messages: ChatMessage[] };
  const dayGroups = useMemo(() => {
    const groups: DayGroup[] = [];
    for (const m of messages) {
      const day = dayKey(m.ts);
      const last = groups[groups.length - 1];
      if (last && last.day === day) {
        last.messages.push(m);
      } else {
        groups.push({ day, label: formatDateDivider(m.ts), messages: [m] });
      }
    }
    return groups;
  }, [messages]);

  // Кто прочитал именно это сообщение — для карточки над меню. Себя и автора
  // не показываем: своё прочтение неинтересно, авторское тривиально. Время
  // здесь — момент, когда человек дочитал до этого места, ровно то же, что
  // стоит за кружком в ленте.
  const actionReaders = actionTarget
    ? reads.filter((r) => (
      r.user_id !== actionTarget.user_id
      && r.user_id !== userId
      && r.last_read_seq >= actionTarget.seq
    ))
    : [];

  // Одна строка под заголовком "Чат": печатает > кто в сети. "Был(а) в сети
  // N назад" тут был третьим вариантом и убран намеренно — если сейчас никого
  // нет, строка просто пропадает, а не сообщает, когда кто-то заходил.
  const othersTyping = typingUsers.filter((t) => t.user_id !== userId);
  const onlineOthers = presence.filter((p) => p.user_id !== userId && p.online);
  let headerSubtitle: string | null = null;
  if (othersTyping.length > 0) {
    headerSubtitle = `${othersTyping.map((t) => t.display_name).join(', ')} печатает…`;
  } else if (onlineOthers.length > 0) {
    headerSubtitle = `${onlineOthers.map((p) => p.display_name).join(', ')} в сети`;
  }

  // Реконнект в заголовке показываем только если связь уже была установлена
  // и потом пропала — на самом первом mount'е connectionState тоже стартует
  // как 'connecting', и без этой проверки "Чат" на долю секунды дёргался бы
  // в "Подключение…" при любом обычном открытии страницы.
  const showReconnectTitle = connectionState !== 'connected' && hasConnectedOnceRef.current;

  return (
    <div className={`chat-page ${theme} ${inputFocused ? 'chat-page--composing' : ''} ${actionTarget ? 'chat-page--menu-open' : ''} ${pageEntered ? 'chat-page--entered' : ''}`}>
      <div className="chat-header" ref={headerRef}>
        <div className="chat-header-card">
          <div className="chat-title">
            <div className="chat-title-row">
              <MessageCircle size={24} className="title-icon" />
              <h1>{showReconnectTitle ? (connectionState === 'connecting' ? 'Подключение…' : 'Переподключение…') : 'Чат'}</h1>
            </div>
            {!showReconnectTitle && headerSubtitle ? (
              <span className={`chat-connection-hint ${othersTyping.length > 0 ? 'chat-connection-hint--typing' : ''}`}>
                {headerSubtitle}
              </span>
            ) : null}
          </div>

          <div className="header-actions">
            <button className="header-action-btn" onClick={() => navigate('/chat/settings')} title="Настройки">
              <Settings size={20} />
            </button>
            <button
              className="header-action-btn"
              onClick={toggleTheme}
              title={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
            >
              {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
            </button>
          </div>
        </div>

        {/* Пин и баннер уведомлений живут внутри фиксированной шапки, а не в
            потоке страницы: в потоке они отодвигали ленту вниз, и за ними —
            как и за самой шапкой — оставалась глухая полоса фона. Теперь это
            плавающие таблетки поверх ленты, а лента идёт под ними. */}
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
      </div>

      <div
        className="chat-messages"
        ref={listRef}
        onScroll={handleScroll}
        onTouchStart={handleMessagesTouchStart}
        onTouchMove={dismissKeyboardOnUserScroll}
        onTouchEnd={handleMessagesTouchEnd}
        onTouchCancel={handleMessagesTouchEnd}
        onWheel={dismissKeyboardOnUserScroll}
        // paddingTop, а не padding-top у страницы: лента занимает экран целиком
        // и проходит под шапкой, поэтому сообщения видно прямо за таблетками.
        // Отступ нужен только чтобы самое первое сообщение истории не залипало
        // под шапкой, когда лента домотана до самого верха.
        style={{ paddingTop: headerPadTop + 8, paddingBottom: messagesPadBottom }}
      >
        {loadingHistory && messages.length === 0 && (
          <div className="chat-loading"><Loader2 size={20} className="spin" /></div>
        )}
        {hasMoreHistory && messages.length > 0 && (
          <div className="chat-load-more-hint">
            {loadingHistory ? 'Загружаем историю…' : 'Прокрутите вверх для истории'}
          </div>
        )}

        <div
          className={`chat-messages-content ${pageEntered && historyReady ? 'chat-messages-content--ready' : ''}`}
          ref={messagesContentRef}
        >
        {dayGroups.map((group) => (
          <div className="chat-day-group" key={`day-${group.day}`}>
            <div className="chat-date-divider">
              <span>{group.label}</span>
            </div>
            <AnimatePresence initial={false}>
              {group.messages.map((message) => {
                if (message.type === 'system') {
                  const isPinned = message.system_kind !== 'unpinned';
                  return (
                    <div
                      className="chat-system-message"
                      key={`msg-${message.seq}`}
                      data-seq={message.seq}
                      role={message.reply_to !== null ? 'button' : undefined}
                      onClick={() => { if (message.reply_to !== null) scrollToMessage(message.reply_to); }}
                    >
                      {isPinned ? <Pin size={13} /> : <PinOff size={13} />}
                      <span>
                        <b>{message.username}</b> {isPinned ? 'закрепил(а)' : 'открепил(а)'} сообщение
                        {message.reply_to_preview && <>: «{message.reply_to_preview}»</>}
                      </span>
                    </div>
                  );
                }

                const isMine = message.user_id === userId;
                const readers = readMarkers.get(message.seq) ?? [];
                // Фото/видео — как в Telegram: пузыря вокруг медиа почти нет,
                // а время лежит пилюлей на самом кадре. Подпись, если есть,
                // ложится сверху кадра тем же тесным пузырём. У голосовых
                // остаётся обычная раскладка со временем снизу.
                const isMediaBubble = isMediaMessage(message);

                return (
                  <motion.div
                    key={`msg-${message.seq}`}
                    data-seq={message.seq}
                    className={`chat-bubble-outer ${isMine ? 'mine' : ''} ${readers.length > 0 ? 'chat-bubble-outer--has-readers' : ''}`}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.92 }}
                  >
                    <div className="chat-bubble-col">
                      <motion.div
                        className={`chat-bubble ${isMediaBubble ? 'chat-bubble--media' : ''}`}
                        animate={{ scale: poppedSeq === message.seq ? BUBBLE_POP_SCALE : 1 }}
                        transition={{ type: 'spring', stiffness: 520, damping: 17 }}
                        onPointerDown={(e) => startLongPress(message, e)}
                        onPointerMove={cancelLongPressIfMoved}
                        onPointerUp={cancelLongPress}
                        onPointerCancel={cancelLongPress}
                        onClick={(e) => { if (!isMediaBubble && !suppressClickIfLongPress(e)) popBubble(message.seq); }}
                        onContextMenu={(e) => { e.preventDefault(); setActionTarget(message); }}
                      >
                        {renderBubbleContent(message, isMine, isMediaBubble, readers)}
                      </motion.div>
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        ))}

        <AnimatePresence initial={false}>
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

      <AnimatePresence>
        {showScrollDown && (
          <motion.button
            className="chat-scroll-bottom-btn"
            style={{ bottom: scrollBtnBottom, width: scrollBtnSize, height: scrollBtnSize }}
            initial={{ x: 48, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 48, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            onClick={scrollToBottom}
            title="К последним сообщениям"
          >
            <ChevronDown size={Math.round(scrollBtnSize * 0.5)} />
          </motion.button>
        )}
      </AnimatePresence>

      <div className="chat-input-bar" ref={inputBarRef}>
        {sendError && (
          <div className="chat-send-error">
            <span>{sendError}</span>
            <button onClick={() => setSendError(null)} title="Закрыть">
              <X size={14} />
            </button>
          </div>
        )}

        {/* На что отвечаем / что правим — полоской прямо над полем ввода, как
            в Telegram. Оба состояния взаимоисключающие, поле ввода одно. */}
        {(editTarget || replyTarget) && (
          <div className="chat-composer-context">
            {editTarget ? <Pencil size={16} /> : <CornerUpLeft size={16} />}
            <div className="chat-composer-context-body">
              <span className="chat-composer-context-title">
                {editTarget ? 'Редактирование' : `Ответ · ${replyTarget!.username}`}
              </span>
              <span className="chat-composer-context-text">
                {previewForMessage(editTarget ?? replyTarget!)}
              </span>
            </div>
            <button onClick={cancelComposerContext} title="Отменить">
              <X size={16} />
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

              <div
                ref={textInputRef}
                className={`chat-text-input ${inputText.trim() ? '' : 'chat-text-input--empty'}`}
                contentEditable
                suppressContentEditableWarning
                role="textbox"
                aria-multiline="true"
                aria-label="Сообщение"
                data-placeholder="Сообщение…"
                onInput={syncComposerState}
                onFocus={() => setInputFocused(true)}
                onBlur={() => setInputFocused(false)}
                onKeyDown={handleComposerKeyDown}
                onPaste={handleComposerPaste}
                enterKeyHint="send"
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
              {sending
                ? <Loader2 size={18} className="spin" />
                : editTarget ? <Check size={18} /> : <Send size={18} />}
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
              className="chat-lightbox-download"
              onClick={(e) => { e.stopPropagation(); handleDownloadMedia(); }}
              disabled={downloadingMedia}
              title="Скачать"
            >
              {downloadingMedia ? <Loader2 size={20} className="spin" /> : <Download size={20} />}
            </button>
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
                className={`chat-lightbox-image ${imgScale > 1 ? 'chat-lightbox-image--zoomed' : ''}`}
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={handleImageDoubleClick}
                onWheel={handleImageWheel}
                onTouchStart={handleImageTouchStart}
                onTouchMove={handleImageTouchMove}
                onTouchEnd={handleImageTouchEnd}
                style={{ x: imgX, y: imgY, scale: imgScale }}
                drag={imgScale > 1 ? true : 'y'}
                dragConstraints={imgScale > 1
                  ? {
                    left: -160 * (imgScale - 1), right: 160 * (imgScale - 1),
                    top: -160 * (imgScale - 1), bottom: 160 * (imgScale - 1),
                  }
                  : { top: 0, bottom: 0 }}
                dragElastic={imgScale > 1 ? 0.15 : 0.8}
                onDragEnd={(_, info) => {
                  // При зуме drag только панорамирует фото, закрытие свайпом
                  // вниз работает только пока оно в исходном размере.
                  if (imgScale > 1) return;
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
        {downloadingMedia && (
          <motion.div
            className="chat-download-toast"
            initial={{ y: 100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 100, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
          >
            <Download size={18} className="chat-download-toast-icon" />
            <div className="chat-download-toast-body">
              <p className="chat-download-toast-label">
                {downloadProgress < 0
                  ? 'Подготовка скачивания...'
                  : downloadProgress < 100
                    ? `Скачивание ${downloadProgress}%`
                    : 'Завершение...'}
              </p>
              <div className="chat-download-toast-track">
                <motion.div
                  className="chat-download-toast-fill"
                  animate={{ width: downloadProgress < 0 ? '35%' : `${downloadProgress}%` }}
                  transition={downloadProgress < 0
                    ? { repeat: Infinity, repeatType: 'reverse', duration: 1, ease: 'easeInOut' }
                    : { duration: 0.15 }
                  }
                />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Меню действий — не нижним листом, а вплотную к самому сообщению, как в
          Telegram. Бэкдроп размывает всё остальное, а сообщение остаётся
          резким — своей копией поверх блюра (см. .chat-bubble-clone ниже): оно
          и есть контекст меню. Все трое — соседи, а не потомки бэкдропа: иначе
          они оказались бы внутри его stacking context, и порядок копия/меню
          пришлось бы разруливать уже там. */}
      <AnimatePresence>
        {actionTarget && (
          <>
            <motion.div
              key="action-backdrop"
              className="chat-action-backdrop"
              // Появляется сразу, без проявления: пока он ехал по прозрачности,
              // он каждый кадр пересчитывал размытие всего экрана, а стекло
              // меню поверх — пересэмплировало этот меняющийся результат,
              // отчего и дёргалось. Гаснет уже плавно: на уходе меню со своим
              // стеклом над ним уже нет.
              initial={{ opacity: 1 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
              onClick={closeActionMenu}
            />

            {/* Копия сообщения поверх размытого фона. Поднять оригинал по
                z-index не выходит: он лежит внутри .chat-messages — скролл-
                контейнера с -webkit-overflow-scrolling, а такой контейнер на
                iOS уводит потомков в собственный слой, из которого наружу, над
                бэкдропом, уже не всплыть. Поэтому оригинал остаётся размытым
                внизу, а сверху ровно по его координатам рисуется непрозрачный
                двойник — он его полностью перекрывает. */}
            {anchorRect && (
              <motion.div
                key="action-clone"
                className={`chat-bubble-clone ${actionTarget.user_id === userId ? 'mine' : ''}`}
                style={{ left: anchorRect.left, top: anchorRect.top, width: anchorRect.width }}
                initial={{ scale: 1 }}
                animate={{ scale: BUBBLE_HOLD_SCALE }}
                exit={{ scale: 1 }}
                transition={{ type: 'spring', stiffness: 520, damping: 17 }}
              >
                <div className={`chat-bubble ${isMediaMessage(actionTarget) ? 'chat-bubble--media' : ''}`}>
                  {renderBubbleContent(
                    actionTarget,
                    actionTarget.user_id === userId,
                    isMediaMessage(actionTarget),
                    readMarkers.get(actionTarget.seq) ?? [],
                  )}
                </div>
              </motion.div>
            )}

            <motion.div
              key="action-menu"
              ref={actionMenuRef}
              className="chat-action-stack"
              style={{
                left: menuPos?.left ?? 0,
                top: menuPos?.top ?? 0,
                // До первого замера позиция неизвестна — не показываем меню
                // в углу экрана на один кадр.
                visibility: menuPos ? 'visible' : 'hidden',
              }}
              // Только прозрачность, без scale: у карточек своё стекло, а оно
              // при каждом изменении геометрии пересчитывает размытие заново —
              // именно связка "стекло + пружинящий scale" и давала рябь.
              // Пружинит вместо них копия сообщения, у неё стекла нет.
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="chat-action-readers">
                <span className="chat-action-readers-title">Прочитали</span>
                {actionReaders.length === 0 ? (
                  <span className="chat-action-readers-empty">Пока никто</span>
                ) : actionReaders.map((r) => (
                  <div key={r.user_id} className="chat-action-reader">
                    <span className="chat-read-avatar" style={{ background: readAvatarColor(r.user_id) }}>
                      {readAvatarLetter(r.display_name)}
                    </span>
                    <span className="chat-action-reader-name">{r.display_name}</span>
                    <span className="chat-action-reader-time">{r.read_at ? formatTime(r.read_at) : ''}</span>
                  </div>
                ))}
              </div>

              <div className="chat-action-menu">
                <button onClick={() => startReply(actionTarget)}>
                  <CornerUpLeft size={20} />
                  Ответить
                </button>

                {actionTarget.text && (
                  <button onClick={() => copyMessageText(actionTarget)}>
                    <Copy size={20} />
                    Копировать
                  </button>
                )}

                {canEdit(actionTarget) && (
                  <button onClick={() => startEdit(actionTarget)}>
                    <Pencil size={20} />
                    Изменить
                  </button>
                )}

                <button
                  onClick={async () => {
                    const target = actionTarget;
                    closeActionMenu();
                    if (pinnedMessage?.seq === target.seq) {
                      await unpinMessage();
                    } else {
                      await pinMessage(target.seq);
                    }
                  }}
                >
                  {pinnedMessage?.seq === actionTarget.seq ? <PinOff size={20} /> : <Pin size={20} />}
                  {pinnedMessage?.seq === actionTarget.seq ? 'Открепить' : 'Закрепить'}
                </button>

                {canDelete(actionTarget) && (
                  <button className="danger" onClick={() => confirmDelete(actionTarget)}>
                    <Trash2 size={20} />
                    Удалить
                  </button>
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
};
