import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw, LogOut } from 'lucide-react';
import { API_BASE_URL } from '../../api/client';
import './ErrorBoundary.css';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

// Раньше любое исключение при рендере (например упавший .toString() на
// undefined из-за неполного ответа бэкенда) роняло всё дерево React молча —
// #root пустел, и пользователь видел белый экран без единой подсказки, даже
// после чистки кэша и переустановки PWA (проблема была не в кэше, а в JS).
// Теперь такое исключение ловится здесь и показывается как текст ошибки.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Необработанная ошибка рендера:', error, info.componentStack);
  }

  // Сбрасывает серверную сессию перед перезагрузкой — на случай, если экран
  // упал из-за протухшей/битой cookie, которая при обычном reload вернёт
  // приложение в то же самое состояние и снова уронит его в тот же белый экран.
  handleResetSession = async () => {
    try {
      await fetch(`${API_BASE_URL}/auth/logout`, { method: 'POST', credentials: 'include' });
    } catch {
      // Не блокируем перезагрузку — хуже, если кнопка ничего не сделает.
    }
    window.location.reload();
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="error-boundary-container">
        <div className="error-boundary-card">
          <AlertTriangle className="error-boundary-icon" />
          <h1 className="error-boundary-title">Приложение упало с ошибкой</h1>
          <p className="error-boundary-message">{error.message || 'Неизвестная ошибка'}</p>
          <div className="error-boundary-actions">
            <button className="error-boundary-button primary" onClick={() => window.location.reload()}>
              <RefreshCw className="button-icon" />
              Перезагрузить
            </button>
            <button className="error-boundary-button secondary" onClick={this.handleResetSession}>
              <LogOut className="button-icon" />
              Сбросить сессию и перезагрузить
            </button>
          </div>
        </div>
      </div>
    );
  }
}
