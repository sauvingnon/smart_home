import { useCallback, useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Lightbulb, Minimize2, Play, Wifi, WifiOff } from 'lucide-react'
import { CameraStream } from '../../components/StreamCamera/StreamCamera'
import { apiClient } from '../../api/client'
import './LiveCamera.css'

type Resolution = 'QVGA' | 'VGA' | 'HD'

const CAMERA_ID = 'cam1'
const STATUS_INTERVAL = 5000

type CameraStatus = {
  mode: 'never_connected' | 'connected' | 'streaming' | 'recording' | 'offline'
  viewers: number
  metrics: {
    fps: number
    quality_mode: number
    temperature: number
  }
}

const RESOLUTIONS: { value: Resolution; label: string }[] = [
  { value: 'QVGA', label: 'Быстро' },
  { value: 'VGA', label: 'Средне' },
  { value: 'HD', label: 'Чётко' },
]

const qualityToResolution = (quality?: number): Resolution => {
  if (quality === 0) return 'QVGA'
  if (quality === 2) return 'HD'
  return 'VGA'
}

const MODE_LABEL: Record<CameraStatus['mode'], string> = {
  streaming: 'В сети',
  connected: 'В сети',
  recording: 'Запись',
  offline: 'Офлайн',
  never_connected: 'Не подключена',
}

/**
 * Живой поток на странице «Видео»: карточка «Сейчас» и полноэкранный плеер.
 *
 * Раньше это была отдельная вкладка /camera, где вперемешку лежали поток и
 * сервисные настройки платы. Настройки уехали в Управление → Камера, а поток
 * встал сюда, к записям с той же камеры.
 *
 * Полноэкранный режим — свой оверлей, а не Fullscreen API: в iOS PWA он
 * недоступен, и на прошлой странице ради этого держалась ручная эмуляция
 * параллельно с настоящим фуллскрином. Здесь только оверлей, зато один.
 */
