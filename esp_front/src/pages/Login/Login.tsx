import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { Key, LogIn, AlertCircle } from 'lucide-react';
import './Login.css'; // создадим файл со стилями

interface LoginProps {
  error?: string | null;
}

export const Login: React.FC<LoginProps> = ({ error }) => {
  const [key, setKey] = useState('');
  const [localError, setLocalError] = useState('');
  const { setAccessKey } = useAuth();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!key.trim()) {
      setLocalError('Введите ключ доступа');
      return;
    }
    
    setAccessKey(key.trim());
  };

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
              />
              {localError && (
                <p className="form-error">{localError}</p>
              )}
            </div>
            
            <button type="submit" className="submit-button">
              <LogIn className="button-icon" />
              Войти
            </button>
            
            <p className="form-footer">
              Ключ можно получить в боте @my_tiny_smart_house_bot командой /getkey
            </p>
          </form>
        </div>
      </div>
    </div>
  );
};