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

  useEffect(() => {
    setConnectionState('connecting');
    
    const ws = apiClient.createCameraWebSocket(cameraId, {
      onOpen: () => {
        setConnectionState('connected');
        setError(null);
      },
      onFrame: (blob: Blob) => {
        setFrameBlob(blob);
      },
      onError: (err: any) => {
        setConnectionState('error');
        setError('Connection error');
      },
      onClose: () => {
        setConnectionState('disconnected');
      }
    });

    const interval = setInterval(async () => {
      try {
        const status = await apiClient.getCameraStatus(cameraId);
        setStatus(status);
      } catch (e) {}
    }, 5000);

    return () => {
      apiClient.closeCameraWebSocket(cameraId);
      clearInterval(interval);
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
        } catch (e) {}
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