// hooks/useCamera.ts - чистая версия ТОЛЬКО для видео
import { useState, useEffect, useRef } from 'react';
import { apiClient } from '../api/client';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';

interface UseCameraOptions {
  disabled?: boolean;
  onResolutionChange?: () => void; // 👈 Колбэк для родителя
}

// Если handshake молча зависает (прокси/файрвол держат соединение, не роняя
// его) — onOpen/onError/onClose сокета могут не сработать вообще никогда.
// Без этого таймаута UI виснет на "Подключение к потоку..." навечно.
const CONNECT_TIMEOUT_MS = 10000;

export function useCamera(cameraId: string, options: UseCameraOptions = {}) {
  const { disabled = false, onResolutionChange } = options;

  const [frameBlob, setFrameBlob] = useState<Blob | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [isChangingResolution, setIsChangingResolution] = useState(false);
  const [frameStalled, setFrameStalled] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const lastFrameTimeRef = useRef<number>(0);

  // Детектор зависших кадров: если connected но кадров нет >2с — стал
  useEffect(() => {
    if (connectionState !== 'connected') {
      setFrameStalled(false);
      return;
    }
    lastFrameTimeRef.current = Date.now(); // сбрасываем при (ре)коннекте
    const interval = setInterval(() => {
      const age = lastFrameTimeRef.current ? Date.now() - lastFrameTimeRef.current : Infinity;
      setFrameStalled(age > 2000);
    }, 500);
    return () => clearInterval(interval);
  }, [connectionState]);

  useEffect(() => {
    // Если disabled - даже не пытаемся подключиться
    if (disabled) {
      setConnectionState('disconnected');
      setFrameBlob(null);
      return;
    }

    setConnectionState('connecting');
    setError(null);

    console.log(`📹 useCamera: Connecting for camera ${cameraId}`);

    let settled = false;
    const connectTimeout = window.setTimeout(() => {
      if (settled) return;
      console.warn(`⏱️ WebSocket connect timeout for camera ${cameraId}`);
      settled = true;
      apiClient.closeCameraWebSocket(cameraId);
      setConnectionState('error');
      setError('Сервер не отвечает');
    }, CONNECT_TIMEOUT_MS);

    const ws = apiClient.createCameraWebSocket(cameraId, {
      onOpen: () => {
        console.log(`✅ WebSocket opened for camera ${cameraId}`);
        settled = true;
        clearTimeout(connectTimeout);
        setConnectionState('connected');
        setError(null);
      },
      onMessage: (data: string) => {
        if (data === 'pong' || data === 'AUTH_OK') return;
        if (data.startsWith('ERROR:')) {
          console.warn(`⚠️ Server message for camera ${cameraId}: ${data}`);
          settled = true;
          clearTimeout(connectTimeout);
          setConnectionState('error');
          setError(data.slice('ERROR:'.length).trim() || 'Ошибка потока');
        }
      },
      onFrame: (blob: Blob) => {
        lastFrameTimeRef.current = Date.now();
        setFrameStalled(false);
        setFrameBlob(blob);
      },
      onError: (err: any) => {
        console.error(`❌ WebSocket error for camera ${cameraId}:`, err);
        settled = true;
        clearTimeout(connectTimeout);
        setConnectionState('error');
        setError('Connection error');
      },
      onClose: (code: number, reason: string) => {
        console.log(`🔌 WebSocket closed for camera ${cameraId}: code=${code}, reason=${reason}`);
        setConnectionState((prev) => (prev === 'error' ? prev : 'disconnected'));
        setFrameBlob(null);
      },
    });

    wsRef.current = ws;

    return () => {
      console.log(`🧹 useCamera: Cleaning up for camera ${cameraId}`);
      clearTimeout(connectTimeout);

      if (wsRef.current) {
        if (wsRef.current.readyState === WebSocket.OPEN ||
            wsRef.current.readyState === WebSocket.CONNECTING) {
          apiClient.closeCameraWebSocket(cameraId);
        }
        wsRef.current = null;
      }

      setFrameBlob(null);
      setConnectionState('disconnected');
    };
  }, [cameraId, disabled, retryKey]); // 👈 retryKey — форсированный ручной reconnect

  const reconnect = () => {
    apiClient.closeCameraWebSocket(cameraId);
    setRetryKey((k) => k + 1);
  };

  // Телефон разблокировали — не ждём, пока браузер сам заметит мёртвый
  // сокет (может тянуться долго), а сразу форсируем реконнект. Дебаунс —
  // чтобы серия visibilitychange (быстрое переключение между табами/аппами)
  // не долбила сервер новыми соединениями поверх уже идущего реконнекта.
  const connectionStateRef = useRef(connectionState);
  useEffect(() => {
    connectionStateRef.current = connectionState;
  }, [connectionState]);

  useEffect(() => {
    if (disabled) return;
    let lastForceReconnect = 0;
    const handleVisibility = () => {
      const now = Date.now();
      if (
        document.visibilityState === 'visible' &&
        connectionStateRef.current !== 'connected' &&
        now - lastForceReconnect > 5000
      ) {
        lastForceReconnect = now;
        reconnect();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [disabled, cameraId]);

  const setResolution = async (resolution: 'QVGA' | 'VGA' | 'HD') => {
    console.log('🎯 useCamera.setResolution called:', { resolution, cameraId });
    setIsChangingResolution(true);
    
    try {
      await apiClient.setCameraResolution(cameraId, resolution);
      console.log('✅ Resolution changed successfully');
      
      // 👈 Просто вызываем колбэк, а не запрашиваем статус
      onResolutionChange?.();
      
      setTimeout(() => {
        setIsChangingResolution(false);
      }, 1000);
      
    } catch (e) {
      console.error('❌ Failed to change resolution:', e);
      setError('Failed to change resolution');
      setIsChangingResolution(false);
    }
  };

  return {
    frameBlob,
    connectionState,
    frameStalled,
    error,
    isChangingResolution,
    setResolution,
    reconnect
  };
}