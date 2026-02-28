import { useAuth } from './context/AuthContext';
import { Login } from './pages/Login/Login';
import HomePage from './pages/HomePage/HomePage';
import { LaunchScreen } from './components/LaunchScreen/LaunchScreen';
import { useEffect, useState } from 'react';
import { apiClient, AuthError } from './api/client';

function App() {
  const { accessKey, isLoading, clearAccessKey } = useAuth();
  const [appReady, setAppReady] = useState(false);
  const [shouldShowLogin, setShouldShowLogin] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [minTimePassed, setMinTimePassed] = useState(false); // 👈 Флаг минимального времени

  // 👇 Засекаем минимальное время показа лаунча (3 секунды)
  useEffect(() => {
    const timer = setTimeout(() => {
      setMinTimePassed(true);
    }, 3000); // 👈 3 секунды, можешь менять
    
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
  }, [accessKey, isLoading]);

  // 👇 Показываем лаунч пока не пройдет минимум 3 секунды ИЛИ пока не готово приложение
  if (!minTimePassed || !appReady) {
    return <LaunchScreen />;
  }

  // Всё готово + прошло 3 секунды - показываем нужный экран
  if (shouldShowLogin) {
    return <Login error={authError} />;
  }

  return <HomePage />;
}

export default App;