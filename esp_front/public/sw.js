// Минимальный service worker — только для Web Push уведомлений чата.
// Никакого офлайн-кэширования/precache тут нет, это не нужно для этой задачи.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
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
