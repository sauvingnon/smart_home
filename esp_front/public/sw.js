// Service worker для Web Push уведомлений чата + офлайн-заглушка на случай,
// когда сервер целиком недоступен (упал бэкенд, значит не отдастся и сам
// фронт — с точки зрения fetch() это неотличимо от отсутствия интернета).

const CACHE_NAME = 'offline-fallback-v2';
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

// Ловим только навигацию (переход/перезагрузку страницы), не трогаем
// API-запросы и WS — те как обрабатывались каждой страницей сами, так и
// продолжают.
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(
    fetch(event.request)
      .then(withoutRedirect)
      .catch(() => caches.match(OFFLINE_URL))
  );
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
      tag: 'chat-message',
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
