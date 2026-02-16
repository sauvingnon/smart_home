import { useAuth } from './context/AuthContext';
import { Login } from './pages/Login';
import HomePage from './pages/HomePage';
import { useEffect, useState } from 'react';
import { apiClient, AuthError } from './api/client';

function App() {
  const { accessKey, isLoading, clearAccessKey } = useAuth();
  const [isValidating, setIsValidating] = useState(true);
  const [isValid, setIsValid] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null); // 👈 Добавили

  useEffect(() => {
    if (accessKey) {
      apiClient.setAccessKey(accessKey);
      
      const validateKey = async () => {
        try {
          await apiClient.fetch('/esp_service/telemetry');
          setIsValid(true);
          setAuthError(null); // 👈 Очищаем ошибку при успехе
        } catch (error) {
          if (error instanceof AuthError) {
            clearAccessKey();
            setAuthError('Неверный ключ доступа'); // 👈 Устанавливаем ошибку
          }
        } finally {
          setIsValidating(false);
        }
      };
      
      validateKey();
    } else {
      setIsValidating(false);
      setIsValid(false);
    }
  }, [accessKey]);

  if (isLoading || isValidating) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!accessKey || !isValid) {
    return <Login error={authError} />; // 👈 Передаем ошибку
  }

  return <HomePage />;
}

export default App;