export const LiveCamera = () => {
  const [status, setStatus] = useState<CameraStatus | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [resolution, setResolution] = useState<Resolution>('VGA')
  const [changingResolution, setChangingResolution] = useState(false)
  const [blinking, setBlinking] = useState(false)
  const [lightNote, setLightNote] = useState<string | null>(null)
  const noteTimerRef = useRef<number | undefined>(undefined)

  const fetchStatus = useCallback(async () => {
    try {
      const res = await apiClient.getCameraStatus(CAMERA_ID)
      setStatus(res)
      if (res?.metrics?.quality_mode !== undefined && !changingResolution) {
        setResolution(qualityToResolution(res.metrics.quality_mode))
      }
    } catch (e) {
      console.error('Camera status failed:', e)
    }
  }, [changingResolution])

  useEffect(() => {
    fetchStatus()
    const interval = setInterval(fetchStatus, STATUS_INTERVAL)
    return () => clearInterval(interval)
  }, [fetchStatus])

  useEffect(() => () => window.clearTimeout(noteTimerRef.current), [])

  const showNote = (text: string) => {
    setLightNote(text)
    window.clearTimeout(noteTimerRef.current)
    noteTimerRef.current = window.setTimeout(() => setLightNote(null), 4000)
  }

  // Фуллскрин перехватывает системный «назад»: свайп/кнопка закрывают плеер,
  // а не уводят со страницы записей.
  useEffect(() => {
    if (!expanded) return
    window.history.pushState({ liveCamera: true }, '')
    const onPop = () => setExpanded(false)
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      if (window.history.state?.liveCamera) window.history.back()
    }
  }, [expanded])

  const handleResolution = async (value: Resolution) => {
    if (changingResolution || value === resolution) return
    const prev = resolution
    setChangingResolution(true)
    setResolution(value)
    try {
      await apiClient.setCameraResolution(CAMERA_ID, value)
    } catch (e) {
      console.error('Resolution change failed:', e)
      setResolution(prev)
    } finally {
      setChangingResolution(false)
    }
  }

  // Мигание подсветкой: реле дёргаются в ручной режим на пару секунд и
  // возвращаются как были. Логика ровно та же, что жила на /camera.
  const handleLightBlink = async () => {
    if (blinking) return
    setBlinking(true)
    setLightNote(null)
    try {
      const original = await apiClient.getSettings()

      // Ручной режим с обоими выключенными реле — датчики намеренно обесточены
      // (человек хочет полной темноты). Их повторное включение само по себе
      // на ~30с зажжёт свет как побочный эффект старта датчика — этого тут
      // быть не должно, поэтому вообще не трогаем настройки.
      if (original.relayMode && !original.manualDayState && !original.manualNightState) {
        showNote('Свет выключен вручную — не трогаю')
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
      showNote('Свет включится примерно на 30 секунд')
    } catch (e) {
      console.error('Light blink failed:', e)
      showNote('Не удалось подсветить — попробуйте ещё раз')
    } finally {
      setBlinking(false)
    }
  }

  const online = status?.mode === 'streaming' || status?.mode === 'connected'

  // Строка под карточкой: глянул и понял, надо ли вообще лезть в диагностику.
  const statusLine = [
    status ? MODE_LABEL[status.mode] : '—',
    online && status?.metrics?.fps != null ? `${status.metrics.fps} fps` : null,
    status?.metrics?.temperature != null ? `${status.metrics.temperature.toFixed(0)} °C` : null,
  ].filter(Boolean).join(' · ')

  return (
    <>
      <div className="live-card glass-card">
        <div className="section-header">
          <span className={`live-dot ${online ? 'on' : ''}`} />
          <h2>Сейчас</h2>
          <span className="live-status-line">{statusLine}</span>
        </div>

        <button
          type="button"
          className="live-preview"
          onClick={() => setExpanded(true)}
          aria-label="Открыть живой поток на весь экран"
        >
          {/* Пока открыт фуллскрин — поток идёт там; здесь размонтируем, иначе
              два CameraStream держат по своему WebSocket и сервер считает
              одного человека за двух зрителей. */}
          {!expanded && (
            <CameraStream
              cameraId={CAMERA_ID}
              cameraStatus={status?.mode}
              onFrameStall={fetchStatus}
            />
          )}
          <span className="live-preview-hint">
            <Play size={16} />
            На весь экран
          </span>
        </button>
      </div>

      <AnimatePresence>
        {expanded && (
          <motion.div
            className="live-fullscreen"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
          >
            <div className="live-fullscreen-header">
              <button
                className="live-fullscreen-close"
                onClick={() => setExpanded(false)}
                aria-label="Закрыть"
              >
                <Minimize2 size={22} />
              </button>
              <span className="live-fullscreen-status">
                {online ? <Wifi size={16} /> : <WifiOff size={16} />}
                {statusLine}
              </span>
            </div>

            <div className="live-fullscreen-video">
              <CameraStream
                cameraId={CAMERA_ID}
                cameraStatus={status?.mode}
                onFrameStall={fetchStatus}
              />
            </div>

            {/* Подсветка и качество нужны ровно в момент просмотра — «темно,
                ничего не видно» и «тормозит». Поэтому они здесь, в оверлее
                плеера, а не в настройках через два экрана. */}
            <div className="live-fullscreen-controls">
              <AnimatePresence>
                {lightNote && (
                  <motion.span
                    className="live-note"
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 8 }}
                  >
                    {lightNote}
                  </motion.span>
                )}
              </AnimatePresence>

              <div className="live-controls-row">
                <button
                  className="live-light-btn"
                  onClick={handleLightBlink}
                  disabled={blinking}
                >
                  <Lightbulb size={18} />
                  {blinking ? 'Включаю…' : 'Подсветить'}
                </button>

                <div className="live-quality">
                  {RESOLUTIONS.map(({ value, label }) => (
                    <button
                      key={value}
                      className={`live-quality-btn ${resolution === value ? 'active' : ''}`}
                      onClick={() => handleResolution(value)}
                      disabled={changingResolution}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}

export default LiveCamera
