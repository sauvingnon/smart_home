import { useEffect, useState } from 'react';
import { apiClient } from '../../api/client';

export const CameraStream = ({ cameraId = 'cam1', className = 'camera-stream' }) => {
  const [imageUrl, setImageUrl] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let mounted = true;
    
    const fetchFrame = async () => {
      try {
        // Используем last_frame вместо stream
        const response = await apiClient.fetchRaw(`/esp_service/last_frame/${cameraId}`);
        const blob = await response.blob();
        
        if (mounted) {
          const url = URL.createObjectURL(blob);
          setImageUrl(prev => {
            if (prev) URL.revokeObjectURL(prev);
            return url;
          });
          setError(false);
        }
      } catch (err) {
        console.error('Camera error:', err);
        if (mounted) setError(true);
      }
    };

    fetchFrame();
    const interval = setInterval(fetchFrame, 200); // 5 fps

    return () => {
      mounted = false;
      clearInterval(interval);
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [cameraId]);

  if (error) return <div>❌ Камера не работает</div>;
  if (!imageUrl) return <div>⏳ Загрузка...</div>;

  return <img src={imageUrl} className={className} alt="camera" />;
};

export default CameraStream;