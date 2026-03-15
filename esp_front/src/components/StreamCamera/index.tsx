import React, { useRef, useEffect } from 'react';
import { useCamera } from '../../hooks/useCamera';
import type { Resolution } from '../../api/camera';
import './styles.css';

interface CameraStreamProps {
  cameraId?: string;
  className?: string;
  showControls?: boolean;
}

export const CameraStream: React.FC<CameraStreamProps> = ({
  cameraId = 'cam1',
  className = '',
  showControls = true
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

  return (
    <div className={`camera-container ${className}`}>
      {/* Видео */}
      <div className="camera-viewport">
        {connectionState === 'connected' && (
          <img
            ref={imgRef}
            className="camera-image"
            alt="Camera stream"
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

      {/* Информация (только когда есть сигнал) */}
      {connectionState === 'connected' && status && (
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

      {/* Управление */}
      {showControls && connectionState === 'connected' && (
        <div className="camera-controls">
          <div className="controls-group">
            {resolutions.map(({ value, label }) => (
              <button
                key={value}
                className={`control-btn ${isChangingResolution ? 'disabled' : ''}`}
                onClick={() => {
                  console.log('🖱️ Button clicked:', value);
                  setResolution(value);
                }}
                disabled={isChangingResolution}
              >
                {label}
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