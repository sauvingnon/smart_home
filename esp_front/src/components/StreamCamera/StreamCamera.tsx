import { useEffect, useState, useRef } from 'react';
import { apiClient } from '../../api/client';

interface CameraStreamProps {
  cameraId?: string;
  className?: string;
  fps?: number;
}

type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'error';

export const CameraStream = ({ 
  cameraId = 'cam1', 
  className = 'camera-stream',
  fps = 5 
}: CameraStreamProps) => {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const wsRef = useRef<WebSocket | null>(null);
  const mountedRef = useRef(true);
  const lastFrameTimeRef = useRef(Date.now());

  useEffect(() => {
    mountedRef.current = true;
    
    const ws = apiClient.createCameraWebSocket(cameraId, {
      fps,
      
      onOpen: () => {
        if (mountedRef.current) {
          setConnectionState('connected');
          setErrorMessage('');
          setReconnectAttempt(0);
          lastFrameTimeRef.current = Date.now();
        }
      },
      
      onFrame: (blob) => {
        if (!mountedRef.current) return;
        
        // 1. Логируем размер
        console.log(`📸 Frame received: ${blob.size} bytes`);
        
        // 2. Проверяем первые 4 байта (JPEG signature)
        const reader = new FileReader();
        reader.onload = () => {
          const arr = new Uint8Array(reader.result);
          console.log('First 4 bytes:', Array.from(arr.slice(0, 4)).map(b => '0x' + b.toString(16)).join(' '));
          // Должно быть: 0xFF 0xD8 0xFF 0xE0 или 0xFF 0xD8 0xFF 0xDB и т.д.
        };
        reader.readAsArrayBuffer(blob);
        
        // 3. Пробуем загрузить изображение явно
        const testImg = new Image();
        testImg.onload = () => console.log('✅ Image loaded successfully');
        testImg.onerror = (err) => console.error('❌ Image failed to load', err);
        testImg.src = URL.createObjectURL(blob);
        
        // 4. Если всё ок, обновляем состояние
        const url = URL.createObjectURL(blob);
        setImageUrl(prev => {
          if (prev) URL.revokeObjectURL(prev);
          return url;
        });
        lastFrameTimeRef.current = Date.now();
      },
      
      onClose: (code, reason) => {
        if (!mountedRef.current) return;
        
        if (code === 1006) {
          setConnectionState('disconnected');
          setErrorMessage('Соединение потеряно');
        } else if (code === 1008) {
          setConnectionState('error');
          setErrorMessage('Неверный ключ доступа');
        } else {
          setConnectionState('disconnected');
          setErrorMessage(`Отключено (код ${code})`);
        }
      },
      
      onError: (error) => {
        if (mountedRef.current) {
          setConnectionState('error');
          setErrorMessage('Ошибка соединения');
        }
      }
    });
    
    wsRef.current = ws;
    
    return () => {
      mountedRef.current = false;
      apiClient.closeCameraWebSocket(cameraId);
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [cameraId, fps]);

  // Отслеживаем попытки переподключения
  useEffect(() => {
    if (connectionState === 'reconnecting' || connectionState === 'disconnected') {
      const timer = setTimeout(() => {
        setReconnectAttempt(prev => prev + 1);
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [connectionState]);

  const reconnect = () => {
    setConnectionState('reconnecting');
    setReconnectAttempt(0);
    apiClient.closeCameraWebSocket(cameraId);
    
    // Перезагружаем компонент через useEffect
    setTimeout(() => {
      const ws = apiClient.createCameraWebSocket(cameraId, {
        fps,
        onOpen: () => {
          if (mountedRef.current) {
            setConnectionState('connected');
            setErrorMessage('');
            setReconnectAttempt(0);
          }
        },
        onFrame: (blob) => {
          if (!mountedRef.current) return;
          const url = URL.createObjectURL(blob);
          setImageUrl(prev => {
            if (prev) URL.revokeObjectURL(prev);
            return url;
          });
          lastFrameTimeRef.current = Date.now();
        },
        onClose: (code) => {
          if (mountedRef.current) {
            setConnectionState('disconnected');
            setErrorMessage(`Отключено (код ${code})`);
          }
        },
        onError: () => {
          if (mountedRef.current) {
            setConnectionState('error');
            setErrorMessage('Ошибка соединения');
          }
        }
      });
      wsRef.current = ws;
    }, 500);
  };

  // Проверяем, получали ли мы фреймы в последние 5 секунд
  useEffect(() => {
    const checkFrameTimeout = setInterval(() => {
      if (connectionState === 'connected' && Date.now() - lastFrameTimeRef.current > 5000) {
        setConnectionState('disconnected');
        setErrorMessage('Нет данных от камеры');
      }
    }, 2000);
    
    return () => clearInterval(checkFrameTimeout);
  }, [connectionState]);

  // Состояние: Загрузка
  if (connectionState === 'connecting') {
    return (
      <div className="camera-container camera-loading">
        <div className="camera-spinner">
          <div className="spinner-ring"></div>
          <div className="spinner-ring"></div>
          <div className="spinner-ring"></div>
        </div>
        <p className="camera-status-text">⏳ Подключение...</p>
      </div>
    );
  }

  // Состояние: Переподключение
  if (connectionState === 'reconnecting') {
    return (
      <div className="camera-container camera-reconnecting">
        <div className="camera-spinner">
          <div className="spinner-ring"></div>
          <div className="spinner-ring"></div>
          <div className="spinner-ring"></div>
        </div>
        <p className="camera-status-text">🔄 Переподключение... ({reconnectAttempt + 1}/5)</p>
      </div>
    );
  }

  // Состояние: Ошибка
  if (connectionState === 'error') {
    return (
      <div className="camera-container camera-error">
        <div className="camera-error-content">
          <div className="error-icon">⚠️</div>
          <p className="error-title">Ошибка подключения</p>
          <p className="error-message">{errorMessage}</p>
          <button className="btn-reconnect" onClick={reconnect}>
            Попробовать снова
          </button>
        </div>
      </div>
    );
  }

  // Состояние: Отключено
  if (connectionState === 'disconnected' && !imageUrl) {
    return (
      <div className="camera-container camera-disconnected">
        <div className="camera-error-content">
          <div className="error-icon">🔌</div>
          <p className="error-title">Камера отключена</p>
          <p className="error-message">{errorMessage}</p>
          <button className="btn-reconnect" onClick={reconnect}>
            Переподключиться
          </button>
        </div>
      </div>
    );
  }

  // Состояние: Активное с изображением
  return (
    <div className="camera-container camera-active">
      {imageUrl && (
        <img 
          src={imageUrl} 
          className={`camera-stream ${className}`} 
          alt="Camera stream"
          loading="lazy"
        />
      )}
      
      <div className="camera-overlay">
        <div className={`camera-status-badge ${connectionState}`}>
          <span className="status-indicator"></span>
          <span className="status-text">
            {connectionState === 'connected' && 'В сети'}
            {connectionState === 'disconnected' && 'Отключено'}
          </span>
        </div>
        
        <div className="camera-info">
          <span className="fps-badge">{fps} fps</span>
        </div>
      </div>

      {connectionState === 'disconnected' && (
        <div className="camera-disconnected-overlay">
          <button className="btn-reconnect-small" onClick={reconnect}>
            ↻ Переподключиться
          </button>
        </div>
      )}
    </div>
  );
};

export default CameraStream;