import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import { Login } from './pages/Login/Login';
import HomePage from './pages/HomePage/HomePage';
import { LaunchScreen } from './components/LaunchScreen/LaunchScreen';
import { useEffect, useState } from 'react';
import { apiClient, AuthError } from './api/client';
import SettingsPage from './pages/SettingsPage/SettingsPage';
import { CameraPage } from './pages/CameraPage/CameraPage';
import { VideosPage } from './pages/VideoPage/VideoPage';
import { ThemeProvider } from './context/ThemeContext';

function App() {
  const { accessKey, isLoading: authLoading, clearAccessKey } = useAuth();
  const [appReady, setAppReady] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [minTimePassed, setMinTimePassed] = useState(false);
  const [isValidating, setIsValidating] = useState(true);

  // Добавь в App.tsx, рядом с другими useEffect
useEffect(() => {
    // Проверяем, не запустилась ли старая сломанная версия
    const isOldBrokenVersion = () => {
      // Если URL без параметра сессии, но приложение уже пыталось загрузиться >3 раз
      const attempts = sessionStorage.getItem('broken_attempts') || '0';
      const hasNoSessionParam = !window.location.search.includes('_session');
      
      if (hasNoSessionParam && parseInt(attempts) > 2) {
        return true;
      }
      
      if (hasNoSessionParam) {
        sessionStorage.setItem('broken_attempts', (parseInt(attempts) + 1).toString());
      }
      
      return false;
    };
    
    if (isOldBrokenVersion() && window.matchMedia('(display-mode: standalone)').matches) {
      // Показываем модалку вместо белого экрана
      const root = document.getElementById('root');
      if (root) {
        root.innerHTML = `
          <div style="
            position: fixed; 
            top: 0; left: 0; 
            width: 100%; height: 100%; 
            background: white; 
            display: flex; 
            flex-direction: column; 
            align-items: center; 
            justify-content: center; 
            padding: 20px; 
            text-align: center; 
            font-family: system-ui; 
            z-index: 99999;
          ">
            <h2 style="margin-bottom: 16px;">🔄 Требуется обновление</h2>
            <p style="margin-bottom: 24px; color: #666;">
              Приложение нужно переустановить из-за обновления.
            </p>
            <ol style="text-align: left; margin-bottom: 24px; color: #333;">
              <li>Удалите приложение с экрана домой</li>
              <li>Очистите Safari: Настройки → Safari → Очистить историю</li>
              <li>Добавьте приложение заново</li>
            </ol>
            <button onclick="location.reload()" style="
              padding: 12px 24px; 
              background: #007aff; 
              color: white; 
              border: none; 
              border-radius: 12px; 
              font-size: 16px;
            ">
              Попробовать снова
            </button>
          </div>
        `;
      }
    }
  }, []);

  // 🔥 FIX #1: Защита от "вечного белого экрана" на iOS PWA
  useEffect(() => {
    const isPWA = window.matchMedia('(display-mode: standalone)').matches;
    
    if (!isPWA) return;
    
    // Проверка: не зависли ли мы в битом состоянии
    const startTime = Date.now();
    
    const checkIfStuck = () => {
      // Если прошло больше 3 секунд, а страница всё ещё не загрузилась
      if (document.readyState !== 'complete' && Date.now() - startTime > 3000) {
        console.warn('PWA stuck detected, forcing recovery');
        
        // Сохраняем accessKey перед чисткой
        const savedKey = localStorage.getItem('accessKey');
        
        // Жёсткая чистка
        sessionStorage.clear();
        
        if (savedKey) {
          localStorage.setItem('accessKey', savedKey);
        }
        
        // Перезагрузка с уникальным параметром
        const url = new URL(window.location.href);
        url.searchParams.set('_recover', Date.now().toString());
        window.location.href = url.toString();
      }
    };
    
    const timer = setTimeout(checkIfStuck, 3500);
    
    // Если загрузились нормально — отменяем таймер
    if (document.readyState === 'complete') {
      clearTimeout(timer);
    } else {
      window.addEventListener('load', () => clearTimeout(timer));
    }
    
    return () => clearTimeout(timer);
  }, []);

  // 🔥 FIX #2: Сброс "битой сессии" при запуске
  useEffect(() => {
    const isPWA = window.matchMedia('(display-mode: standalone)').matches;
    if (!isPWA) return;
    
    // Проверяем уникальный ключ сессии
    const sessionId = sessionStorage.getItem('pwa_session_id');
    const urlSessionId = new URLSearchParams(window.location.search).get('_session');
    
    if (!sessionId) {
      // Первый запуск — создаём ID сессии
      sessionStorage.setItem('pwa_session_id', Date.now().toString());
    } else if (!urlSessionId) {
      // Запуск без параметра сессии — добавляем его и перезагружаем
      // Это заставляет iOS создать "свежий" WebView
      const url = new URL(window.location.href);
      url.searchParams.set('_session', sessionId);
      window.location.replace(url.toString());
    }
  }, []);

  // Минимальное время показа LaunchScreen (1 секунда)
  useEffect(() => {
    const timer = setTimeout(() => setMinTimePassed(true), 1000);
    return () => clearTimeout(timer);
  }, []);

  // Валидация ключа: true – можно пускать, false – ключ неверный
  const validateKey = async (key: string): Promise<boolean> => {
    try {
      apiClient.setAccessKey(key);
      await apiClient.fetch('/esp_service/telemetry');
      return true;
    } catch (error) {
      if (error instanceof AuthError) {
        // 401 – неверный ключ
        clearAccessKey();
        setAuthError('Неверный ключ доступа');
        return false;
      }
      // Ошибка сети, сервер недоступен – не сбрасываем ключ, пропускаем в приложение
      console.warn('Network error during key validation, assuming key is valid', error);
      return true;
    }
  };

  // Проверка ключа при загрузке или его изменении
  useEffect(() => {
    const validate = async () => {
      if (authLoading) return;
      setIsValidating(true);

      if (accessKey) {
        const isValid = await validateKey(accessKey);
        setIsAuthenticated(isValid);
        if (!isValid && !authError) {
          setAuthError('Сессия истекла. Введите ключ заново.');
        } else if (isValid) {
          setAuthError(null);
        }
      } else {
        setIsAuthenticated(false);
      }

      setIsValidating(false);
      setAppReady(true);
    };

    validate();
  }, [accessKey, authLoading]);

  const handleLoginSuccess = () => {
    setIsAuthenticated(true);
    setAuthError(null);
  };

  if (!minTimePassed || !appReady || authLoading || isValidating) {
    return <LaunchScreen />;
  }

  if (!isAuthenticated) {
    return <Login error={authError} onLoginSuccess={handleLoginSuccess} />;
  }

  return (
    <ThemeProvider>
      <Router>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/camera/:cameraId?" element={<CameraPage />} />
          <Route path="/videos" element={<VideosPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Router>
    </ThemeProvider>
  );
}

export default App;