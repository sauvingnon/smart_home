// hooks/useCamera.ts - чистая версия ТОЛЬКО для видео
import { useState, useEffect, useRef } from 'react';
import { apiClient } from '../api/client';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';

interface UseCameraOptions {
  disabled?: boolean;
  onResolutionChange?: () => void; // 👈 Колбэк для родителя
}

export function useCamera(cameraId: string, options: UseCameraOptions = {}) {
  const { disabled = false, onResolutionChange } = options;

  const [frameBlob, setFrameBlob] = useState<Blob | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [isChangingResolution, setIsChangingResolution] = useState(false);
  const [frameStalled, setFrameStalled] = useState(false);

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

    const ws = apiClient.createCameraWebSocket(cameraId, {
      onOpen: () => {
        console.log(`✅ WebSocket opened for camera ${cameraId}`);
        setConnectionState('connected');
        setError(null);
      },
      onFrame: (blob: Blob) => {
        lastFrameTimeRef.current = Date.now();
        setFrameStalled(false);
        setFrameBlob(blob);
      },
      onError: (err: any) => {
        console.error(`❌ WebSocket error for camera ${cameraId}:`, err);
        setConnectionState('error');
        setError('Connection error');
      },
      onClose: (code: number, reason: string) => {
        console.log(`🔌 WebSocket closed for camera ${cameraId}: code=${code}, reason=${reason}`);
        setConnectionState('disconnected');
        setFrameBlob(null);
      }
    });
    
    wsRef.current = ws;

    return () => {
      console.log(`🧹 useCamera: Cleaning up for camera ${cameraId}`);
      
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
  }, [cameraId, disabled]); // 👈 Добавили disabled в зависимости

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
    setResolution
  };
}