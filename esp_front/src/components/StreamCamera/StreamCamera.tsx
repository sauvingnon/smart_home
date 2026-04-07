import React, { useRef, useEffect } from 'react';
import { useCamera } from '../../hooks/useCamera';
import type { Resolution } from '../../api/camera';
import './StreamCamera.css';
import { WifiOff } from 'lucide-react';

interface CameraStreamProps {
  cameraId?: string;
  className?: string;
  showControls?: boolean;
  hideInfo?: boolean;
  disabled?: boolean;
}

export const CameraStream: React.FC<CameraStreamProps> = ({
  cameraId = 'cam1',
  className = '',
  showControls = true,
  hideInfo = false,
  disabled = false
}) => {
  const {
    frameBlob,
    connectionState,
    status,
    error,
    isChangingResolution,
    setResolution
  } = useCamera(cameraId);

  const imgRef = useRef<HTMLImageElement>(null);

  // Обновление изображения при новом кадре
  useEffect(() => {
    if (frameBlob && imgRef.current) {
      const url = URL.createObjectURL(frameBlob);
      imgRef.current.src = url;
      return () => URL.revokeObjectURL(url);
    }
  }, [frameBlob]);

  const resolutions: { value: Resolution; label: string }[] = [
    { value: 'QVGA', label: 'Быстро' },
    { value: 'VGA', label: 'Средне' },
    { value: 'HD', label: 'Качественно' }
  ];

  if (disabled) {
    return (
      <div className={`camera-container ${className}`}>
        <div className="camera-viewport">
          <div className="camera-state disabled">
            <WifiOff size={48} strokeWidth={1.5} />
            <span>Камера отключена</span>
            <span className="disabled-hint">Проверьте подключение камеры</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`camera-container ${className}`}>
      {/* Видео */}
      <div className="camera-viewport">
        {connectionState === 'connected' && (
          <img
            ref={imgRef}
            className="camera-image"
            alt="Поток с камеры"
          />
        )}
        
        {/* Состояния */}
        {connectionState === 'connecting' && (
          <div className="camera-state">
            <div className="spinner" />
            <span>Подключение...</span>
          </div>
        )}
        
        {connectionState === 'disconnected' && (
          <div className="camera-state error">
            <span>📡 Нет сигнала</span>
          </div>
        )}
        
        {connectionState === 'error' && (
          <div className="camera-state error">
            <span>⚠️ {error || 'Ошибка подключения'}</span>
          </div>
        )}
      </div>

      {/* Информация скрывается через проп */}
      {!hideInfo && connectionState === 'connected' && status && (
        <div className="camera-info">
          <span className="info-dot">●</span>
          <span className="info-text">Live</span>
          <span className="info-separator">|</span>
          <span className="info-text">{status.reported_fps || status.fps} fps</span>
          {status.viewers > 0 && (
            <>
              <span className="info-separator">|</span>
              <span className="info-text">👁 {status.viewers}</span>
            </>
          )}
        </div>
      )}

      {/* Управление тоже можно скрыть, но мы его не используем на странице */}
      {showControls && connectionState === 'connected' && (
        <div className="camera-controls">
          <div className="controls-group">
            {(['QVGA', 'VGA', 'HD'] as Resolution[]).map((res) => (
              <button
                key={res}
                className={`control-btn ${isChangingResolution ? 'disabled' : ''}`}
                onClick={() => setResolution(res)}
                disabled={isChangingResolution}
              >
                {res === 'QVGA' && 'Быстро'}
                {res === 'VGA' && 'Средне'}
                {res === 'HD' && 'Качественно'}
              </button>
            ))}
          </div>
          {isChangingResolution && (
            <div className="changing-hint">Смена разрешения...</div>
          )}
        </div>
      )}
    </div>
  );
};