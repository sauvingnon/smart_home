import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { Key, LogIn, AlertCircle, Loader } from 'lucide-react';
import styles from './Login.module.css';

interface LoginProps {
  error?: string | null;
  onLoginSuccess?: () => void; // Добавляем колбэк успешного входа
}

export const Login: React.FC<LoginProps> = ({ error, onLoginSuccess }) => {
  const [key, setKey] = useState('');
  const [localError, setLocalError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const { setAccessKey } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!key.trim()) {
      setLocalError('Введите ключ доступа');
      return;
    }

    setIsLoading(true);
    setLocalError('');

    try {
      // Старый ключ специально НЕ сбрасываем: /auth/login перезаписывает cookie
      // безусловно. Прежний вызов clearAccessKey() уходил параллельно, без await,
      // и его Set-Cookie с Max-Age=0 мог прийти уже ПОСЛЕ ответа логина — стирая
      // только что выданную сессию и роняя вход с "Сессия истекла".
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

  return (
    <div className={styles.loginContainer}>
      <div className={styles.loginCard}>
        <div className={styles.loginHeader}>
          <Key className={styles.loginIcon} />
          <h1 className={styles.loginTitle}>Доступ к управлению</h1>
        </div>

        <div className={styles.loginContent}>
          {error && (
            <div className={styles.errorMessage}>
              <AlertCircle className={styles.errorIcon} />
              <p className={styles.errorText}>{error}</p>
            </div>
          )}

          <form onSubmit={handleSubmit} className={styles.loginForm}>
            <div className={styles.formGroup}>
              <label className={styles.formLabel}>
                Введите ключ доступа
              </label>
              <input
                type="password"
                value={key}
                onChange={(e) => {
                  setKey(e.target.value);
                  setLocalError('');
                }}
                placeholder="например: abc123..."
                className={styles.formInput}
                autoFocus
                disabled={isLoading}
              />
              {localError && (
                <p className={styles.formError}>{localError}</p>
              )}
            </div>

            <button
              type="submit"
              className={styles.submitButton}
              disabled={isLoading}
            >
              {isLoading ? (
                <>
                  <Loader className={`${styles.buttonIcon} ${styles.spinning}`} />
                  Проверка ключа...
                </>
              ) : (
                <>
                  <LogIn className={styles.buttonIcon} />
                  Войти
                </>
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};
