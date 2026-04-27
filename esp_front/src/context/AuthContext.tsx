import React, { createContext, useContext, useState, useEffect } from 'react';
import { API_BASE_URL } from '../api/client';

interface AuthContextType {
  accessKey: string | null;
  isLoading: boolean;
  setAccessKey: (key: string) => Promise<void>;
  clearAccessKey: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [accessKey, setAccessKeyState] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

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
          if (res.ok) setAccessKeyState('session');
        } catch {}
        window.history.replaceState({}, '', '/');
      } else {
        // Проверяем существующую сессию
        try {
          const res = await fetch(`${API_BASE_URL}/auth/me`, {
            credentials: 'include',
          });
          if (res.ok) setAccessKeyState('session');
        } catch {}
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
  };

  const clearAccessKey = () => {
    fetch(`${API_BASE_URL}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    }).catch(() => {});
    setAccessKeyState(null);
  };

  return (
    <AuthContext.Provider value={{
      accessKey,
      isLoading,
      setAccessKey: handleSetKey,
      clearAccessKey,
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
