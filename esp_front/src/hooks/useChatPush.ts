import { useEffect, useState } from 'react';
import { apiClient } from '../api/client';

export type NotifStatus = 'unsupported' | 'ios-not-installed' | 'default' | 'denied' | 'granted';

const isIosNotStandalone = (): boolean => {
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true;
  return isIos && !isStandalone;
};

// Notification.permission читается синхронно — незачем определять статус
// асинхронно в useEffect после первого рендера: баннер "включить уведомления"
// на мгновение мелькал бы даже там, где разрешение давно выдано (или
// платформа вообще не поддерживает пуши), пока эффект не отработает.
const getInitialNotifStatus = (): NotifStatus => {
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    return isIosNotStandalone() ? 'ios-not-installed' : 'unsupported';
  }
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission === 'granted') return 'granted';
  return 'default';
};

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

// Общая Web Push логика чата — общая для баннера в ChatPage ("включить
// уведомления") и переключателя в ChatSettingsPage ("выключить"). Состояние
// не расшарено между инстансами хука: каждый маунт заново читает
// Notification.permission и реальную PushSubscription, этого достаточно —
// между шапкой чата и настройками всегда происходит переход по роуту.
export function useChatPush() {
  const [notifStatus, setNotifStatus] = useState<NotifStatus>(getInitialNotifStatus);
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);

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
      setSubscribed(true);
    } catch (err) {
      console.error('Не удалось синхронизировать push-подписку', err);
    }
  };

  useEffect(() => {
    if (notifStatus === 'granted') ensureSubscribed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Единственное место, где реально вызывается системный диалог — по тапу
  // юзера, никогда автоматически.
  const requestAccess = async () => {
    if (busy) return;
    setBusy(true);
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
      setBusy(false);
    }
  };

  // Отписка только от push на этом устройстве — системное разрешение браузера
  // JS отозвать не может, оно остаётся granted. Повторный requestAccess/
  // ensureSubscribed включит push обратно без нового системного диалога.
  const unsubscribe = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      await subscription?.unsubscribe();
      await apiClient.unsubscribeChatPush();
      setSubscribed(false);
    } catch (err) {
      console.error('Не удалось отписаться от push-уведомлений', err);
    } finally {
      setBusy(false);
    }
  };

  return { notifStatus, subscribed, busy, requestAccess, unsubscribe };
}
