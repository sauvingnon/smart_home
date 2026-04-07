import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { Key, LogIn, AlertCircle, Send, Loader } from 'lucide-react';
import './Login.css';

interface LoginProps {
  error?: string | null;
  onLoginSuccess?: () => void; // Добавляем колбэк успешного входа
}

export const Login: React.FC<LoginProps> = ({ error, onLoginSuccess }) => {
  const [key, setKey] = useState('');
  const [localError, setLocalError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const { setAccessKey, clearAccessKey } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!key.trim()) {
      setLocalError('Введите ключ доступа');
      return;
    }
    
    setIsLoading(true);
    setLocalError('');
    
    try {
      // Сначала очищаем старый ключ, если есть
      clearAccessKey();
      
      // Устанавливаем новый ключ
      await setAccessKey(key.trim());
      
      // Если есть колбэк успешного входа, вызываем его
      if (onLoginSuccess) {
        onLoginSuccess();
      }
    } catch (err) {
      setLocalError('Ошибка при проверке ключа. Попробуйте снова.');
      console.error('Login error:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const telegramLink = "https://t.me/my_tiny_smart_house_bot";

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-header">
          <Key className="login-icon" />
          <h1 className="login-title">Доступ к управлению</h1>
        </div>
        
        <div className="login-content">
          {error && (
            <div className="error-message">
              <AlertCircle className="error-icon" />
              <p className="error-text">{error}</p>
            </div>
          )}

          <form onSubmit={handleSubmit} className="login-form">
            <div className="form-group">
              <label className="form-label">
                Введите ключ доступа
              </label>
              <input
                type="text"
                value={key}
                onChange={(e) => {
                  setKey(e.target.value);
                  setLocalError('');
                }}
                placeholder="например: abc123..."
                className="form-input"
                autoFocus
                disabled={isLoading}
              />
              {localError && (
                <p className="form-error">{localError}</p>
              )}
            </div>
            
            <button 
              type="submit" 
              className="submit-button"
              disabled={isLoading}
            >
              {isLoading ? (
                <>
                  <Loader className="button-icon spinning" />
                  Проверка ключа...
                </>
              ) : (
                <>
                  <LogIn className="button-icon" />
                  Войти
                </>
              )}
            </button>
            
            <div className="telegram-footer">
              <div className="telegram-divider">
                <span className="divider-text">или</span>
              </div>
              <a 
                href={telegramLink}
                target="_blank"
                rel="noopener noreferrer"
                className="telegram-button"
              >
                <Send className="telegram-icon" />
                Получить ключ в Telegram
              </a>
              <p className="telegram-hint">
                Напишите <strong>/getkey</strong> в боте
              </p>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};