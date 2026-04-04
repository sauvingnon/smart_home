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

function App() {
  const { accessKey, isLoading, clearAccessKey } = useAuth();
  const [appReady, setAppReady] = useState(false);
  const [shouldShowLogin, setShouldShowLogin] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [minTimePassed, setMinTimePassed] = useState(false);

  // 👇 Засекаем минимальное время показа лаунча (1 секунда)
  useEffect(() => {
    const timer = setTimeout(() => {
      setMinTimePassed(true);
    }, 1000);

    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const initializeApp = async () => {
      // Ждем пока AuthContext загрузит ключ из localStorage
      if (isLoading) return;

      // Если есть ключ - валидируем
      if (accessKey) {
        apiClient.setAccessKey(accessKey);

        try {
          await apiClient.fetch('/esp_service/telemetry');
          // Валидация успешна - покажем HomePage
          setShouldShowLogin(false);
        } catch (error) {
          if (error instanceof AuthError) {
            clearAccessKey();
            setAuthError('Неверный ключ доступа');
            setShouldShowLogin(true);
          }
        }
      } else {
        // Нет ключа - покажем Login
        setShouldShowLogin(true);
      }

      // Говорим что всё готово к показу
      setAppReady(true);
    };

    initializeApp();
  }, [accessKey, isLoading, clearAccessKey]);

  // Показываем LaunchScreen пока не прошло минимальное время или не готова инициализация
  if (!minTimePassed || !appReady) {
    return <LaunchScreen />;
  }

  // Показываем Login если нет валидного ключа
  if (shouldShowLogin) {
    return <Login error={authError} />;
  }

  return (
    <Router>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/camera/:cameraId?" element={<CameraPage />} />
        <Route path="/videos" element={<VideosPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Router>
  );
}

export default App;