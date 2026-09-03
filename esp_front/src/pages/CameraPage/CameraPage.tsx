import React, { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  ArrowLeft,
  Wifi,
  WifiOff,
  Users,
  Activity,
  Maximize2,
  Minimize2,
  Settings2,
  Check,
  Fan,
  Power,
  Thermometer,
  Lightbulb,
  X
} from 'lucide-react'
import { CameraStream } from '../../components/StreamCamera/StreamCamera'
import { apiClient } from '../../api/client'
import { useNavigate } from 'react-router-dom'
import './CameraPage.css'
import { useTheme } from '../../context/ThemeContext'
import { usePageVisit } from '../../hooks/usePageVisit'

// Раньше это была своя вкладка таб-бара (/camera/:cameraId?) — теперь сюда
// попадают только по кнопке из шапки Видео, камера в доме одна, поэтому id
// стал константой, а не параметром маршрута.
const CAMERA_ID = 'cam1'
type Resolution = 'QVGA' | 'VGA' | 'HD'

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
    fan_mode: number  // 0=off, 1=on-with-camera, 2=auto(>60°C)
    last_metrics_time: string
  }
}

const STATUS_UPDATE_INTERVAL = 5000
const RESOLUTION_CHANGE_DELAY = 1000

export const CameraPage: React.FC = () => {
  usePageVisit('camera')
  const { theme } = useTheme()
  const navigate = useNavigate()
  const [fullscreen, setFullscreen] = useState(false)
  const [isMobile, setIsMobile] = useState(false)
  const [isIOS, setIsIOS] = useState(false)
  const [isPWA, setIsPWA] = useState(false)
  const [cameraStatus, setCameraStatus] = useState<CameraStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [isChangingResolution, setIsChangingResolution] = useState(false)
  const [resolutionError, setResolutionError] = useState(false)
  // 👇 Добавляем локальный стейт для разрешения
  const [selectedResolution, setSelectedResolution] = useState<Resolution>('VGA')

  const [fanMode, setFanMode] = useState<0 | 1 | 2>(1)
  const [isChangingFan, setIsChangingFan] = useState(false)
  const [fanError, setFanError] = useState(false)

  const [isBlinkingLight, setIsBlinkingLight] = useState(false)
  const [lightSkipped, setLightSkipped] = useState(false)
  const [lightError, setLightError] = useState(false)

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

  const fetchStatus = useCallback(async () => {
    try {
      const status = await apiClient.getCameraStatus(CAMERA_ID)
      setCameraStatus(status)

      if (status?.metrics?.quality_mode !== undefined) {
        setSelectedResolution(qualityToResolution(status.metrics.quality_mode))
      }
      if (status?.metrics?.fan_mode !== undefined) {
        setFanMode(status.metrics.fan_mode as 0 | 1 | 2)
      }
    } catch (e) {
      console.error('Failed to fetch camera status:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  // Загружаем статус при монтировании
  useEffect(() => {
    fetchStatus()
    const interval = setInterval(fetchStatus, STATUS_UPDATE_INTERVAL)
    return () => clearInterval(interval)
  }, [fetchStatus])

  const handleFanMode = async (mode: 0 | 1 | 2) => {
    if (isChangingFan) return
    setIsChangingFan(true)
    setFanError(false)
    try {
      await apiClient.setCameraFan(CAMERA_ID, mode)
      setFanMode(mode)
      const status = await apiClient.getCameraStatus(CAMERA_ID)
      if (status?.metrics?.fan_mode !== undefined) {
        setFanMode(status.metrics.fan_mode as 0 | 1 | 2)
      }
    } catch (e) {
      console.error('Failed to set fan mode:', e)
      setFanError(true)
      setTimeout(() => setFanError(false), 3000)
    } finally {
      setIsChangingFan(false)
    }
  }

  const handleLightBlink = async () => {
    if (isBlinkingLight) return
    setIsBlinkingLight(true)
    setLightSkipped(false)
    setLightError(false)
    try {
      const original = await apiClient.getSettings()

      // Ручной режим с обоими выключенными реле — датчики намеренно
      // обесточены (человек хочет полной темноты). Их повторное включение
      // само по себе на ~30с зажжёт свет как побочный эффект старта датчика —
      // этого тут быть не должно, поэтому вообще не трогаем настройки.
      if (original.relayMode && !original.manualDayState && !original.manualNightState) {
        setLightSkipped(true)
        setTimeout(() => setLightSkipped(false), 3000)
        return
      }

      await apiClient.updateSettings({
        ...original,
        relayMode: true,
        manualDayState: false,
        manualNightState: false,
      })

      await new Promise((resolve) => setTimeout(resolve, 2000))

      await apiClient.updateSettings(original)
    } catch (e) {
      console.error('Failed to blink light:', e)
      setLightError(true)
      setTimeout(() => setLightError(false), 3000)
    } finally {
      setIsBlinkingLight(false)
    }
  }

  const handleResolutionChange = async (resolution: Resolution) => {
    if (isChangingResolution) return
    
    setIsChangingResolution(true)
    setResolutionError(false)
    const previousResolution = selectedResolution
    setSelectedResolution(resolution)
    
    // Очищаем предыдущий таймаут
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
    }
    
    try {
      await apiClient.setCameraResolution(CAMERA_ID, resolution)
      
      // Таймаут с проверкой на размонтирование
      timeoutRef.current = window.setTimeout(async () => {
        try {
          const status = await apiClient.getCameraStatus(CAMERA_ID)
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
      setResolutionError(true)
      setTimeout(() => setResolutionError(false), 3000)
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
          
          <button className="back-button" onClick={() => navigate('/videos')} title="Назад к видео">
            <ArrowLeft size={20} />
          </button>

          <div className="camera-title">
            <h1>Камера</h1>
          </div>

          <div className="header-actions">
            <button
              className="header-action-btn"
              onClick={toggleFullscreen}
              title={fullscreen ? 'Обычный режим' : 'Полный экран'}
            >
              {fullscreen ? <Minimize2 size={20} /> : <Maximize2 size={20} />}
            </button>
          </div>
        </motion.div>

        {loading ? (
          <div className="loading-container">
          <div className="loading-card">
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
              {/* Пока открыт simulatedFullscreen (iOS PWA) — поток идёт через второй
                  CameraStream ниже, в оверлее. Этот размонтируем, иначе оба держат
                  свой WebSocket одновременно и сервер считает одного человека за двух зрителей. */}
              {!simulatedFullscreen && (
                <CameraStream
                  cameraId={CAMERA_ID}
                  cameraStatus={cameraStatus?.mode}
                  onFrameStall={fetchStatus}
                />
              )}
            </div>

            {/* Явная кнопка выхода поверх тапа по видео: тап на весь экран
                достаточно для мобильного жеста, но неочевиден сам по себе —
                крестик в углу работает как везде. */}
            <AnimatePresence>
              {fullscreen && (
                <motion.button
                  key="fullscreen-close-btn"
                  type="button"
                  className="fullscreen-close-btn"
                  onClick={() => document.exitFullscreen()}
                  title="Закрыть"
                  aria-label="Закрыть полноэкранный режим"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                >
                  <X size={22} />
                </motion.button>
              )}
            </AnimatePresence>
          </motion.div>

          <motion.div variants={itemVar} className="resolution-section glass-card light-section">
            <div className="section-header">
              <Lightbulb size={24} className="section-icon light-icon" />
              <h2>Подсветка</h2>
            </div>

            <motion.button
              className="light-blink-button"
              onClick={handleLightBlink}
              disabled={isBlinkingLight}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
            >
              <Lightbulb size={20} />
              {isBlinkingLight ? 'Включаю...' : 'Подсветить'}
            </motion.button>

            <AnimatePresence>
              {isBlinkingLight && (
                <motion.div
                  key="light-blinking"
                  className="changing-indicator"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                >
                  <div className="spinner-small" />
                  <span>Свет включится примерно на 30 секунд...</span>
                </motion.div>
              )}

              {lightSkipped && (
                <motion.div
                  key="light-skipped"
                  className="changing-indicator"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                >
                  <span>Свет выключен вручную — не трогаю</span>
                </motion.div>
              )}

              {lightError && (
                <motion.div
                  key="light-error"
                  className="changing-indicator error"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                >
                  <span>Не удалось подсветить — попробуйте ещё раз</span>
                </motion.div>
              )}
            </AnimatePresence>
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
                {([
                  { mode: 1, label: 'С камерой', description: 'Активное охлаждение' },
                  { mode: 2, label: 'Авто', description: 'Вкл при >60°C' },
                  { mode: 0, label: 'Выключить', description: 'Тишина всегда' },
                ] as const).map(({ mode, label, description }) => (
                  <motion.button
                    key={mode}
                    className={`resolution-card ${fanMode === mode ? 'active' : ''}`}
                    onClick={() => handleFanMode(mode)}
                    disabled={isChangingFan}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                  >
                    {fanMode === mode && (
                      <motion.div
                        className="resolution-check"
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        transition={{ type: 'spring', stiffness: 400, damping: 17 }}
                      >
                        <Check size={16} />
                      </motion.div>
                    )}
                    <span className="resolution-label">{label}</span>
                    <span className="resolution-description">{description}</span>
                  </motion.button>
                ))}
              </div>

              <AnimatePresence>
                {isChangingFan && (
                  <motion.div
                    key="fan-changing"
                    className="changing-indicator"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                  >
                    <div className="spinner-small" />
                    <span>Переключение вентилятора...</span>
                  </motion.div>
                )}

                {fanError && (
                  <motion.div
                    key="fan-error"
                    className="changing-indicator error"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                  >
                    <span>Не удалось переключить вентилятор — попробуйте ещё раз</span>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <AnimatePresence>
              {isChangingResolution && (
                <motion.div
                  key="resolution-changing"
                  className="changing-indicator"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                >
                  <div className="spinner-small" />
                  <span>Смена разрешения...</span>
                </motion.div>
              )}

              {resolutionError && (
                <motion.div
                  key="resolution-error"
                  className="changing-indicator error"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                >
                  <span>Не удалось сменить разрешение — попробуйте ещё раз</span>
                </motion.div>
              )}
            </AnimatePresence>
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
                  {cameraStatus?.mode === 'streaming' && 'Стрим'}
                  {cameraStatus?.mode === 'recording' && 'Запись'}
                  {cameraStatus?.mode === 'connected' && 'В сети'}
                  {cameraStatus?.mode === 'offline' && 'Офлайн'}
                  {cameraStatus?.mode === 'never_connected' && 'Не подключена'}
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
              <div className="stat-icon temperature">
                <Thermometer size={24} />
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
    </div>
    {/* Имитация fullscreen для iOS PWA */}
      {simulatedFullscreen && (
        <div className="simulated-fullscreen">
          <div className="simulated-fullscreen-header">
            <button 
              className="simulated-fullscreen-close"
              onClick={closeSimulatedFullscreen}
              title="Закрыть"
              aria-label="Закрыть полноэкранный режим"
            >
              <X size={24} />
            </button>
            <div className="simulated-fullscreen-title">
              Камера
            </div>
            <div className="simulated-fullscreen-placeholder" />
          </div>
          
          <div className="simulated-fullscreen-video">
            <CameraStream
              cameraId={CAMERA_ID}
              cameraStatus={cameraStatus?.mode}
              onFrameStall={fetchStatus}
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