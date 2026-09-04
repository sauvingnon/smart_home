// Service worker для Web Push уведомлений чата + офлайн-заглушка на случай,
// когда сервер целиком недоступен (упал бэкенд, значит не отдастся и сам
// фронт — с точки зрения fetch() это неотличимо от отсутствия интернета).

const CACHE_NAME = 'offline-fallback-v3';
const OFFLINE_URL = '/offline.html';

// Safari (и установленная PWA на iOS) отказывается принимать от service worker
// ответ, доехавший через редирект, — падает с "Response served by service
// worker has redirections". А редирект тут штатный: serve с дефолтным cleanUrls
// отдаёт 301 с /offline.html на /offline, да и nginx впереди может добавить
// свой. Флаг redirected переживает и запись в Cache Storage, поэтому ответ
// пересобираем: у копии этого флага уже нет.
async function withoutRedirect(response) {
  if (!response.redirected) return response;
  const body = await response.blob();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(async (cache) => {
        const response = await fetch(OFFLINE_URL, { cache: 'reload' });
        // Ставить в кэш что попало нельзя: если обновление SW совпало с
        // недоступным бэкендом, сюда доедет страница ошибки от nginx — и
        // заглушкой на все будущие падения станет она.
        if (!response.ok) return;
        await cache.put(OFFLINE_URL, await withoutRedirect(response));
      })
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// Недоступность сервера выглядит для fetch() двумя совершенно разными
// способами, и заглушку надо показать в обоих.
//
// 1. Ответить некому: нет сети, машина выключена, nginx не поднят. fetch
//    отклоняется исключением — это ветка catch.
// 2. Отвечает nginx, но не отвечает контейнер за ним (упал, пересобирается).
//    Тогда fetch штатно резолвится страницей 502/503/504, ошибки для него
//    тут нет никакой, и без явной проверки статуса пользователь получает в
//    окно «502 Bad Gateway» от nginx вместо нашей заглушки.
//
// Разбираем именно 5xx: 404 и прочие 4xx — осмысленный ответ живого сервера,
// его подменять нечем и незачем.
async function navigate(request) {
  let response;
  try {
    response = await fetch(request);
  } catch (error) {
    const fallback = await caches.match(OFFLINE_URL);
    // Заглушки может не быть — например, SW встал первый раз уже при мёртвом
    // сервере. Тогда отдаём браузеру его собственную ошибку, как без SW.
    if (!fallback) throw error;
    return fallback;
  }

  if (response.status >= 500) {
    const fallback = await caches.match(OFFLINE_URL);
    if (fallback) return fallback;
  }
  return withoutRedirect(response);
}

// Ловим только навигацию (переход/перезагрузку страницы), не трогаем
// API-запросы и WS — те как обрабатывались каждой страницей сами, так и
// продолжают.
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(navigate(event.request));
});

self.addEventListener('push', (event) => {
  let payload = { title: 'Умный дом', body: 'Новое сообщение в чате', url: '/chat' };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    // не JSON — оставляем дефолт
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/manifest-icon-192.maskable.png',
      badge: '/manifest-icon-192.maskable.png',
      data: { url: payload.url || '/chat' },
      // Тег решает, какие уведомления схлопываются в одно. Дефолт оставлен
      // прежним — все новые сообщения по-прежнему живут одной строкой, второе
      // заменяет первое. А вот реакции присылают свой тег и в эту строку не
      // лезут: иначе пуш «Маша поставила 👍» затирал бы ещё не прочитанное
      // уведомление о самом сообщении, и наоборот.
      tag: payload.tag || 'chat-message',
      renotify: true,
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/chat';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsArr) => {
      const existing = clientsArr.find((c) => 'focus' in c);
      if (existing) {
        existing.navigate(targetUrl);
        return existing.focus();
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});
