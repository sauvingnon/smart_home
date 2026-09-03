import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import { Login } from './pages/Login/Login';
import HomePage from './pages/HomePage/HomePage';
import { LaunchScreen } from './components/LaunchScreen/LaunchScreen';
import { useEffect, useState } from 'react';
import { apiClient, AuthError } from './api/client';
import SettingsPage from './pages/SettingsPage/SettingsPage';
import ProfilePage from './pages/ProfilePage/ProfilePage';
import { VideosPage } from './pages/VideoPage/VideoPage';
import { CameraPage } from './pages/CameraPage/CameraPage';
import { ChatPage } from './pages/ChatPage/ChatPage';
import { ThemeProvider } from './context/ThemeContext';
import { ChatProvider } from './context/ChatContext';
import { NavBarProvider } from './context/NavBarContext';
import { BottomNavBar } from './components/BottomNavBar/BottomNavBar';

function App() {
  const { accessKey, isLoading: authLoading, resetSession, isAdmin } = useAuth();
  const [appReady, setAppReady] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [minTimePassed, setMinTimePassed] = useState(false);
  const [isValidating, setIsValidating] = useState(true);


  // Минимальное время показа LaunchScreen (1 секунда)
  useEffect(() => {
    const timer = setTimeout(() => setMinTimePassed(true), 1000);
    return () => clearTimeout(timer);
  }, []);

  // Валидация сессии через cookie — ключ больше не нужен
  const validateSession = async (): Promise<boolean> => {
    try {
      await apiClient.fetch('/esp_service/telemetry');
      return true;
    } catch (error) {
      if (error instanceof AuthError) {
        resetSession();
        setAuthError('Сессия истекла. Введите ключ заново.');
        return false;
      }
      // Ошибка сети — не сбрасываем сессию, пропускаем в приложение
      return true;
    }
  };

  useEffect(() => {
    const validate = async () => {
      if (authLoading) return;
      setIsValidating(true);

      if (accessKey) {
        const isValid = await validateSession();
        setIsAuthenticated(isValid);
        if (isValid) setAuthError(null);
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
        <ChatProvider>
          <NavBarProvider>
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/profile" element={<ProfilePage />} />
              <Route path="/videos" element={<VideosPage />} />
              {/* Не в таб-баре — сюда попадают только по кнопке камеры в шапке
                  Видео. Камера в доме одна, поэтому без :cameraId в пути. */}
              <Route path="/videos/camera" element={<CameraPage />} />
              <Route path="/chat" element={isAdmin ? <ChatPage /> : <Navigate to="/" replace />} />
              {/* /chat/settings и /videos/settings больше нет: настройки
                  уведомлений из обоих сведены в /profile. Старые ссылки ловит
                  catch-all ниже. */}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
            {/* Один экземпляр на всё приложение, а не по копии внутри каждой
                страницы. Раньше при переходе между вкладками весь нав-бар
                размонтировался и монтировался заново: layoutId-таблетка не
                имела с чем анимироваться и просто телепортировалась, а слой
                с backdrop-filter пересоздавался на каждой навигации. */}
            <BottomNavBar />
          </NavBarProvider>
        </ChatProvider>
      </Router>
    </ThemeProvider>
  );
}

export default App;