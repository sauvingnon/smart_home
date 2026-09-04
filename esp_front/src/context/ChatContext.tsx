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
  /** Наш собственный last_read_seq на момент входа в чат — снимок, снятый ДО
      того, как markRead сдвинет фронтир на текущий конец ленты. Из него лента
      рисует полосу "непрочитанные". null — снимка нет (мы не в чате, либо своё
      состояние прочтений ещё не приехало). */
  unreadFromSeq: number | null;
  connectionState: ConnectionState;
  loadingHistory: boolean;
  historyReady: boolean;
  hasMoreHistory: boolean;
  loadMoreHistory: () => Promise<void>;
  sendMessage: (payload: Parameters<typeof apiClient.sendChatMessage>[0]) => Promise<void>;
  markRead: () => Promise<void>;
  /** Условие, при котором отметка о прочтении вообще имеет право уйти. Ставит
      страница чата (см. setReadGate ниже) — контекст сам не знает, видит ли
      юзер низ ленты. */
  setReadGate: (gate: () => boolean) => void;
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

// Слияние свежей последней страницы с тем, что уже в ленте. Сервер — истина
// для того диапазона, который он вернул: там уже учтены и правки, и удаления,
// случившиеся, пока мы были офлайн. Всё, что старше этого диапазона, оставляем
// как есть — эту историю юзер мог догрузить скроллом, а сейчас её никто не
// присылал, и терять её при каждой досинхронизации незачем.
function mergeFreshPage(prev: ChatMessage[], page: ChatMessage[]): ChatMessage[] {
  // Пустой ответ без пагинации значит именно "сообщений нет" (всё удалено или
  // вычищено ретеншеном), а не "нечего добавить".
  if (page.length === 0) return [];
  const oldestFresh = page[0].seq;
  const newestLocal = prev.length > 0 ? prev[prev.length - 1].seq : -1;
  // Страница пересеклась с лентой — значит между ними нет дыры и склейка
  // честная. Неполная страница тоже безопасна: сервер отдал вообще всю
  // историю, какая есть, пропускать нечего.
  const contiguous = newestLocal >= oldestFresh || page.length < HISTORY_PAGE_SIZE;
  // Иначе за время отсутствия набежало больше страницы: между старым хвостом
  // и свежей страницей провал, и склеивать их встык — значит нарисовать
  // непрерывную ленту там, где её нет. Показываем только свежее, остальное
  // юзер догрузит скроллом.
  if (!contiguous) return page;
  return [...prev.filter((m) => m.seq < oldestFresh), ...page];
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
// Сколько ждём 'pong' на health-check при возврате в приложение, прежде чем
// признать сокет мёртвым и пересоздать его.
const PONG_TIMEOUT_MS = 3000;
// Не пересоздаём сокет чаще, чем раз в столько: серия visibilitychange
// (быстрое переключение между табами/аппами) не должна долбить сервер новыми
// соединениями поверх уже идущего реконнекта.
const FORCE_RECONNECT_DEBOUNCE_MS = 5000;
// Через столько повторяем отметку о прочтении, не ушедшую из-за сети. Без
// повтора она ждала бы следующего нового сообщения: бейдж висел бы на
// открытом чате, а отправитель не увидел бы кружок вообще.
const READ_RETRY_MS = 5000;

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

  // Отметка не ушла (сеть моргнула или экран был потушен) и ждёт повтора.
  const pendingReadRef = useRef(false);
  const readRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Дополнительное условие от страницы чата: "низ ленты сейчас перед глазами".
  // По умолчанию открыто — вне /chat отметку шлёт только явная синхронизация.
  const readGateRef = useRef<() => boolean>(() => true);
  const setReadGate = useCallback((gate: () => boolean) => {
    readGateRef.current = gate;
  }, []);

  // Ссылка на саму себя — нужна ретраю по таймеру и флашу из обработчика
  // visibilitychange, которые живут в эффектах с другими зависимостями.
  const markReadRef = useRef<() => Promise<void>>(async () => {});

  const markRead = useCallback(async () => {
    if (readRetryTimerRef.current) {
      clearTimeout(readRetryTimerRef.current);
      readRetryTimerRef.current = null;
    }

    // Юзер ушёл в историю: новые сообщения приходят ниже экрана, и он их не
    // видит — отмечать прочитанным нечего. Специально БЕЗ pendingReadRef:
    // это не отложенная отправка, а отказ. Как только он вернётся к низу,
    // страница чата дёрнет markRead сама (эффект завязан на тот же признак,
    // что и этот гейт), и отметка уйдёт уже честно.
    if (!readGateRef.current()) return;

    // Экран потушен или приложение свёрнуто. Раньше отметка уходила и отсюда:
    // сокет жив, сообщение прилетает в ленту, лента меняется — и отправитель
    // мгновенно видел "прочитано" от человека, у которого телефон лежит в
    // кармане. Откладываем до реального возвращения в приложение.
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      pendingReadRef.current = true;
      return;
    }

    try {
      await apiClient.markChatRead();
      pendingReadRef.current = false;
      setUnreadCount(0);
    } catch {
      pendingReadRef.current = true;
      readRetryTimerRef.current = setTimeout(() => {
        readRetryTimerRef.current = null;
        void markReadRef.current();
      }, READ_RETRY_MS);
    }
  }, []);

  useEffect(() => {
    markReadRef.current = markRead;
  }, [markRead]);

  useEffect(() => () => {
    if (readRetryTimerRef.current) clearTimeout(readRetryTimerRef.current);
  }, []);

  // Снимок собственного фронтира на момент входа в чат.
  //
  // Своё прочтение в ленте нельзя показывать кружком: markRead уводит наш
  // last_read_seq на текущий конец ленты, так что кружок был бы навсегда
  // приклеен к последнему сообщению и не сообщал бы ничего. Полезен ровно
  // обратный вопрос — "откуда читать", — и ответ на него живёт ровно один
  // миг: до первого markRead этого захода. Снимаем его здесь и держим до
  // ухода со страницы, из него лента рисует полосу "непрочитанные".
  const [unreadFromSeq, setUnreadFromSeq] = useState<number | null>(null);
  const unreadSnapshotTakenRef = useRef(false);
  const readsRef = useRef<ChatReadState[]>(reads);
  useEffect(() => {
    readsRef.current = reads;
  }, [reads]);

  const takeUnreadSnapshot = useCallback((source: ChatReadState[]) => {
    if (unreadSnapshotTakenRef.current || !userId) return;
    const mine = source.find((r) => r.user_id === userId);
    // Своего состояния прочтений ещё нет — снимем на ближайшей синхронизации,
    // она приходит первой же из двух и всё равно раньше любого markRead.
    if (!mine) return;
    unreadSnapshotTakenRef.current = true;
    setUnreadFromSeq(mine.last_read_seq);
  }, [userId]);

  // Один снимок на один заход в чат: пока юзер на странице, полоса стоит на
  // месте и не переезжает от каждого нового сообщения (иначе она следовала бы
  // за лентой и всегда оказывалась под последним сообщением — то же самое,
  // чем плох собственный кружок).
  useEffect(() => {
    if (isOnChatPage) {
      takeUnreadSnapshot(readsRef.current);
      return;
    }
    unreadSnapshotTakenRef.current = false;
    setUnreadFromSeq(null);
  }, [isOnChatPage, takeUnreadSnapshot]);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Смена юзера (логаут/вход) обесценивает уже улетевшие запросы: ответ на
  // историю прошлого юзера не должен приземлиться в ленту нового.
  const syncGenerationRef = useRef(0);

  const syncInFlightRef = useRef(false);

  // Полный снимок состояния чата с сервера. Дёргается и на старте, и каждый
  // раз, когда мы могли что-то пропустить: WS доставляет только события,
  // случившиеся при живом соединении, поэтому всё, что пришло, пока PWA был
  // свёрнут (или пока сокет молча умер), можно узнать только вот так.
  //
  // silent — досинхронизация поверх уже показанной ленты: не трогаем
  // loadingHistory/historyReady, иначе на ровном месте мигнёт скелет.
  const syncFromServer = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    // Возврат в приложение и переподключение сокета случаются почти
    // одновременно (свернули → развернули → реконнект → open), и оба хотят
    // досинхронизации. Один запрос на двоих: второй всё равно вернул бы то же
    // самое, а это пять HTTP-запросов.
    if (syncInFlightRef.current) return;
    syncInFlightRef.current = true;
    const generation = syncGenerationRef.current;
    const isStale = () => !mountedRef.current || syncGenerationRef.current !== generation;
    if (!silent) setLoadingHistory(true);
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
      if (isStale()) return;
      setMessages((prev) => mergeFreshPage(prev, historyRes.messages));
      setHasMoreHistory(historyRes.messages.length >= HISTORY_PAGE_SIZE);
      setReads(readsRes.reads);
      setPinnedMessage(pinnedRes.message);
      setPresence(presenceRes.entries);
      // Мы смотрим прямо в ленту — то, что пришло, пока нас не было, читается
      // сейчас; показать бейдж и тут же его погасить было бы миганием.
      if (isOnChatPageRef.current) {
        // Строго до markRead и из свежего ответа, а не из стейта: markRead
        // сдвинет наш фронтир на конец ленты, а WS-эхо этой же отметки
        // перепишет нашу запись в reads. Здесь — последний момент, когда
        // видно, докуда мы дочитали на самом деле.
        takeUnreadSnapshot(readsRes.reads);
        void markRead();
      } else {
        setUnreadCount(unreadRes.unread_count);
      }
    } catch {
      // остаёмся с тем, что уже есть; следующая попытка — на ближайшем
      // возврате в приложение или реконнекте WS
    } finally {
      syncInFlightRef.current = false;
      if (!isStale() && !silent) {
        setLoadingHistory(false);
        setHistoryReady(true);
      }
    }
  }, [markRead, takeUnreadSnapshot]);

  // Обработчики WS/visibility живут в эффекте с deps [userId] — брать функцию
  // оттуда через ref, чтобы её пересоздание не роняло и не переподнимало сокет.
  const syncRef = useRef(syncFromServer);
  useEffect(() => {
    syncRef.current = syncFromServer;
  }, [syncFromServer]);

  // Начальная загрузка: последняя страница истории + текущие unread/read состояния
  useEffect(() => {
    if (!userId) return;

    // Сам по себе этот запрос уже растянут по времени, но он всё равно
    // стартует в тот же тик, что и телеметрия HomePage (t=0) — задержка перед
    // стартом разводит его с остальным холодным залпом на входе.
    const startTimer = setTimeout(() => { void syncRef.current(); }, HISTORY_FETCH_DELAY_MS);
    return () => {
      clearTimeout(startTimer);
      syncGenerationRef.current += 1;
    };
  }, [userId]);

  const connectionStateRef = useRef<ConnectionState>('connecting');
  useEffect(() => {
    connectionStateRef.current = connectionState;
  }, [connectionState]);

  // Время последнего полученного 'pong' — по нему health-check при возврате в
  // приложение отличает живой сокет от того, который только считается живым.
  const lastPongAtRef = useRef(0);
  // Первый open — это старт, история уже едет отдельным запросом. Каждый
  // следующий — восстановление после обрыва, и вот его надо догонять.
  const hasConnectedOnceRef = useRef(false);

  useEffect(() => {
    if (!userId) return;

    setConnectionState('connecting');
    hasConnectedOnceRef.current = false;

    const wsOptions = {
      onOpen: () => {
        setConnectionState('connected');
        if (hasConnectedOnceRef.current) {
          // Соединение восстановилось после разрыва: за время разрыва события
          // шли мимо нас, WS их не переиграет — добираем состояние по HTTP.
          void syncRef.current({ silent: true });
        }
        hasConnectedOnceRef.current = true;
      },
      onPong: () => {
        lastPongAtRef.current = Date.now();
      },
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
              // Имя берём из события, и только потом — из уже известной записи.
              // Раньше был только второй источник, и запись, созданная событием,
              // пришедшим раньше первого /read_states, навсегда оставалась с
              // пустым именем: каждое следующее событие копировало пустоту из
              // неё же самой. В ленте это был кружок с "?" вместо буквы, в меню
              // — строка вообще без имени, и жило это до перезахода в чат.
              display_name: event.data.display_name || existing?.display_name || '',
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

    let lastForceReconnect = 0;
    const forceReconnect = () => {
      const now = Date.now();
      if (now - lastForceReconnect < FORCE_RECONNECT_DEBOUNCE_MS) return;
      lastForceReconnect = now;
      // Если отложенный первый коннект ещё не сработал — снимаем его, иначе
      // он поднимет второй сокет поверх нашего, и на сервере повиснет лишний
      // «зритель» чата.
      clearTimeout(connectTimer);
      apiClient.closeChatWebSocket();
      setConnectionState('connecting');
      apiClient.createChatWebSocket(wsOptions);
    };

    // Вернулись в приложение (разблокировали телефон, переключились обратно с
    // другой апки). Здесь два независимых дела, и делать надо оба.
    let pongTimer: ReturnType<typeof setTimeout> | null = null;
    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') return;

      // Нулевое: отметка о прочтении, отложенная пока экран был потушен (или
      // не ушедшая из-за сети). Теперь юзер действительно смотрит в ленту —
      // markRead сам перепроверит и гейт страницы, и видимость.
      if (pendingReadRef.current) void markReadRef.current();

      // Первое: пока PWA был свёрнут, всё пришедшее прошло мимо ленты — WS
      // доставляет только то, что случилось при живом соединении, и никогда
      // не переигрывает пропущенное. Единственный способ увидеть ответ,
      // написанный, пока нас не было, — сходить за историей самим. Делаем это
      // всегда, а не только при мёртвом сокете: сообщение могло прийти и в
      // тот зазор, пока сокет умирал.
      void syncRef.current({ silent: true });

      // Второе: поднять соединение, если оно отвалилось. Раньше проверка
      // ограничивалась connectionState !== 'connected', и этого мало —
      // мобильная ОС рвёт TCP молча, событие close до нас не доходит, а
      // readyState остаётся OPEN до первой неудачной записи. Приложение
      // считало себя онлайн и молчало часами. Поэтому не верим состоянию, а
      // спрашиваем сокет: нет 'pong' за PONG_TIMEOUT_MS — пересоздаём.
      if (connectionStateRef.current !== 'connected' || !apiClient.pingChatWebSocket()) {
        forceReconnect();
        return;
      }
      const pingedAt = Date.now();
      if (pongTimer) clearTimeout(pongTimer);
      pongTimer = setTimeout(() => {
        pongTimer = null;
        if (lastPongAtRef.current < pingedAt) forceReconnect();
      }, PONG_TIMEOUT_MS);
    };
    document.addEventListener('visibilitychange', handleVisibility);

    const typingTimers = typingTimersRef.current;
    return () => {
      clearTimeout(connectTimer);
      if (pongTimer) clearTimeout(pongTimer);
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

  // Замок именно ref-ом, а не стейтом loadingHistory. Догрузку дёргает
  // обработчик scroll, а он на инерционной прокрутке к верху ленты срабатывает
  // много раз подряд, быстрее чем React успевает перерисоваться с
  // loadingHistory === true. Все эти вызовы видели в замыкании ещё старое
  // false, проходили проверку и уходили за одной и той же страницей: история
  // вставлялась дважды, а лента прыгала на её двойную высоту. Ref меняется в
  // тот же миг, без ожидания рендера.
  const loadingHistoryRef = useRef(false);

  const loadMoreHistory = useCallback(async () => {
    if (loadingHistoryRef.current || !hasMoreHistory || messages.length === 0) return;
    loadingHistoryRef.current = true;
    setLoadingHistory(true);
    try {
      const oldestSeq = messages[0].seq;
      const res = await apiClient.getChatMessages(oldestSeq);
      setMessages((prev) => {
        // Страховка на случай пересечения страниц: одинаковые seq в ленте —
        // это и дубли пузырей, и повторяющиеся ключи в React.
        const known = new Set(prev.map((m) => m.seq));
        const fresh = res.messages.filter((m) => !known.has(m.seq));
        return fresh.length > 0 ? [...fresh, ...prev] : prev;
      });
      setHasMoreHistory(res.messages.length >= HISTORY_PAGE_SIZE);
    } catch {
      // остаёмся с уже загруженным
    } finally {
      loadingHistoryRef.current = false;
      setLoadingHistory(false);
    }
  }, [hasMoreHistory, messages]);

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
      unreadFromSeq,
      connectionState,
      loadingHistory,
      historyReady,
      hasMoreHistory,
      loadMoreHistory,
      sendMessage,
      markRead,
      setReadGate,
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
