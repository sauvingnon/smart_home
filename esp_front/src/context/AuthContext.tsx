import React, { createContext, useContext, useState, useEffect } from 'react';

interface AuthContextType {
  accessKey: string | null;
  isLoading: boolean;
  setAccessKey: (key: string) => void;
  clearAccessKey: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [accessKey, setAccessKey] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // 1. Проверяем URL на наличие ключа
    const urlParams = new URLSearchParams(window.location.search);
    const urlKey = urlParams.get('key');
    
    // 2. Проверяем localStorage
    const storedKey = localStorage.getItem('esp_access_key');
    
    if (urlKey) {
      // Ключ из URL - сохраняем и чистим URL
      localStorage.setItem('esp_access_key', urlKey);
      setAccessKey(urlKey);
      
      // Чистим URL от ключа (безопасность и эстетика)
      window.history.replaceState({}, '', '/');
      
    } else if (storedKey) {
      // Ключ из localStorage
      setAccessKey(storedKey);
    }
    
    setIsLoading(false);
  }, []);

  const handleSetKey = (key: string) => {
    localStorage.setItem('esp_access_key', key);
    setAccessKey(key);
  };

  const clearAccessKey = () => {
    localStorage.removeItem('esp_access_key');
    setAccessKey(null);
  };

  return (
    <AuthContext.Provider value={{ 
      accessKey, 
      isLoading, 
      setAccessKey: handleSetKey, 
      clearAccessKey 
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