import React, { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react';
import { motion, AnimatePresence, useMotionValue } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { Send, Mic, Trash2, Loader2, Bell, BellOff, Paperclip, X, Play, Video, VideoOff, Pin, PinOff, Copy, ChevronDown, ChevronLeft, Sun, Moon, Settings, MessageCircle, CornerUpLeft, Pencil, Check, Download } from 'lucide-react';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { useChat, previewForMessage } from '../../context/ChatContext';
import { apiClient } from '../../api/client';
import type { ChatMessage, ChatReadState } from '../../api/client';
import { useHideNavBar } from '../../context/NavBarContext';
import { useChatPush } from '../../hooks/useChatPush';
import { usePageVisit } from '../../hooks/usePageVisit';
import { useOnTabReselect } from '../../context/NavBarContext';
import { VoiceMessage } from './VoiceMessage';
import { useChatListAnchor } from './useChatListAnchor';
import type { TopAnchor } from './useChatListAnchor';
import './ChatPage.css';

const MAX_CHAT_FILE_BYTES = 50 * 1024 * 1024; // синхронно с CHAT_MEDIA_MAX_BYTES на бэке
const MAX_RECORD_MS = 60_000;
const MIN_RECORD_MS = 2_000; // короче — считаем случайным тапом, не отправляем
const HOLD_THRESHOLD_MS = 400; // дольше этого — считаем "держит", отпустил — отправить сразу
// Живая волна записи, как в Telegram: лента столбиков, бегущая справа налево.
const WAVE_BAR_COUNT = 28;
// Шаг ленты. Кадр (~16 мс) дал бы не речь, а шум: слог просто не успевает
// проявиться. 90 мс — примерно длительность слога, лента читается как речь.
const WAVE_STEP_MS = 90;
// Насколько нужно увести палец влево от кнопки, чтобы запись отменилась.
const CANCEL_SWIPE_PX = 90;
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

// Сколько длится схлопывание удалённого сообщения (height/margin → 0, см.
// exitingMessages ниже). Одно число на саму анимацию и на страховочный
// таймер, который дожинает строку, если анимация почему-то не доиграла —
// расходиться этим двум значениям нельзя.
const EXIT_COLLAPSE_MS = 220;

// Цвет кружка "прочитано" — по user_id, а не по позиции в списке: так буква
// у человека всегда одного цвета, независимо от порядка ответа сервера.
const READ_AVATAR_COLORS = ['#3b82f6', '#10b981', '#a855f7', '#f97316', '#ec4899', '#06b6d4'];
const readAvatarColor = (userId: number) => READ_AVATAR_COLORS[Math.abs(userId) % READ_AVATAR_COLORS.length];
const readAvatarLetter = (displayName: string) => displayName.trim().charAt(0).toUpperCase() || '?';

const formatTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

// Дата+время прочтения для карточки в меню сообщения — просто время для
// сегодняшних отметок, иначе ещё и дата, чтобы не гадать, вчера это было
// или неделю назад.
const formatReadDateTime = (iso: string): string => {
  const date = new Date(iso);
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  const time = formatTime(iso);
  if (diffDays === 0) return time;
  if (diffDays === 1) return `вчера, ${time}`;
  const sameYear = date.getFullYear() === now.getFullYear();
  const datePart = date.toLocaleDateString('ru-RU', sameYear
    ? { day: 'numeric', month: 'short' }
    : { day: 'numeric', month: 'short', year: 'numeric' });
  return `${datePart}, ${time}`;
};

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

// В ленте кадр занимает 260px по ширине — превью в 400px хватает и на
// 2x-экран, а весит десятки килобайт против пары мегабайт оригинала.
const FEED_THUMB_MAX_DIM = 400;
// Крошка-заглушка едет в самом сообщении (по WS и в каждой странице истории),
// поэтому она именно крошка: 16px JPEG — меньше килобайта base64, растянутый
// на всю рамку размытым пятном. Не влезли в потолок — отправляем без неё.
const BLUR_PREVIEW_DIM = 16;
const BLUR_PREVIEW_MAX_CHARS = 2048;

// Границы, в которые зажимаются пропорции кадра в ленте (см. mediaAspect).
const MEDIA_MIN_ASPECT = 0.7;  // вертикальные: не уже 7:10
const MEDIA_MAX_ASPECT = 1.9;  // горизонтальные: не шире ~17:9

/** Что клиент готовит из выбранного фото: сам кадр, превью для ленты, размеры
    и крошка-заглушка. Всё здесь, а не на сервере — он медиа не транскодирует
    (см. обсуждение с пользователем), а картинку клиент всё равно уже держит
    декодированной, так что три кодирования вместо одного ничего не стоят. */
interface PreparedImage {
  full: Blob;
  thumb: Blob | null;
  width: number;
  height: number;
  preview: string;
}

/** Ужимает источник в бокс maxDim с сохранением пропорций. null — если 2d-контекст
    недоступен (приватные режимы некоторых браузеров). */
function drawScaled(source: ImageBitmap | HTMLCanvasElement, maxDim: number): HTMLCanvasElement | null {
  const scale = Math.min(1, maxDim / Math.max(source.width, source.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

const canvasToBlob = (canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> =>
  new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));

async function prepareImage(file: File, maxDim = 1600): Promise<PreparedImage> {
  // Не получилось декодировать (HEIC без поддержки, битый файл) — шлём как
  // есть и без превью: сервер и лента переживут, рамка просто останется
  // прежнего фиксированного размера.
  const asIs: PreparedImage = { full: file, thumb: null, width: 0, height: 0, preview: '' };
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
    const fullCanvas = drawScaled(bitmap, maxDim);
    if (!fullCanvas) return asIs;
    const full = (await canvasToBlob(fullCanvas, 0.85)) ?? file;

    // Снимок и так меньше превью (скриншот иконки, стикер) — второй файл был бы
    // копией первого: в ленту тогда поедет сам кадр, он уже лёгкий.
    const needsThumb = Math.max(fullCanvas.width, fullCanvas.height) > FEED_THUMB_MAX_DIM;
    const thumbCanvas = needsThumb ? drawScaled(fullCanvas, FEED_THUMB_MAX_DIM) : fullCanvas;
    const thumb = needsThumb && thumbCanvas ? await canvasToBlob(thumbCanvas, 0.8) : null;

    // Крошку рисуем из превью, а не из оригинала: canvas ужимает в один проход,
    // и прыжок 1600→16 дал бы кашу из случайно попавших пикселей вместо
    // усреднённых цветов кадра.
    const blurCanvas = thumbCanvas ? drawScaled(thumbCanvas, BLUR_PREVIEW_DIM) : null;
    const preview = blurCanvas ? blurCanvas.toDataURL('image/jpeg', 0.4) : '';

    return {
      full,
      thumb,
      width: fullCanvas.width,
      height: fullCanvas.height,
      preview: preview.length <= BLUR_PREVIEW_MAX_CHARS ? preview : '',
    };
  } catch {
    return asIs;
  } finally {
    bitmap?.close();
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
  // thumbSrc — превью из ленты: оно уже в кэше браузера и стоит в лайтбоксе
  // вместо оригинала, пока тот едет из S3 (см. fullImageReady ниже).
  const [lightbox, setLightbox] = useState<{ src: string; type: 'image' | 'video'; seq?: number; mediaKey?: string; thumbSrc?: string } | null>(null);
  const [fullImageReady, setFullImageReady] = useState(false);
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
  // Момент окончания последнего щипка (в т.ч. быстрого анзума) — пока недавний,
  // свайп вниз не закрывает лайтбокс, чтобы резкий анзум не путался с жестом
  // закрытия (см. onDragEnd на <motion.img> ниже).
  const pinchEndedAtRef = useRef(0);
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
  const { notifStatus, busy: pushBusy, requestAccess: requestNotificationAccess } = useChatPush();

  // connectionState стартует как 'connecting' при каждом монтировании страницы
  // (см. ChatContext) — без этой отметки заголовок дёргался бы "Подключение…"
  // на любое первое открытие чата, а не только на реальный обрыв уже
  // установленной связи.
  const hasConnectedOnceRef = useRef(false);

  const listRef = useRef<HTMLDivElement>(null);
  const messagesContentRef = useRef<HTMLDivElement>(null);

  // Единственный владелец scrollTop ленты — см. useChatListAnchor. Раньше в
  // него писали четыре разных места, и они гонялись за один пиксель.
  const listAnchor = useChatListAnchor(listRef, messagesContentRef);
  // Разбираем на стабильные ссылки: сам объект хука новый на каждый рендер,
  // и списком зависимостей эффектов он быть не может.
  const {
    settle: settleList,
    isStuckNow,
    scrollToBottom: scrollListToBottom,
    handleScroll: listAnchorScroll,
    captureTopAnchor,
    restoreTopAnchor,
    releaseTopAnchor,
    noteUserGesture,
    handleTouchStart: handleMessagesTouchStart,
    handleTouchEnd: handleMessagesTouchEnd,
  } = listAnchor;
  // Повторный тап по табу "Чат" — как кнопка "вниз": та же санкционированная
  // точка входа в scrollTop ленты, никакой отдельной записи scrollTop тут нет.
  useOnTabReselect(() => scrollListToBottom('smooth'));
  // Кнопка "вниз" — прямое следствие режима залипания, а не отдельный стейт,
  // который надо не забыть погасить в каждой ветке.
  const showScrollDown = !listAnchor.isStuck;

  const headerRef = useRef<HTMLDivElement>(null);
  const inputBarRef = useRef<HTMLDivElement>(null);
  const inputRowRef = useRef<HTMLDivElement>(null);
  const [scrollBtnBottom, setScrollBtnBottom] = useState(90);
  const [scrollBtnSize, setScrollBtnSize] = useState(38);
  const [headerPadTop, setHeaderPadTop] = useState(76);
  const [messagesPadBottom, setMessagesPadBottom] = useState(78);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textInputRef = useRef<HTMLDivElement>(null);
  // Ремаунтим contenteditable-поле после отправки (см. handleSendText) —
  // рост этого ключа форсирует React пересоздать DOM-узел с нуля.
  const [composerKey, setComposerKey] = useState(0);
  const composerRefocusRef = useRef(false);
  const lastSeqRef = useRef<number | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);
  const longPressOriginRef = useRef<{ x: number; y: number } | null>(null);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heldLongEnoughRef = useRef(false);
  const pressWasSecondTapRef = useRef(false);

  const [recordingSeconds, setRecordingSeconds] = useState(0);
  // Палец физически на кнопке (между pointerdown и pointerup) — от этого
  // зависит, что показываем в оверлее: подсказку "проведите для отмены"
  // (свайпать есть чем) или кнопку-мусорку (палец уже отпущен, режим
  // ожидания второго тапа).
  const [micHeld, setMicHeld] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  // Синхронный двойник recording для обработчиков, которые не могут ждать
  // ре-рендер (beforeinput поля ввода, rAF-тик метра).
  const recordingRef = useRef(false);
  const recordedChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const recordStartRef = useRef(0);
  const recordTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Живой уровень сигнала с микрофона (для пульсирующего кольца вокруг
  // кнопки) гонится прямо в CSS-переменную на кнопке через ref, а не в React
  // state — на ~30 кадрах в секунду ре-рендер компонента такого размера
  // обошёлся бы куда дороже прямой записи в style. См. startLevelMeter ниже.
  const micButtonRef = useRef<HTMLButtonElement>(null);
  const meterAudioCtxRef = useRef<AudioContext | null>(null);
  const meterAnalyserRef = useRef<AnalyserNode | null>(null);
  const meterRafRef = useRef<number | null>(null);
  // Волна записи живёт по той же схеме, что и кольцо громкости: значения в
  // ref, высоты столбиков пишутся прямо в DOM. React-state тут означал бы
  // ре-рендер всей страницы чата 11 раз в секунду ради 28 чисел.
  const waveBarsRef = useRef<(HTMLSpanElement | null)[]>([]);
  const waveLevelsRef = useRef<number[]>(new Array(WAVE_BAR_COUNT).fill(0));
  const wavePeakRef = useRef(0);
  const waveLastPushRef = useRef(0);
  // Свайп влево по кнопке = отмена. Прогресс жеста (0..1) уходит в CSS-
  // переменную на строке ввода, а не в state — он идёт под пальцем.
  const swipeStartXRef = useRef(0);
  const swipeCancelledRef = useRef(false);
  // Ставится синхронно в pointerdown по микрофону: пока он поднят, blur
  // поля ввода не считается настоящим уходом из режима "печатают".
  // См. handleMicPointerDown.
  const suppressComposerBlurRef = useRef(false);

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

  // Мутации ленты — три ветки, и каждая заканчивается обращением к одному и
  // тому же владельцу скролла, а не своей собственной записью scrollTop.
  //
  //   добавление  → scrollToBottom(), если сообщение своё или юзер и так внизу
  //   правка      → settle(), высота пузыря могла измениться
  //   удаление    → settle() (см. handleExitCollapseComplete ниже); кадры
  //                 самого схлопывания держит ResizeObserver внутри хука
  //
  // Автоскролл на новое сообщение — только когда оно добавилось в КОНЕЦ (при
  // подгрузке истории вверх последний seq не меняется) и только если юзер и
  // так был внизу или сообщение своё: иначе, читая историю, его выдёргивало бы
  // к каждому новому сообщению. В обратном случае показывается стрелка "вниз"
  // (она следует из режима залипания сама, гасить её вручную больше не надо).
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (!last) return;
    // Первое заполнение ленты при заходе на страницу — прыгаем вниз мгновенно
    // (как Telegram/WhatsApp), а не анимированно: 'smooth' на моментальном же
    // requestAnimationFrame ещё и гонится с коррекцией по ResizeObserver за
    // тот же scrollTop, если картинки/видео в ленте досчитывают размеры чуть
    // позже первого рендера — smooth-анимация может "выиграть" гонку и
    // застрять на промежуточной, ещё не окончательной высоте контента.
    const isInitialLoad = lastSeqRef.current === null;
    // Сравниваем по НАПРАВЛЕНИЮ, а не просто на неравенство. Удаление
    // последнего сообщения тоже меняет last.seq — но на меньший, и по "!=="
    // это неотличимо от прихода нового: лента уезжала в smooth-скролл прямо
    // поверх схлопывания удаляемого пузыря, а окно smooth-скролла на это время
    // глушит удержание низа. Вниз тянемся только когда лента реально выросла
    // с конца.
    const isAppend = isInitialLoad || last.seq > lastSeqRef.current!;
    if (isAppend) {
      lastSeqRef.current = last.seq;
      if (last.user_id === userId || isStuckNow()) {
        scrollListToBottom(isInitialLoad ? 'auto' : 'smooth');
      }
      return;
    }
    // Всё остальное — правка, удаление, откат оптимистичной операции. Высота
    // ленты могла поехать в любую сторону; сверяем инвариант, не трогая
    // scrollTop без нужды. Правка до выделения этого хука не обрабатывалась
    // вообще и держалась только на ResizeObserver.
    lastSeqRef.current = last.seq;
    settleList();
  }, [messages, userId, isStuckNow, scrollListToBottom, settleList]);

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
      // Плюс-8 тут больше нет: с тех пор как зазор ленты переехал с gap
      // контейнера на margin-bottom самих строк (см. ChatPage.css), последнее
      // сообщение несёт свои 10px под собой само — иначе отступ до бара
      // сложился бы дважды.
      setMessagesPadBottom(rect.height);
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

  // Отпускаем камеру/микрофон при уходе со страницы
  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (recordTimeoutRef.current) clearTimeout(recordTimeoutRef.current);
      if (recordingIntervalRef.current) clearInterval(recordingIntervalRef.current);
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
      if (meterRafRef.current) cancelAnimationFrame(meterRafRef.current);
      meterAudioCtxRef.current?.close().catch(() => {});
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

  // В ленту грузится превью, а не оригинал — значит на открытии лайтбокса
  // оригинала в кэше ещё нет и картинке неоткуда взяться мгновенно. Поэтому
  // сначала показываем то же превью (оно точно загружено), а оригинал тянем
  // фоном и подменяем им src, когда он готов: тот же кадр просто становится
  // резким. Подменяем на месте, одним узлом, а не вторым элементом поверх —
  // иначе зум и свайп-закрытие пришлось бы дублировать.
  useEffect(() => {
    setFullImageReady(false);
    if (!lightbox || lightbox.type !== 'image' || !lightbox.thumbSrc) return;
    const loader = new Image();
    loader.onload = () => setFullImageReady(true);
    loader.src = lightbox.src;
    return () => { loader.onload = null; };
  }, [lightbox]);

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
  // Тот же жест открывает "окно жеста" у владельца скролла: только внутри него
  // события scroll имеют право менять режим залипания. Ровно та же логика, что
  // и у блюра ниже, и по той же причине — раскладка сама по себе touchmove не
  // генерирует, а вот scroll генерирует сколько угодно.
  const handleListUserScroll = useCallback(() => {
    noteUserGesture();
    if (document.activeElement === textInputRef.current) {
      textInputRef.current?.blur();
    }
  }, [noteUserGesture]);

  // Режим залипания и запись scrollTop — целиком на useChatListAnchor. Тут
  // остаётся только доменная часть: докрутили до верха — грузим историю.
  const prependAnchorRef = useRef<TopAnchor | null>(null);

  const handleScroll = useCallback(() => {
    listAnchorScroll();

    const el = listRef.current;
    if (!el) return;
    if (!hasMoreHistory) return;
    // Уехали от верха и ничего не грузится — делать нечего.
    if (el.scrollTop > 80 && !loadingHistory) return;
    // Точку привязки переснимаем на каждом событии скролла, пока мы у верха, а
    // не один раз в момент запроса. Пока страница летит по сети, палец
    // продолжает вести ленту (инерция на iOS живёт секундами), и снятый один
    // раз якорь к моменту вставки успел бы устареть — коррекция отмотала бы
    // ленту назад, к позиции на момент запроса.
    prependAnchorRef.current = captureTopAnchor();
    // Повторные вызовы гасит замок внутри loadMoreHistory.
    loadMoreHistory();
  }, [hasMoreHistory, loadingHistory, loadMoreHistory, listAnchorScroll, captureTopAnchor]);

  // Возврат взгляда на место после вставки страницы.
  //
  // Раньше это делал requestAnimationFrame из .then() у loadMoreHistory — и
  // ровно отсюда брался прыжок наверх. Промис резолвится, когда setMessages
  // уже вызван, но React ещё НЕ отрисовал: коммит он планирует отдельной
  // задачей, а rAF успевал выполниться раньше неё. Тогда замер высоты давал
  // ленту в её старом размере, "прирост" выходил нулевым, и коррекция ставила
  // scrollTop в 0 — то есть в самое начало истории. Гонка, отсюда и "почему-то
  // иногда".
  //
  // useLayoutEffect от такой гонки свободен по определению: он выполняется
  // после коммита и до отрисовки — сообщения уже в DOM, но кадр ещё не
  // показан, так что коррекция не успевает мигнуть.
  useLayoutEffect(() => {
    const anchor = prependAnchorRef.current;
    if (anchor) restoreTopAnchor(anchor);
  }, [messages, restoreTopAnchor]);

  // Якорь живёт ровно до конца загрузки. Снимаем его в обычном эффекте, а не в
  // layout-эффекте выше: страница и сброс loadingHistory прилетают одним
  // коммитом, а passive-эффекты идут после layout-эффектов — то есть после
  // того, как якорь отработал. Отдельный эффект нужен и на случай, когда
  // запрос упал или история кончилась и вставлять было нечего.
  useEffect(() => {
    if (loadingHistory) return;
    prependAnchorRef.current = null;
    releaseTopAnchor();
  }, [loadingHistory, releaseTopAnchor]);

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
    let sent = false;
    try {
      if (editTarget) {
        await editMessage(editTarget.seq, text);
        setEditTarget(null);
      } else {
        await sendMessage({ type: 'text', text, replyTo: replyTarget?.seq ?? null });
        setReplyTarget(null);
      }
      setInputText('');
      sent = true;
      setSendError(null);
    } catch (err) {
      console.error('Не удалось отправить сообщение', err);
      setSendError(errorMessage(err));
    } finally {
      setSending(false);
      if (sent) {
        // Просто textContent = '' + .focus() не сбрасывает "сессию
        // автозаглавной буквы" WebKit — после программной очистки поля
        // следующее сообщение стабильно начиналось со строчной. Толкание
        // contentEditable false→true на том же узле тоже не помогло (было
        // опробовано ранее). Реально работает только пересоздание самого
        // DOM-узла — рост composerKey размонтирует старый div и монтирует
        // новый, для WebKit это буквально "поле только что появилось".
        composerRefocusRef.current = true;
        setComposerKey((k) => k + 1);
      } else {
        // Поле не disabled во время отправки специально — но фокус браузер
        // всё равно может увести на кнопку отправки, возвращаем его в поле
        // ввода. Ремаунт тут не нужен и вреден: текст не отправился и
        // должен остаться как есть, а новый пустой узел его бы стёр.
        focusComposerAtEnd();
      }
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
        const prepared = await prepareImage(file);
        await sendMessage({
          type: 'image',
          file: prepared.full,
          fileName: 'photo.jpg',
          thumb: prepared.thumb,
          width: prepared.width,
          height: prepared.height,
          preview: prepared.preview,
          replyTo,
        });
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

  // Кольцо вокруг кнопки и бегущая волна в оверлее питаются с одного
  // analyser'а: настоящий RMS по временной области сигнала (как и амплитудная
  // огибающая в VoiceMessage — см. её комментарий, тот же принцип: не подделка
  // и не спектр), а не декоративная анимация. requestAnimationFrame, а не
  // setInterval — синхронизируется с отрисовкой и сам встаёт на паузу на
  // фоновой вкладке.

  // AudioContext обязан родиться внутри пользовательского жеста и быть явно
  // resume()-нут. Раньше он создавался уже ПОСЛЕ await getUserMedia — жест к
  // тому моменту израсходован (а на первом разе там ещё и системный запрос
  // разрешения), контекст оставался в состоянии suspended, и analyser отдавал
  // ровную тишину: и кольцо, и волна честно показывали ноль всю запись.
  // Поэтому вызывается синхронно из pointerdown, до всяких await.
  const ensureAudioContext = () => {
    if (!meterAudioCtxRef.current) {
      const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      meterAudioCtxRef.current = new AudioContextCtor();
    }
    const ctx = meterAudioCtxRef.current;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  };

  const applyWave = () => {
    const levels = waveLevelsRef.current;
    waveBarsRef.current.forEach((bar, i) => {
      if (bar) bar.style.height = `${Math.round(levels[i] * 100)}%`;
    });
  };

  const resetWave = () => {
    waveLevelsRef.current = new Array(WAVE_BAR_COUNT).fill(0);
    wavePeakRef.current = 0;
    waveLastPushRef.current = 0;
    applyWave();
  };

  const startLevelMeter = (stream: MediaStream) => {
    try {
      const audioCtx = ensureAudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      meterAnalyserRef.current = analyser;

      const data = new Uint8Array(analyser.fftSize);
      const tick = () => {
        const node = meterAnalyserRef.current;
        if (!node) return;
        node.getByteTimeDomainData(data);
        let sumSquares = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sumSquares += v * v;
        }
        const rms = Math.sqrt(sumSquares / data.length);
        // Обычная речь даёт RMS в районе 0.02-0.15 — без усиления кольцо
        // почти не двигалось бы, *5 выводит его в заметный диапазон.
        const level = Math.min(1, rms * 5);
        micButtonRef.current?.style.setProperty('--mic-level', level.toFixed(3));

        // Волна берёт не мгновенный уровень кадра, а пик за окно WAVE_STEP_MS:
        // так столбик — это слог, а не случайная выборка шума.
        if (level > wavePeakRef.current) wavePeakRef.current = level;
        const now = performance.now();
        if (now - waveLastPushRef.current >= WAVE_STEP_MS) {
          waveLastPushRef.current = now;
          waveLevelsRef.current.shift();
          waveLevelsRef.current.push(wavePeakRef.current);
          wavePeakRef.current = 0;
          applyWave();
        }

        meterRafRef.current = requestAnimationFrame(tick);
      };
      meterRafRef.current = requestAnimationFrame(tick);
    } catch (err) {
      // Кольцо и волна — чисто визуальный слой поверх уже идущей записи: если
      // AudioContext недоступен, просто не пульсируем, саму запись это
      // ронять не должно.
      console.error('Не удалось запустить измеритель громкости', err);
    }
  };

  const stopLevelMeter = () => {
    if (meterRafRef.current) {
      cancelAnimationFrame(meterRafRef.current);
      meterRafRef.current = null;
    }
    meterAnalyserRef.current = null;
    if (meterAudioCtxRef.current) {
      meterAudioCtxRef.current.close().catch(() => {});
      meterAudioCtxRef.current = null;
    }
    micButtonRef.current?.style.setProperty('--mic-level', '0');
  };

  // Свайп-отмена и подсказка живут на CSS-переменной строки ввода: её читают
  // и оверлей, и сама кнопка микрофона.
  const setCancelProgress = (value: number) => {
    inputRowRef.current?.style.setProperty('--cancel-progress', value.toFixed(3));
  };

  // Общий хвост для всех выходов из записи. Главное тут — снять "щит" с blur
  // поля ввода и, если фокус всё-таки уехал, привести состояние в соответствие
  // реальности: иначе UI застрял бы в режиме "печатают" (поднятый инпут-бар,
  // спрятанный таб-бар) уже без клавиатуры.
  const releaseComposerFocusGuard = () => {
    suppressComposerBlurRef.current = false;
    if (document.activeElement !== textInputRef.current) setInputFocused(false);
  };

  const startRecording = async () => {
    if (recording || sending) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      recordedChunksRef.current = [];
      resetWave();
      startLevelMeter(stream);

      const mimeType = AUDIO_MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunksRef.current.push(e.data);
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      recordStartRef.current = Date.now();
      recordingRef.current = true;
      setRecording(true);
      setRecordingSeconds(0);
      recordingIntervalRef.current = setInterval(() => {
        setRecordingSeconds((s) => s + 1);
      }, 1000);

      recordTimeoutRef.current = setTimeout(() => stopRecording(), MAX_RECORD_MS);
    } catch (err) {
      console.error('Нет доступа к микрофону', err);
      // Записи не будет — снимаем щит с blur сразу, иначе поле ввода навсегда
      // осталось бы "в фокусе" с точки зрения раскладки.
      stopLevelMeter();
      setMicHeld(false);
      releaseComposerFocusGuard();
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
    stopLevelMeter();

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
    recordingRef.current = false;
    setRecording(false);
    setMicHeld(false);
    setCancelProgress(0);
    releaseComposerFocusGuard();

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
    stopLevelMeter();
    recorder.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    mediaRecorderRef.current = null;
    recordedChunksRef.current = [];
    recordingRef.current = false;
    setRecording(false);
    setRecordingSeconds(0);
    setMicHeld(false);
    setCancelProgress(0);
    releaseComposerFocusGuard();
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
    // Ключевой момент: гасим дефолт pointerdown, чтобы браузер не увёл фокус с
    // поля ввода на эту кнопку. Раньше уводил — и от этого шёл весь букет:
    // клавиатура закрывалась, blur снимал .chat-page--composing (инпут-бар
    // ехал вниз, таб-бар возвращался, лента пересчитывала паддинги — всё
    // одновременно), а :focus-within при этом оставался true, потому что фокус
    // никуда не делся из строки, и вся пилюля залипала белой. setPointerCapture
    // ниже отмену дефолта переживает, жест не ломается.
    e.preventDefault();
    // Подстраховка на случай, если браузер всё же снимет фокус (не все движки
    // одинаково честны с отменой pointerdown): пока идёт запись, blur поля не
    // считаем уходом из режима "печатают", раскладка остаётся как была.
    suppressComposerBlurRef.current = true;
    // AudioContext — синхронно, внутри жеста: см. ensureAudioContext.
    try {
      ensureAudioContext();
    } catch (err) {
      console.error('Не удалось подготовить аудио-контекст', err);
    }

    e.currentTarget.setPointerCapture(e.pointerId);
    swipeStartXRef.current = e.clientX;
    swipeCancelledRef.current = false;
    setCancelProgress(0);
    setMicHeld(true);

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

  // Свайп влево по кнопке — отмена, как в Telegram. Тянуть отдельный слушатель
  // на документ не нужно: pointer capture из pointerdown уже держит все
  // движения на самой кнопке, даже когда палец уехал далеко за её границы.
  const handleMicPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    // micHeld обязателен: pointermove прилетает и от простого наведения мышью,
    // а в режиме "ждём второго тапа" (палец уже отпущен) курсор, проехавший
    // над кнопкой влево, иначе молча отменил бы запись.
    if (!micHeld || !recording || swipeCancelledRef.current) return;
    const dx = Math.min(0, e.clientX - swipeStartXRef.current);
    const progress = Math.min(1, -dx / CANCEL_SWIPE_PX);
    setCancelProgress(progress);
    if (progress >= 1) {
      swipeCancelledRef.current = true;
      cancelRecording();
    }
  };

  const handleMicPointerUp = () => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    setMicHeld(false);
    setCancelProgress(0);
    // Свайп уже отменил запись — отпускание пальца после этого ничего не
    // отправляет.
    if (swipeCancelledRef.current) return;
    // Отправляем, если это было удержание (успело сработать heldLongEnoughRef)
    // ИЛИ это уже второй тап поверх идущей записи. Короткий первый тап —
    // просто остаёмся в режиме ожидания.
    if (pressWasSecondTapRef.current || heldLongEnoughRef.current) {
      stopRecording();
    }
  };

  // pointercancel (система прервала жест — например распознала скролл) —
  // намеренно ничего не отменяем и не отправляем: реальный звук мог уже
  // записаться, юзер сам решит через мусорку или повторный тап. Но палец с
  // кнопки фактически снят, так что в оверлей возвращаем мусорку.
  const handleMicPointerCancel = () => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    setMicHeld(false);
    setCancelProgress(0);
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
  const LONG_PRESS_MS = 300;
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
      if (pinchStartRef.current) pinchEndedAtRef.current = Date.now();
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

  // Фокусируем поле уже после того, как React примонтировал пересозданный
  // (см. composerKey в handleSendText) DOM-узел — до этого момента
  // textInputRef.current всё ещё указывает на старый, удаляемый узел.
  useLayoutEffect(() => {
    if (!composerRefocusRef.current) return;
    composerRefocusRef.current = false;
    textInputRef.current?.focus();
  }, [composerKey]);

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
  const renderBubbleContent = (message: ChatMessage, isMine: boolean, isMediaBubble: boolean, readers: ChatReadState[]) => {
    const timeLabel = (
      <>
        {message.edited_at && <span className="chat-bubble-edited">изм. </span>}
        {formatTime(message.ts)}
      </>
    );

    return (
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
              нижний угол последней строки (как в WhatsApp/Telegram). Рисуем
              его дважды: невидимая распорка остаётся в потоке последней
              строки и держит под время место (а если места нет — переносится
              и добавляет строку), само же время лежит абсолютом в правом
              нижнем углу текста. Флоатом это не делается: пузырь —
              flex-элемент с shrink-to-fit шириной, и флоат учитывался в его
              max-content, т.е. пузырь просто расширялся под время и оно
              всегда садилось справа от текста, а не под ним. У медиа-подписей
              (isMediaBubble) время не дублируем — оно уже на самом кадре
              (chat-bubble-time--overlay ниже). */}
          {!isMediaBubble && (
            <>
              <span className="chat-bubble-time-spacer" aria-hidden="true">{timeLabel}</span>
              <span className="chat-bubble-time chat-bubble-time--inline">{timeLabel}</span>
            </>
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
        <div className="chat-bubble-time">{timeLabel}</div>
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
  };

  const isMediaMessage = (message: ChatMessage): boolean => !!message.media_key
    && (message.type === 'image' || message.type === 'video');

  /** Пропорции рамки под фото. Зажимаем: скриншот телефона (9:19.5) иначе
      растянул бы пузырь на пол-экрана, а панорама выродилась бы в полоску.
      Такие кадры рамка чуть подрезает (object-fit: cover) — как в Telegram;
      целиком их всё равно видно в лайтбоксе. null — размеров нет (сообщение
      отправлено до появления полей либо картинка не декодировалась), тогда
      рамка остаётся фиксированной, как раньше. */
  const mediaAspect = (message: ChatMessage): number | null => {
    if (!message.media_w || !message.media_h) return null;
    const ratio = message.media_w / message.media_h;
    if (!Number.isFinite(ratio) || ratio <= 0) return null;
    return Math.min(MEDIA_MAX_ASPECT, Math.max(MEDIA_MIN_ASPECT, ratio));
  };

  /** Кадр приехал: проявляем его поверх заглушки и гасим переливку рамки.
      Напрямую по узлу, а не через state — загрузка одной картинки не повод
      перерисовывать всю ленту (и тем более все остальные её медиа).
      Крошку под кадром гасим тем же движением: она своё отработала, а держать
      под каждым фото в ленте живой слой с blur-фильтром незачем. */
  const revealMedia = (e: React.SyntheticEvent<HTMLImageElement>) => {
    e.currentTarget.style.opacity = '1';
    const frame = e.currentTarget.parentElement;
    frame?.classList.remove('chat-media-skeleton');
    frame?.querySelector<HTMLElement>('.chat-media-blur')?.style.setProperty('opacity', '0');
  };

  const renderMedia = (message: ChatMessage, isMine: boolean) => {
    const url = apiClient.getChatMediaSrc(message.media_key);
    if (message.type === 'image') {
      // Место под кадр занято ещё до того, как приедет его тело: сообщение
      // прилетает по WS мгновенно, а байты идут из S3 через бэкенд и отстают.
      // Раньше <img> без размеров занимал нулевую высоту и раскрывался в
      // момент загрузки — лента дёргалась под пальцем на каждой догрузившейся
      // картинке.
      //
      // Рамка встаёт в пропорциях самого снимка (media_w/media_h присланы
      // клиентом при отправке), а не фиксированным прямоугольником, который
      // резал каждое вертикальное фото. У сообщений без размеров — прежние
      // 260×200 из CSS.
      //
      // В рамке сразу рисуется крошка-заглушка из самого сообщения; поверх
      // проявляется превью (opacity правим прямо на узле, без state:
      // перерисовывать всю ленту ради одной загрузившейся картинки незачем).
      const feedUrl = message.thumbnail_key ? apiClient.getChatMediaSrc(message.thumbnail_key) : url;
      const aspect = mediaAspect(message);
      return (
        <div
          className={`chat-media-thumb ${message.media_preview ? '' : 'chat-media-skeleton'}`}
          style={aspect ? { aspectRatio: String(aspect), height: 'auto' } : undefined}
          onClick={(e) => {
            if (suppressClickIfLongPress(e)) return;
            // В лайтбокс отдаём и превью: оно уже в кэше браузера и подменяет
            // собой оригинал, пока тот едет из S3. Если превью нет, в ленте и
            // так висел сам оригинал — подменять нечем и незачем.
            setLightbox({
              src: url,
              type: 'image',
              mediaKey: message.media_key,
              thumbSrc: message.thumbnail_key ? feedUrl : undefined,
            });
          }}
        >
          {message.media_preview && (
            <span className="chat-media-blur" style={{ backgroundImage: `url("${message.media_preview}")` }} />
          )}
          <img
            src={feedUrl}
            alt=""
            className="chat-media-image"
            loading="lazy"
            onLoad={revealMedia}
          />
        </div>
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
          className={`chat-video-thumb ${message.media_kind === 'circle' ? 'circle' : ''} ${message.thumbnail_key ? 'chat-media-skeleton' : ''}`}
          onClick={(e) => { if (suppressClickIfLongPress(e)) return; setLightbox({ src: url, type: 'video', seq: message.seq, mediaKey: message.media_key }); }}
        >
          {message.thumbnail_key && (
            <img
              src={apiClient.getChatMediaSrc(message.thumbnail_key)}
              alt=""
              loading="lazy"
              className="chat-video-thumb-el"
              onLoad={revealMedia}
              onError={(e) => { e.currentTarget.style.display = 'none'; e.currentTarget.parentElement?.classList.remove('chat-media-skeleton'); }}
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

  // Удалённое (своё или чужое) сообщение не выкидываем из рендера сразу —
  // тут же теряется вся высота его пузыря разом, лента не успевает ни
  // анимировать исчезновение, ни подтянуть низ, и виснет голый пробел между
  // последним сообщением и полем ввода. Вместо этого держим копию в
  // exitingMessages, пока сам пузырь не доиграет collapse-анимацию (высота
  // → 0, см. renderBubbleContent ниже) — ResizeObserver, который держит
  // ленту у низа (см. выше, тот же механизм, что и под догрузку медиа),
  // все эти кадры честно подтягивает scrollTop следом за уменьшающимся
  // контентом. Диффим прямо в теле рендера (а не в useEffect), чтобы
  // сообщение никогда не пропадало из вывода даже на один кадр — иначе
  // framer-motion увидел бы его пропажу и появление в соседних рендерах
  // как прерванный exit и дёрнул бы пузырь обратно.
  const [exitingMessages, setExitingMessages] = useState<ChatMessage[]>([]);
  const [prevMessagesForDiff, setPrevMessagesForDiff] = useState(messages);
  if (messages !== prevMessagesForDiff) {
    const currentIds = new Set(messages.map((m) => m.seq));
    const removed = prevMessagesForDiff.filter((m) => !currentIds.has(m.seq));
    if (removed.length > 0) {
      setExitingMessages((prev) => {
        const known = new Set(prev.map((m) => m.seq));
        const additions = removed.filter((m) => !known.has(m.seq));
        return additions.length > 0 ? [...prev, ...additions] : prev;
      });
    }
    setPrevMessagesForDiff(messages);
  }
  const exitingSeqs = useMemo(() => new Set(exitingMessages.map((m) => m.seq)), [exitingMessages]);
  // Финальная, уже беззвучная уборка — сам пузырь к этому моменту уже
  // схлопнут до нуля, так что структурное исчезновение из массива не видно.
  const handleExitCollapseComplete = useCallback((seq: number) => {
    setExitingMessages((prev) => (prev.some((m) => m.seq === seq) ? prev.filter((m) => m.seq !== seq) : prev));
    // Структурное исчезновение строки из массива — последнее изменение высоты
    // в этой мутации, и единственное, которое ResizeObserver может застать уже
    // после того, как отработали все кадры схлопывания. Сверяем инвариант.
    requestAnimationFrame(settleList);
  }, [settleList]);
  // Страховка к onAnimationComplete: это единственный выход из
  // exitingMessages, и полагаться на него одного нельзя. Лента в эти 220мс
  // перерисовывается от чего угодно (typing/presence/read-события, WS-эхо
  // самого удаления), и если framer-motion не доведёт схлопывание до конца,
  // строка нулевой высоты останется в ленте навсегда — со своим margin-bottom,
  // накапливая по 10px "непонятной пустоты" на каждое удаление. Таймер жнёт её
  // принудительно; если анимация доиграла штатно, ему уже нечего удалять.
  useEffect(() => {
    if (exitingMessages.length === 0) return;
    const timers = exitingMessages.map((m) => setTimeout(() => {
      handleExitCollapseComplete(m.seq);
    }, EXIT_COLLAPSE_MS + 120));
    return () => timers.forEach(clearTimeout);
  }, [exitingMessages, handleExitCollapseComplete]);
  const displayMessages = useMemo(() => {
    if (exitingMessages.length === 0) return messages;
    const seen = new Set(messages.map((m) => m.seq));
    const merged = [...messages, ...exitingMessages.filter((m) => !seen.has(m.seq))];
    merged.sort((a, b) => a.seq - b.seq);
    return merged;
  }, [messages, exitingMessages]);

  // Сообщения, сгруппированные по дню. Каждая группа рендерится в своём
  // контейнере — это и есть containing block для sticky-плашки даты внутри
  // (см. .chat-day-group в CSS): плашка "прилипает" сверху только пока скролл
  // не прошёл границу СВОЕЙ группы, и корректно отлипает на стыке дней, а не
  // висит до конца ленты. Без этой обёртки при малом числе сообщений в дне
  // соседние плашки на стыке дней видны одновременно (see баг с "28 августа"
  // поверх "Вчера"). Строим из displayMessages, а не messages — иначе группа
  // единственного за день сообщения пропадала бы из вывода в тот же миг, что
  // и само сообщение, оборвав его collapse-анимацию на середине.
  type DayGroup = { day: string; label: string; messages: ChatMessage[] };
  const dayGroups = useMemo(() => {
    const groups: DayGroup[] = [];
    for (const m of displayMessages) {
      const day = dayKey(m.ts);
      const last = groups[groups.length - 1];
      if (last && last.day === day) {
        last.messages.push(m);
      } else {
        groups.push({ day, label: formatDateDivider(m.ts), messages: [m] });
      }
    }
    return groups;
  }, [displayMessages]);

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
        onTouchMove={handleListUserScroll}
        // Перетаскивание скроллбара мышью не даёт ни touchmove, ни wheel —
        // без этого на десктопе режим залипания не переключался бы вообще
        // (см. окно жеста в useChatListAnchor). На тач-устройствах mousedown
        // приходит уже после touchmove, окно к тому моменту и так открыто.
        onMouseDown={noteUserGesture}
        onTouchEnd={handleMessagesTouchEnd}
        onTouchCancel={handleMessagesTouchEnd}
        onWheel={handleListUserScroll}
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
                // См. exitingSeqs выше: сообщение уже удалено из messages,
                // но ещё доигрывает collapse — height/margin едут в 0 своим
                // ходом, вместо мгновенного исчезновения через exit
                // (тот успевал схлопнуть только opacity/scale, а высоту —
                // никогда, отсюда и был голый пробел снизу ленты).
                // marginBottom в этой анимации до недавнего был пустышкой:
                // зазор между строками задавался gap контейнера, а gap у
                // отдельного ребёнка не анимируется ничем. Теперь зазор — это
                // собственный margin-bottom строки (см. ChatPage.css), и он
                // схлопывается вместе с высотой, а не щёлкает в конце.
                const isExiting = exitingSeqs.has(message.seq);

                return (
                  <motion.div
                    key={`msg-${message.seq}`}
                    data-seq={message.seq}
                    className={`chat-bubble-outer ${isMine ? 'mine' : ''} ${readers.length > 0 ? 'chat-bubble-outer--has-readers' : ''}`}
                    style={isExiting ? { overflow: 'hidden', pointerEvents: 'none' } : undefined}
                    initial={{ opacity: 0, y: 10 }}
                    animate={isExiting
                      ? { opacity: 0, scale: 0.92, height: 0, marginTop: 0, marginBottom: 0 }
                      : { opacity: 1, y: 0 }}
                    transition={isExiting ? { duration: EXIT_COLLAPSE_MS / 1000, ease: 'easeInOut' } : undefined}
                    onAnimationComplete={() => { if (isExiting) handleExitCollapseComplete(message.seq); }}
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
                        onClick={(e) => { if (!isMediaBubble && !suppressClickIfLongPress(e)) setActionTarget(message); }}
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
            onClick={() => scrollListToBottom('smooth')}
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
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,video/*"
            hidden
            onChange={handleGallerySelected}
          />

          {!recording && (
            <button
              className="chat-icon-button"
              disabled={sending}
              onClick={() => fileInputRef.current?.click()}
              title="Галерея"
            >
              <Paperclip size={20} />
            </button>
          )}

          {/* Слот с текстовым полем — вне зависимости от recording. Поле
              никогда не размонтируется и не теряет фокус при старте записи:
              размонтирование contentEditable снимает с него фокус, а с ним и
              клавиатуру (браузер закрывает её сам, это не наша анимация и
              не отменить её после факта). Вместо этого во время записи поле
              просто визуально прикрывается непрозрачным оверлеем с таймером —
              фокус и клавиатура остаются как были. */}
          <div className={`chat-composer-slot ${recording ? 'chat-composer-slot--recording' : ''}`}>
            <div
              key={composerKey}
              ref={textInputRef}
              className={`chat-text-input ${inputText.trim() ? '' : 'chat-text-input--empty'}`}
              contentEditable
              suppressContentEditableWarning
              autoCapitalize="sentences"
              role="textbox"
              aria-multiline="true"
              aria-label="Сообщение"
              data-placeholder="Сообщение…"
              onInput={syncComposerState}
              onFocus={() => setInputFocused(true)}
              // Поле специально остаётся в фокусе на время записи (иначе
              // закроется клавиатура), но печатать в него вслепую из-под
              // оверлея нельзя: набранный текст переключил бы кнопку записи
              // на "отправить" — остановить запись стало бы нечем.
              onBeforeInput={(e) => { if (recordingRef.current) e.preventDefault(); }}
              onBlur={() => { if (!suppressComposerBlurRef.current) setInputFocused(false); }}
              onKeyDown={handleComposerKeyDown}
              onPaste={handleComposerPaste}
              enterKeyHint="send"
            />

            <AnimatePresence>
              {recording && (
                <motion.div
                  className="chat-recording-overlay"
                  initial={{ opacity: 0, x: 10 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -10 }}
                  transition={{ duration: 0.16, ease: 'easeOut' }}
                >
                  {/* Пока палец на кнопке — отменяют свайпом влево, мусорка не
                      нужна и только отъедала бы место у волны. Отпустили (режим
                      ожидания второго тапа) — свайпать нечем, показываем её. */}
                  {!micHeld && (
                    <button className="chat-recording-cancel" onClick={cancelRecording} title="Отменить">
                      <Trash2 size={18} />
                    </button>
                  )}
                  <span className="chat-recording-dot" />
                  <span className="chat-recording-timer">{formatDuration(recordingSeconds)}</span>
                  {/* Живая волна: столбики добавляются справа и убегают влево,
                      старые срезает overflow контейнера. Высоты пишет
                      startLevelMeter напрямую в DOM. */}
                  <div className="chat-recording-wave" aria-hidden="true">
                    {Array.from({ length: WAVE_BAR_COUNT }, (_, i) => (
                      <span
                        key={i}
                        className="chat-recording-wave-bar"
                        ref={(el) => { waveBarsRef.current[i] = el; }}
                      />
                    ))}
                  </div>
                  {micHeld && (
                    <span className="chat-recording-hint">
                      <ChevronLeft size={14} />
                      Отмена
                    </span>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

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
              ref={micButtonRef}
              className={`chat-icon-button chat-mic-button ${recording ? 'recording' : ''}`}
              disabled={sending}
              onPointerDown={handleMicPointerDown}
              onPointerMove={handleMicPointerMove}
              onPointerUp={handleMicPointerUp}
              onPointerCancel={handleMicPointerCancel}
              // Дубль preventDefault из pointerdown — на десктопных движках,
              // где mousedown приходит своим путём, а не как compatibility-
              // событие. Ровно тем же способом бережёт фокус поля кнопка
              // отправки выше.
              onMouseDown={(e) => e.preventDefault()}
              title={recording ? 'Отпустите, чтобы отправить, или тапните ещё раз; свайп влево — отмена' : 'Голосовое: тап — начать, ещё тап — отправить; или удержите и отпустите'}
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
                src={lightbox.thumbSrc && !fullImageReady ? lightbox.thumbSrc : lightbox.src}
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
                  // Резкий анзум (быстрый пинч обратно к 1x) на тач-устройствах
                  // рождает фантомный drag-жест той же рукой — без этой паузы
                  // он тут же трактовался бы как свайп-закрытие. Закрыть можно
                  // только отдельным, уже не пинчевым свайпом одним пальцем.
                  if (pinchStartRef.current || Date.now() - pinchEndedAtRef.current < 400) return;
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
                // До первого замера позиция неизвестна — уводим стопку далеко
                // за экран, а не прячем через visibility: hidden. Та выключает
                // элемент из композитинга, и WebKit создаёт слой под
                // backdrop-filter только в момент показа — ровно тогда же,
                // когда стопка одновременно возвращается в кадр и начинает
                // проявляться, отчего на один кадр виден непрогретый блюр
                // ("хлопок"). Оставаясь в композитинге всё время, просто вне
                // кадра, слой успевает прогреться заранее.
                left: menuPos?.left ?? -9999,
                top: menuPos?.top ?? -9999,
              }}
              // Только прозрачность, без scale: у карточек своё стекло, а оно
              // при каждом изменении геометрии пересчитывает размытие заново —
              // именно связка "стекло + пружинящий scale" и давала рябь.
              // Пружинит вместо них копия сообщения, у неё стекла нет.
              initial={{ opacity: 0 }}
              // Стартуем tween только когда позиция уже известна — иначе он
              // отыгрывает, пока стопка ещё за экраном, и к моменту показа
              // уже почти доигран: на экране она материализуется готовой,
              // без видимого проявления.
              animate={{ opacity: menuPos ? 1 : 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
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
                    <span className="chat-action-reader-time">{r.read_at ? formatReadDateTime(r.read_at) : ''}</span>
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
