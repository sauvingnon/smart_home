// hooks/useCamera.ts
import { useState, useEffect, useRef } from 'react';
import { apiClient } from '../api/client';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';

export function useCamera(cameraId: string) {
  const [frameBlob, setFrameBlob] = useState<Blob | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<any>(null);
  const [isChangingResolution, setIsChangingResolution] = useState(false);
  
  // Используем ref для хранения WebSocket, чтобы можно было закрыть при размонтировании
  const wsRef = useRef<WebSocket | null>(null);
  const intervalRef = useRef<number | null>(null); // 👈 number вместо NodeJS.Timeout

  useEffect(() => {
    setConnectionState('connecting');
    setError(null);
    
    console.log(`📹 useCamera: Mounting/updating for camera ${cameraId}`);
    
    const ws = apiClient.createCameraWebSocket(cameraId, {
      onOpen: () => {
        console.log(`✅ WebSocket opened for camera ${cameraId}`);
        setConnectionState('connected');
        setError(null);
      },
      onFrame: (blob: Blob) => {
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
      }
    });
    
    wsRef.current = ws;

    // Статус обновляем раз в 5 секунд
    const interval = window.setInterval(async () => { // 👈 явно используем window.setInterval
      try {
        const status = await apiClient.getCameraStatus(cameraId);
        setStatus(status);
      } catch (e) {
        console.error('Failed to fetch status:', e);
      }
    }, 5000);
    
    intervalRef.current = interval;

    // ✅ КЛЮЧЕВОЙ МОМЕНТ: cleanup при размонтировании
    return () => {
      console.log(`🧹 useCamera: Cleaning up for camera ${cameraId} - closing WebSocket and stopping intervals`);
      
      // Останавливаем интервал статуса
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      
      // Закрываем WebSocket соединение
      if (wsRef.current) {
        // Проверяем, что сокет еще открыт
        if (wsRef.current.readyState === WebSocket.OPEN || 
            wsRef.current.readyState === WebSocket.CONNECTING) {
          console.log(`🔌 Actively closing WebSocket for camera ${cameraId}`);
          apiClient.closeCameraWebSocket(cameraId);
        }
        wsRef.current = null;
      }
      
      setFrameBlob(null);
      setConnectionState('disconnected');
    };
  }, [cameraId]);

  const setResolution = async (resolution: 'QVGA' | 'VGA' | 'HD') => {
    console.log('🎯 useCamera.setResolution called:', { resolution, cameraId });
    setIsChangingResolution(true);
    
    try {
        console.log('📤 Calling apiClient.setCameraResolution...');
        await apiClient.setCameraResolution(cameraId, resolution);
        console.log('✅ apiClient.setCameraResolution completed');
        
        setTimeout(async () => {
          try {
            const status = await apiClient.getCameraStatus(cameraId);
            setStatus(status);
          } catch (e) {
            console.error('Failed to update status after resolution change:', e);
          }
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
    error, 
    status, 
    isChangingResolution, 
    setResolution 
  };
}