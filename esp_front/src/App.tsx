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