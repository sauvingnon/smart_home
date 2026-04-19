import React, { useState, useEffect, useRef, useCallback  } from 'react'
import { motion } from 'framer-motion'
import {
  Camera as CameraIcon,
  Wifi,
  WifiOff,
  Users,
  Activity,
  Maximize2,
  Minimize2,
  RotateCw,
  Settings2,
  Check,
  Fan,
  Power
} from 'lucide-react'
import { CameraStream } from '../../components/StreamCamera/StreamCamera'
import { apiClient } from '../../api/client'
import { useParams } from 'react-router-dom'
import type { Resolution } from '../../api/camera';
import './CameraPage.css'
import { useTheme } from '../../context/ThemeContext'
import { BottomNavBar } from '../../components/BottomNavBar/BottomNavBar';

const containerVar = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.05 } }
}

const itemVar = {
  hidden: { y: 20, opacity: 0 },
  visible: { y: 0, opacity: 1 }
}

interface CameraStatus {
  camera_id: string
  mode: 'never_connected' | 'connected' | 'streaming' | 'recording' | 'offline'
  connected_at: string | null
  last_seen: string
  viewers: number
  metrics: {
    fps: number
    quality_mode: number  // 0=QVGA, 1=VGA, 2=HD
    temperature: number
    is_streaming: boolean
    is_recording: boolean
    is_fan_active: boolean
    last_metrics_time: string
  }
}

const STATUS_UPDATE_INTERVAL = 5000
const RESOLUTION_CHANGE_DELAY = 1000

