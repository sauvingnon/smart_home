import React, { createContext, useContext, useState, useEffect } from 'react';
import { apiClient, API_BASE_URL } from '../api/client';

interface AuthContextType {
  accessKey: string | null;
  isLoading: boolean;
  isAdmin: boolean;
  userId: number | null;
  username: string | null;
  displayName: string | null;
  setAccessKey: (key: string) => Promise<void>;
  logout: () => Promise<void>;
  resetSession: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [accessKey, setAccessKeyState] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [userId, setUserId] = useState<number | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchMe = async (): Promise<boolean> => {
    try {
      const res = await fetch(`${API_BASE_URL}/auth/me`, {
        credentials: 'include',
      });
      if (res.ok) {
        const data = await res.json();
        setIsAdmin(Boolean(data.is_admin));
        setUserId(typeof data.user_id === 'number' ? data.user_id : null);
        setUsername(data.username ?? null);
        setDisplayName(data.display_name ?? null);
        return true;
      }
    } catch {}
    return false;
  };

  useEffect(() => {
    const init = async () => {
      const urlParams = new URLSearchParams(window.location.search);
      const urlKey = urlParams.get('key');

      if (urlKey) {
        // Обмениваем ключ из URL на httpOnly cookie
        try {
          const res = await fetch(`${API_BASE_URL}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: urlKey }),
            credentials: 'include',
          });
          if (res.ok) {
            setAccessKeyState('session');
            await fetchMe();
          }
        } catch {}
        window.history.replaceState({}, '', '/');
      } else {
        // Проверяем существующую сессию
        if (await fetchMe()) setAccessKeyState('session');
      }

      setIsLoading(false);
    };

    init();
  }, []);

  const handleSetKey = async (key: string) => {
    const res = await fetch(`${API_BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
      credentials: 'include',
    });
    if (!res.ok) {
      throw new Error('Invalid key');
    }
    setAccessKeyState('session');
    await fetchMe();
  };

  const clearLocalState = () => {
    apiClient.closeAllWebSockets();
    setAccessKeyState(null);
    setIsAdmin(false);
    setUserId(null);
    setUsername(null);
    setDisplayName(null);
  };

  // Сессия уже мертва на сервере (пришёл 401/403) — дёргать /auth/logout незачем,
  // чистим только локальное состояние.
  const resetSession = () => {
    clearLocalState();
  };

  const logout = async () => {
    // Пуш-подписку снимаем ДО логаута: /chat/push/unsubscribe требует валидную
    // cookie. После удаления сессии он вернёт 401, подписка останется на сервере,
    // и разлогиненное устройство продолжит получать уведомления чата с текстом
    // сообщений — уже на экране логина.
    try {
      if ('serviceWorker' in navigator) {
        // Именно getRegistration, а не ready: ready никогда не резолвится, если
        // service worker не зарегистрирован, и кнопка "Выйти" висла бы вечно.
        const registration = await navigator.serviceWorker.getRegistration();
        const subscription = await registration?.pushManager.getSubscription();
        if (subscription) {
          await apiClient.unsubscribeChatPush();
          await subscription.unsubscribe();
        }
      }
    } catch (err) {
      // Не блокируем выход: подписка перезапишется при следующем входе
      // (она одна на юзера), а держать человека в аккаунте из-за пуша — хуже.
      console.error('Не удалось снять push-подписку', err);
    }

    // Ошибку тут уже не глушим. Если запрос не дошёл, cookie осталась на месте,
    // и молча показать экран логина значит соврать: перезагрузка вернёт сессию.
    const res = await fetch(`${API_BASE_URL}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!res.ok) {
      throw new Error(`Logout failed: ${res.status}`);
    }

    clearLocalState();
  };

  return (
    <AuthContext.Provider value={{
      accessKey,
      isLoading,
      isAdmin,
      userId,
      username,
      displayName,
      setAccessKey: handleSetKey,
      logout,
      resetSession,
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
