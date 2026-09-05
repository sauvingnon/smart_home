import React, { useRef, useEffect, useState } from 'react';
import { useCamera } from '../../hooks/useCamera';
import './StreamCamera.css';
import { WifiOff, Power, Video, Radio, RotateCw } from 'lucide-react';

interface CameraStreamProps {
  cameraId?: string;
  cameraStatus?: string;
  onFrameStall?: () => void;
}

export const CameraStream: React.FC<CameraStreamProps> = ({
  cameraId = 'cam1',
  cameraStatus,
  onFrameStall,
}) => {
  // Пока бэк явно не сказал "streaming"/"connected" — соединяться незачем:
  // во время offline/recording/never_connected сокет всё равно бесполезен.
  // Отдельно про recording: плата при записи держит сокет открытым, но кадры
  // пишет на SD, а не в канал (см. wsTask в my_cam.ino) — то есть открытый
  // вьюер-сокет тут не «почти работает», а не заработает вообще, пока запись
  // не кончится.
  const streamReady = cameraStatus === 'streaming' || cameraStatus === 'connected';

  const {
    frameBlob,
    connectionState,
    frameStalled,
    error,
    reconnect,
  } = useCamera(cameraId, { disabled: !streamReady });

  // Кадры встали, хотя по последнему известному статусу поток должен идти —
  // просим родителя перезапросить статус, не дожидаясь очередного тика опроса.
  // Условием тут раньше было ровно 'streaming', но старт записи камера
  // предваряет stream_state:off, и сервер на этот момент успевает откатить
  // режим в 'connected' — в этом окне стук по статусу как раз и нужен, иначе
  // «идёт запись» доезжает до экрана только следующим поллингом.
  const stalledFiredRef = useRef(false);
  useEffect(() => {
    if (frameStalled && streamReady && !stalledFiredRef.current) {
      stalledFiredRef.current = true;
      onFrameStall?.();
    } else if (!frameStalled) {
      stalledFiredRef.current = false;
    }
  }, [frameStalled, streamReady, onFrameStall]);

  const imgRef = useRef<HTMLImageElement>(null);
  const [hasFrame, setHasFrame] = useState(false);

  // Сбрасываем флаг при потере соединения
  useEffect(() => {
    if (connectionState !== 'connected') setHasFrame(false);
  }, [connectionState]);

  // Обновление изображения при новом кадре
  useEffect(() => {
    if (frameBlob && imgRef.current) {
      const url = URL.createObjectURL(frameBlob);
      imgRef.current.src = url;
      if (!hasFrame) setHasFrame(true);
      return () => URL.revokeObjectURL(url);
    }
  }, [frameBlob]);

  // Функция получения контента для отключенной камеры
  const getDisabledContent = () => {
    switch (cameraStatus) {
      case 'never_connected':
        return {
          icon: <Power size={48} strokeWidth={1.5} />,
          title: 'Камера не подключена',
          hint: 'Камера ни разу не подключалась к системе'
        };
      case 'offline':
        return {
          icon: <WifiOff size={48} strokeWidth={1.5} />,
          title: 'Камера отключена',
          hint: 'Проверьте питание и подключение камеры'
        };
      case 'recording':
        return {
          icon: <Video size={48} strokeWidth={1.5} className="recording-icon" />,
          title: 'Идёт запись',
          hint: 'Стрим недоступен во время записи'
        };
      case undefined:
        // Статус ещё не доехал (или запрос статуса упал) — «камера отключена»
        // тут было бы враньём: мы про неё просто ничего не знаем.
        return {
          icon: <div className="spinner" />,
          title: 'Проверяем камеру',
          hint: 'Запрашиваем текущий статус'
        };
      default:
        return {
          icon: <WifiOff size={48} strokeWidth={1.5} />,
          title: 'Камера недоступна',
          hint: 'Проверьте подключение камеры'
        };
    }
  };

  // Камера не стримит
  if (!streamReady) {
    const content = getDisabledContent();
    return (
      <div className={`camera-container`}>
        <div className="camera-viewport">
          <div className="camera-state disabled">
            {content.icon}
            <span>{content.title}</span>
            <span className="disabled-hint">{content.hint}</span>
          </div>
        </div>
      </div>
    );
  }

 return (
    <div className={`camera-container`}>
      {/* Видео */}
      <div className="camera-viewport">
        {connectionState === 'connected' && (
          <>
            {!hasFrame && (
              <div className="camera-state">
                <div className="spinner" />
                <span>Загружаем поток...</span>
              </div>
            )}
            <img
              ref={imgRef}
              className="camera-image"
              alt=""
              style={{ opacity: hasFrame ? 1 : 0, transition: 'opacity 0.4s ease' }}
            />
          </>
        )}
        
        {/* Состояния подключения */}
        {connectionState === 'connecting' && (
          <div className="camera-state">
            <div className="spinner" />
            <span>Подключение к потоку...</span>
          </div>
        )}
        
        {connectionState === 'disconnected' && (
          <div className="camera-state error">
            <Radio size={32} strokeWidth={1.5} />
            <span>Нет сигнала</span>
            <span className="disabled-hint">Ожидание видеопотока...</span>
          </div>
        )}
        
        {connectionState === 'error' && (
          <div className="camera-state error">
            <span>⚠️ {error || 'Ошибка подключения'}</span>
            <button type="button" className="camera-retry-btn" onClick={reconnect}>
              <RotateCw size={16} />
              Повторить
            </button>
          </div>
        )}
      </div>
    </div>
  );
};