export const CameraPage: React.FC = () => {
  const { theme } = useTheme()
  const { cameraId } = useParams<{ cameraId: string }>()
  const [fullscreen, setFullscreen] = useState(false)
  const [isMobile, setIsMobile] = useState(false)
  const [isIOS, setIsIOS] = useState(false)
  const [isPWA, setIsPWA] = useState(false)
  const [cameraStatus, setCameraStatus] = useState<CameraStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [isChangingResolution, setIsChangingResolution] = useState(false)
  // 👇 Добавляем локальный стейт для разрешения
  const [selectedResolution, setSelectedResolution] = useState<Resolution>('VGA')

   // 👇 Добавляем локальный стейт для вентилятора (синхронизируется с бэком)
  const [isFanActive, setIsFanActive] = useState(false)
  const [isChangingFan, setIsChangingFan] = useState(false)

  // Состояние для имитации fullscreen на iOS
  const [simulatedFullscreen, setSimulatedFullscreen] = useState(false)

  const videoContainerRef = useRef<HTMLDivElement>(null)
  const timeoutRef = useRef<number>()

  // Маппинг числовых значений из бекенда в наши типы
  const qualityToResolution = (quality?: number): Resolution => {
    if (quality === 0) return 'QVGA'
    if (quality === 2) return 'HD'
    return 'VGA'
  }

  const resolutions: { value: Resolution; label: string; description: string }[] = [
    { value: 'QVGA', label: 'Быстро', description: '320×240' },
    { value: 'VGA', label: 'Средне', description: '640×480' },
    { value: 'HD', label: 'Качественно', description: '1280×720' }
  ]

  useEffect(() => {
    const checkMobile = () => {
      const mobile = window.innerWidth <= 768 || 'ontouchstart' in window
      setIsMobile(mobile)
      
      // Проверка на iOS
      const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as any).MSStream
      setIsIOS(iOS)
      
      // Проверка на PWA режим
      const isStandalone = window.matchMedia('(display-mode: standalone)').matches
      setIsPWA(isStandalone)
    }
    
    checkMobile()
    window.addEventListener('resize', checkMobile)
    window.addEventListener('fullscreenchange', () => {
      setFullscreen(!!document.fullscreenElement)
      if (!document.fullscreenElement) {
        setSimulatedFullscreen(false)
      }
    })
    
    return () => window.removeEventListener('resize', checkMobile)
  }, [])

  // Определяем мобильное устройство
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth <= 768 || 'ontouchstart' in window)
    }
    checkMobile()
    window.addEventListener('resize', checkMobile)
    return () => window.removeEventListener('resize', checkMobile)
  }, [])

  // Слушаем изменения полноэкранного режима
  useEffect(() => {
    const handleFullscreenChange = () => {
      setFullscreen(!!document.fullscreenElement)
    }
    
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])

  // Загружаем статус при монтировании
  useEffect(() => {
    const fetchStatus = async () => {
      try {
        if (!cameraId) return
        const status = await apiClient.getCameraStatus(cameraId)
        setCameraStatus(status)
        
        // 🔧 Разрешение берем из metrics.quality_mode
        if (status?.metrics?.quality_mode !== undefined) {
          setSelectedResolution(qualityToResolution(status.metrics.quality_mode))
        }

        if (status?.metrics?.is_fan_active !== undefined) {
          setIsFanActive(status.metrics.is_fan_active)
        }
        
      } catch (e) {
        console.error('Failed to fetch camera status:', e)
      } finally {
        setLoading(false)
      }
    }

    fetchStatus()
    const interval = setInterval(fetchStatus, STATUS_UPDATE_INTERVAL)
    return () => clearInterval(interval)
  }, [cameraId])

  const handleFanToggle = async (newState: boolean) => {
    if (isChangingFan || !cameraId) return
    
    setIsChangingFan(true)
    
    try {
      await apiClient.setCameraFan(cameraId, newState)
      setIsFanActive(newState)
      
      // Запросить свежий статус
      const status = await apiClient.getCameraStatus(cameraId)
      if (status?.metrics?.is_fan_active !== undefined) {
        setIsFanActive(status.metrics.is_fan_active)
      }
    } catch (e) {
      console.error('Failed to toggle fan:', e)
    } finally {
      setIsChangingFan(false)
    }
  }

  const handleResolutionChange = async (resolution: Resolution) => {
    if (isChangingResolution || !cameraId) return
    
    setIsChangingResolution(true)
    const previousResolution = selectedResolution
    setSelectedResolution(resolution)
    
    // Очищаем предыдущий таймаут
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
    }
    
    try {
      await apiClient.setCameraResolution(cameraId, resolution)
      
      // Таймаут с проверкой на размонтирование
      timeoutRef.current = window.setTimeout(async () => {
        try {
          const status = await apiClient.getCameraStatus(cameraId)
          // Проверяем, что компонент все еще жив
          if (timeoutRef.current) {
            setCameraStatus(status)
            if (status?.metrics?.quality_mode !== undefined) {
              setSelectedResolution(qualityToResolution(status.metrics.quality_mode))
            }
          }
        } finally {
          setIsChangingResolution(false)
          timeoutRef.current = undefined
        }
      }, RESOLUTION_CHANGE_DELAY)
      
    } catch (e) {
      console.error('Failed to change resolution:', e)
      setSelectedResolution(previousResolution)
      setIsChangingResolution(false)
    }
  }

  // Очистка таймаута при размонтировании
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [])

  // Имитация fullscreen для iOS PWA
  const toggleSimulatedFullscreen = useCallback(() => {
    if (!videoContainerRef.current) return
    
    if (!simulatedFullscreen) {
      // Включаем имитацию
      setSimulatedFullscreen(true)
      // Прячем body scroll
      document.body.style.overflow = 'hidden'
    } else {
      // Выключаем имитацию
      setSimulatedFullscreen(false)
      document.body.style.overflow = ''
    }
  }, [simulatedFullscreen])

  const toggleFullscreen = () => {
    // На iOS PWA не поддерживает нормальный fullscreen
    if (isIOS && isPWA) {
      toggleSimulatedFullscreen()
      return
    }
    
    // На остальных устройствах используем стандартный fullscreen
    if (!videoContainerRef.current) return
    
    if (!document.fullscreenElement) {
      videoContainerRef.current.requestFullscreen()
    } else {
      document.exitFullscreen()
    }
  }

  const handleVideoTap = () => {
    if (!videoContainerRef.current) return
    
    if (isMobile) {
      if (isIOS && isPWA) {
        toggleSimulatedFullscreen()
      } else if (fullscreen) {
        document.exitFullscreen()
      } else {
        videoContainerRef.current.requestFullscreen()
      }
    }
  }

  const closeSimulatedFullscreen = () => {
    setSimulatedFullscreen(false)
    document.body.style.overflow = ''
  }

  return (
    <>
    <div className={`camera-page ${theme}`}>
      {/* Фоновые пятна */}
      <div className="background-spot">
        <div className="spot-1"></div>
        <div className="spot-2"></div>
        <div className="spot-3"></div>
      </div>

      <div className="camera-page-container">
        {/* Хедер */}
        <motion.div 
          className="camera-header glass-card"
          initial={{ y: -20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
        >
          
          <div className="camera-title">
            <CameraIcon size={24} className="title-icon" />
            <h1>Камера {cameraId}</h1>
          </div>

          <div className="header-actions">
            <button 
              className="header-action-btn"
              onClick={toggleFullscreen}
              title={fullscreen ? 'Обычный режим' : 'Полный экран'}
            >
              {fullscreen ? <Minimize2 size={20} /> : <Maximize2 size={20} />}
            </button>
            <button 
              className="header-action-btn"
              onClick={() => window.location.reload()}
              title="Перезагрузить"
            >
              <RotateCw size={20} />
            </button>
          </div>
        </motion.div>

        {loading ? (
          <div className="loading-container">
          <div className="loading-card glass-card">
            <div className="spinner" />
            <p className="loading-text">Загрузка камеры...</p>
          </div>
        </div>
        ) : (
        <>
        {/* Основной контент */}
        <motion.div 
          className="camera-main"
          variants={containerVar}
          initial="hidden"
          animate="visible"
        >
          {/* Видеопоток */}
          <motion.div variants={itemVar} className="camera-stream-wrapper glass-card" ref={videoContainerRef}>
            <div className="video-tap-area" onClick={handleVideoTap}>
              <CameraStream 
                cameraId={cameraId}
                showControls={false}
                hideInfo={true}
                disabled={cameraStatus?.mode !== 'streaming'}
              />
            </div>

            {isMobile && fullscreen && (
              <motion.div 
                className="mobile-exit-hint"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
              >
                <span>
                  {fullscreen ? '👆 Нажмите для выхода' : '👆 Нажмите на видео для полноэкранного режима'}
                </span>
              </motion.div>
            )}
          </motion.div>

          <motion.div variants={itemVar} className="resolution-section glass-card">
            <div className="section-header">
              <Settings2 size={24} className="section-icon" />
              <h2>Управление</h2>
            </div>

            {/* Блок разрешения */}
            <div className="resolution-grid">
              {resolutions.map(({ value, label, description }) => (
                <motion.button
                  key={value}
                  className={`resolution-card ${selectedResolution === value ? 'active' : ''}`}
                  onClick={() => handleResolutionChange(value)}
                  disabled={isChangingResolution}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                >
                  {selectedResolution === value && (
                    <motion.div 
                      className="resolution-check"
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      transition={{ type: "spring", stiffness: 400, damping: 17 }}
                    >
                      <Check size={16} />
                    </motion.div>
                  )}
                  <span className="resolution-label">{label}</span>
                  <span className="resolution-description">{description}</span>
                </motion.button>
              ))}
            </div>

            {/* 👇 Блок управления вентилятором в стиле разрешения */}
            <div className="fan-section">
              <div className="section-header">
                <Fan size={24} className="section-icon" />
                <h2>Вентилятор охлаждения</h2>
              </div>

              <div className="resolution-grid">
                <motion.button
                  className={`resolution-card ${isFanActive ? 'active' : ''}`}
                  onClick={() => handleFanToggle(true)}
                  disabled={isChangingFan}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                >
                  {isFanActive && (
                    <motion.div 
                      className="resolution-check"
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      transition={{ type: "spring", stiffness: 400, damping: 17 }}
                    >
                      <Check size={16} />
                    </motion.div>
                  )}
                  <span className="resolution-label">Включить</span>
                  <span className="resolution-description">Активное охлаждение</span>
                </motion.button>

                <motion.button
                  className={`resolution-card ${!isFanActive ? 'active' : ''}`}
                  onClick={() => handleFanToggle(false)}
                  disabled={isChangingFan}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                >
                  {!isFanActive && (
                    <motion.div 
                      className="resolution-check"
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      transition={{ type: "spring", stiffness: 400, damping: 17 }}
                    >
                      <Check size={16} />
                    </motion.div>
                  )}
                  <span className="resolution-label">Выключить</span>
                  <span className="resolution-description">Тишина всегда</span>
                </motion.button>
              </div>

              {isChangingFan && (
                <motion.div 
                  className="changing-indicator"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                >
                  <div className="spinner-small" />
                  <span>Переключение вентилятора...</span>
                </motion.div>
              )}
            </div>

            {isChangingResolution && (
              <motion.div 
                className="changing-indicator"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
              >
                <div className="spinner-small" />
                <span>Смена разрешения...</span>
              </motion.div>
            )}
          </motion.div>

           {/* Статистика камеры */}
          <motion.div variants={itemVar} className="camera-stats-grid">
            <div className="stat-card glass-card">
              <div className="stat-icon wifi">
                {cameraStatus?.mode === 'never_connected' || cameraStatus?.mode === 'offline' ? 
                  <WifiOff size={24} /> : <Wifi size={24} />}
              </div>
              <div className="stat-info">
                <span className="stat-label">Статус</span>
                <span className={`stat-value ${cameraStatus?.mode !== 'never_connected' && cameraStatus?.mode !== 'offline' ? 'connected' : 'disconnected'}`}>
                  {cameraStatus?.mode === 'streaming' && '📹 Стрим'}
                  {cameraStatus?.mode === 'recording' && '🔴 Запись'}
                  {cameraStatus?.mode === 'connected' && '✅ В сети'}
                  {cameraStatus?.mode === 'offline' && '❌ Офлайн'}
                  {cameraStatus?.mode === 'never_connected' && '🔌 Не подключена'}
                </span>
              </div>
            </div>

            <div className="stat-card glass-card">
              <div className="stat-icon fps">
                <Activity size={24} />
              </div>
              <div className="stat-info">
                <span className="stat-label">FPS</span>
                <span className="stat-value">
                  {cameraStatus?.metrics?.fps || 0}
                </span>
              </div>
            </div>

            <div className="stat-card glass-card">
              <div className="stat-icon viewers">
                <Users size={24} />
              </div>
              <div className="stat-info">
                <span className="stat-label">Температура</span>
                <span className="stat-value">
                  {cameraStatus?.metrics?.temperature?.toFixed(1) || '—'}°C
                </span>
              </div>
            </div>

            <div className="stat-card glass-card">
              <div className="stat-icon viewers">
                <Users size={24} />
              </div>
              <div className="stat-info">
                <span className="stat-label">Зрители</span>
                <span className="stat-value">
                  {cameraStatus?.viewers || 0}
                </span>
              </div>
            </div>
          </motion.div>
        </motion.div>
        </>
        )}
      </div>
      <BottomNavBar />
    </div>
    {/* Имитация fullscreen для iOS PWA */}
      {simulatedFullscreen && (
        <div className="simulated-fullscreen">
          <div className="simulated-fullscreen-header">
            <button 
              className="simulated-fullscreen-close"
              onClick={closeSimulatedFullscreen}
            >
              <Minimize2 size={24} />
            </button>
            <div className="simulated-fullscreen-title">
              Камера {cameraId}
            </div>
            <div className="simulated-fullscreen-placeholder" />
          </div>
          
          <div className="simulated-fullscreen-video">
            <CameraStream 
              cameraId={cameraId}
              showControls={false}
              hideInfo={true}
              disabled={cameraStatus?.mode === 'never_connected'}
            />
          </div>
          
          <div className="simulated-fullscreen-footer">
            <span className="exit-hint">👆 Нажмите на видео для выхода</span>
          </div>
        </div>
      )}
    </>
  )
}