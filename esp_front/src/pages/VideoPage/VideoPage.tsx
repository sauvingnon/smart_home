import React, { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Video,
  Clock,
  FileVideo,
  Download,
  Play,
  RefreshCw,
  HardDrive,
  Users,
  AlertTriangle,
  AlertCircle,
  LogIn,
  LogOut,
  Loader2,
  MessageCircle
} from 'lucide-react'
import { apiClient } from '../../api/client'
import './VideoPage.css'
import { useTheme } from '../../context/ThemeContext'

interface VideoItem {
    key: string
    video_id?: string
    video_url: string  // 🔧 Добавлено
    url?: string        // 🔧 Добавлено (алиас для video_url)
    size_bytes: number
    last_modified: string
    camera_id: string
    duration_seconds?: number
    start_time?: string
    thumbnail_url: string  // 🔧 Может быть null
    recognized?: string[] | null  // Кто распознан на видео (null = ещё не обработано)
    recognition_error?: boolean | null  // true = не смогли проверить статус (не путать с "ещё не обработано")
    direction?: string | null  // "entering" | "exiting" | "nothing" | null (ещё не обработано)
    direction_low_confidence?: boolean | null  // true = вердикт вблизи порога, не доверять слепо
}

// Сколько ждём результат CV-пайплайна, прежде чем считать обработку зависшей
// (воркер падает на конкретном видео без следа -- см. обсуждение с пользователем).
// Не про типичное время обработки (~1.5-3 мин) -- запас на очередь из нескольких видео подряд.
const PROCESSING_STUCK_MINUTES = 60

const isStuckProcessing = (video: VideoItem) => {
  const started = new Date(video.start_time || video.last_modified).getTime()
  if (Number.isNaN(started)) return false
  return (Date.now() - started) / 60000 > PROCESSING_STUCK_MINUTES
}

// Метки people-эталонов (dataset/<label>/) -> отображаемое имя на фронте
const RECOGNIZED_NAMES: Record<string, string> = {
  andrey: 'Андрей',
  liliya: 'Лилия',
  kamelia: 'Камелия',
  grisha: 'Гриша',
}
const recognizedDisplayName = (label: string) => RECOGNIZED_NAMES[label] ?? label
const PEOPLE_FILTERS = ['andrey', 'liliya', 'kamelia', 'grisha']

const containerVar = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.05 } }
}

const itemVar = {
  hidden: { y: 20, opacity: 0 },
  visible: { y: 0, opacity: 1 }
}

export const VideosPage = () => {
  const { theme } = useTheme()
  const navigate = useNavigate()
  const [videos, setVideos] = useState<VideoItem[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedVideo, setSelectedVideo] = useState<VideoItem | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set())
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [downloadProgress, setDownloadProgress] = useState(0) // -1 = подготовка, 0-100 = прогресс
  const [sharingId, setSharingId] = useState<string | null>(null)
  const [activeFilters, setActiveFilters] = useState<Set<string>>(new Set())

  const toggleFilter = (label: string) => {
    setActiveFilters(prev => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })
  }

  const toggleDay = (dayKey: string) => {
    setExpandedDays(prev => {
      const newSet = new Set(prev)
      if (newSet.has(dayKey)) {
        newSet.delete(dayKey)
      } else {
        newSet.add(dayKey)
      }
      return newSet
    })
  }

  useEffect(() => {
    const handleFullscreenChange = () => {
      // Не закрываем модалку при выходе из fullscreen
      // Просто синхронизируем состояние если нужно
      if (!document.fullscreenElement && selectedVideo) {
        // Можно обновить какой-то флаг, но не закрывать видео
        console.log('Exited fullscreen mode')
      }
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [selectedVideo]) // Добавили зависимость

  useEffect(() => {
    loadVideos()
  }, [])

  const loadVideos = async () => {
      try {
          setLoading(true)
          const videos = await apiClient.getVideos("cam1")  // 🔧 Возвращает просто массив
          setVideos(videos)
      } catch (error) {
          console.error('Failed to load videos:', error)
      } finally {
          setLoading(false)
      }
  }

  const formatDuration = (seconds?: number) => {
    if (seconds == null) return '0:00'
    const hours = Math.floor(seconds / 3600)
    const mins = Math.floor((seconds % 3600) / 60)
    const secs = seconds % 60
    if (hours > 0) {
      return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  const formatTime = (dateString: string) => {
    return new Date(dateString).toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  const formatDayHeader = (dayKey: string) => {
    const [y, m, d] = dayKey.split('-').map(Number)
    const date = new Date(Date.UTC(y, m - 1, d))
    return date.toLocaleDateString('ru-RU', {
      timeZone: 'Europe/Samara',
      day: 'numeric',
      month: 'long',
      weekday: 'long'
    })
  }

  const getVideoSortDate = (video: VideoItem) => {
    return new Date(video.start_time || video.last_modified).toISOString()
  }

  const formatSize = (bytes: number) => {
    const mb = bytes / (1024 * 1024)
    if (mb >= 1024) {
      return `${(mb / 1024).toFixed(2)} GB`
    }
    return `${mb.toFixed(1)} MB`
  }

  const getTotalDuration = () => {
    const totalSeconds = filteredVideos.reduce((sum, video) => sum + (video.duration_seconds || 0), 0)
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    if (hours > 0) {
      return `${hours} ч ${minutes} мин`
    }
    return totalSeconds > 0 ? `${minutes} мин` : '0 мин'
  }

  const getTotalSize = () => {
    const totalBytes = filteredVideos.reduce((sum, video) => sum + video.size_bytes, 0)
    return formatSize(totalBytes)
  }

  // 🔧 ИСПРАВЛЕНИЕ handleVideoClick:
  const handleVideoClick = (video: VideoItem) => {
      console.log('🎬 Opening video:', video.video_url)
      setSelectedVideo({ ...video, url: video.video_url })
  }

  const handleDownload = async (video: VideoItem, e: React.MouseEvent) => {
      e.stopPropagation()
      const videoId = video.video_id || video.key.split('/').pop()?.replace('.mp4', '')
      const cameraId = video.camera_id
      if (!videoId || !cameraId) return

      setDownloadingId(videoId)
      setDownloadProgress(-1)

      try {
          const response = await apiClient.fetchRaw(
              `/esp_service/videos/download?video_id=${encodeURIComponent(videoId)}&camera_id=${encodeURIComponent(cameraId)}`
          )
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          if (!response.body) throw new Error('No response body')

          const contentLength = response.headers.get('Content-Length')
          const total = contentLength ? parseInt(contentLength) : 0

          const reader = response.body.getReader()
          const chunks: BlobPart[] = []
          let received = 0
          setDownloadProgress(0)

          while (true) {
              const { done, value } = await reader.read()
              if (done) break
              chunks.push(value)
              received += value.length
              if (total) setDownloadProgress(Math.round(received / total * 100))
          }

          const blob = new Blob(chunks, { type: 'video/mp4' })
          const url = URL.createObjectURL(blob)
          const link = document.createElement('a')
          link.href = url
          link.download = `${cameraId}_${video.start_time?.replace(/[:T]/g, '-') || Date.now()}.mp4`
          document.body.appendChild(link)
          link.click()
          document.body.removeChild(link)
          URL.revokeObjectURL(url)

      } catch (error) {
          console.error('Failed to download video:', error)
          alert('Не удалось скачать видео')
      } finally {
          setDownloadingId(null)
          setDownloadProgress(0)
      }
  }


  const handleShare = async (video: VideoItem, e: React.MouseEvent) => {
    e.stopPropagation()
    const videoId = video.video_id || video.key.split('/').pop()?.replace('.mp4', '')
    const cameraId = video.camera_id
    if (!videoId || !cameraId || sharingId) return

    setSharingId(videoId)
    try {
      await apiClient.shareVideoToChat(cameraId, videoId)
      navigate('/chat')
    } catch (error) {
      console.error('Failed to share video to chat:', error)
      alert('Не удалось переслать видео в чат')
    } finally {
      setSharingId(null)
    }
  }

  const closeModal = () => {
    if (videoRef.current) {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(err => console.error('Failed to exit fullscreen:', err))
      }
      videoRef.current.pause()
    }
    setSelectedVideo(null)
  }

  const toSamaraDate = (dateStr: string) => {
    const utcMs = new Date(dateStr).getTime()
    return new Date(utcMs + 4 * 60 * 60 * 1000) // UTC+4 Самара
  }

  // Фильтр по распознанным людям — пусто = без фильтра, показываем всё
  const filteredVideos = activeFilters.size === 0
    ? videos
    : videos.filter(video => video.recognized?.some(name => activeFilters.has(name)))

  // Группировка видео по дням (UTC+4, Самара)
  const groupedVideos = filteredVideos.reduce<Record<string, VideoItem[]>>((groups, video) => {
    const date = toSamaraDate(video.start_time || video.last_modified)
    const y = date.getUTCFullYear()
    const m = String(date.getUTCMonth() + 1).padStart(2, '0')
    const d = String(date.getUTCDate()).padStart(2, '0')
    const dateKey = `${y}-${m}-${d}`
    if (!groups[dateKey]) groups[dateKey] = []
    groups[dateKey].push(video)
    return groups
  }, {})

  // Сортировка дней: от новых к старым
  const sortedDayKeys = Object.keys(groupedVideos).sort((a, b) => b.localeCompare(a))

  return (
    <div className={`videos-page ${theme}`}>
      <div className="background-spot">
        <div className="spot-1"></div>
        <div className="spot-2"></div>
        <div className="spot-3"></div>
      </div>

      <div className="videos-page-container">
        <motion.div
          className="videos-header glass-card"
          variants={itemVar}
          initial="hidden"
          animate="visible"
        >
          <div className="videos-title">
            <Video size={24} className="title-icon" />
            <h1>Видеозаписи</h1>
          </div>
          <div className="header-actions">
            <button className="header-action-btn" onClick={loadVideos} title="Обновить">
              <RefreshCw size={20} />
            </button>
          </div>
        </motion.div>

        <motion.div
          className="videos-main"
          variants={containerVar}
          initial="hidden"
          animate="visible"
        >
          <motion.div variants={itemVar} className="videos-section glass-card">
            <div className="section-header">
              <Video size={20} className="section-icon" />
              <h2>Записи</h2>
            </div>

            {videos.length > 0 && (
              <div className="people-filter">
                {PEOPLE_FILTERS.map(label => (
                  <button
                    key={label}
                    className={`people-filter-chip ${activeFilters.has(label) ? 'active' : ''}`}
                    onClick={() => toggleFilter(label)}
                  >
                    {recognizedDisplayName(label)}
                  </button>
                ))}
                {activeFilters.size > 0 && (
                  <button className="people-filter-clear" onClick={() => setActiveFilters(new Set())}>
                    Сбросить
                  </button>
                )}
              </div>
            )}

            {loading ? (
              <div className="loading-container">
                <div className="loading-card">
                  <div className="spinner" />
                  <p className="loading-text">Загрузка видео...</p>
                </div>
              </div>
            ) : videos.length === 0 ? (
              <div className="empty-state">
                <FileVideo size={48} className="empty-icon" />
                <h3>Нет видеозаписей</h3>
                <p>Видеозаписи появятся здесь после записи</p>
              </div>
            ) : filteredVideos.length === 0 ? (
              <div className="empty-state">
                <Users size={48} className="empty-icon" />
                <h3>Никого не найдено</h3>
                <p>Нет видео с выбранными людьми — попробуй другой фильтр</p>
              </div>
            ) : (
              <div className="videos-list">
                {sortedDayKeys.map((dayKey) => {
                  // Сортировка видео внутри дня: от новых к старым
                  const dayVideos = [...groupedVideos[dayKey]].sort((a, b) =>
                    getVideoSortDate(b).localeCompare(getVideoSortDate(a))
                  )
                  const isExpanded = expandedDays.has(dayKey)

                  return (
                    <div className="day-block" key={dayKey}>
                      <button
                        className="day-header"
                        onClick={() => toggleDay(dayKey)}
                        aria-expanded={isExpanded}
                      >
                        <span>{formatDayHeader(dayKey)}</span>
                        <span className="toggle-icon">{isExpanded ? '▼' : '▶'}</span>
                      </button>

                      <AnimatePresence initial={false}>
                        {isExpanded && (
                          <motion.div
                            key="grid"
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.2 }}
                            style={{ overflow: 'hidden' }}
                          >
                            <div className="videos-grid">
                              {dayVideos.map((video, index) => (
                                <motion.div
                                  key={video.key}
                                  className="video-card"
                                  variants={itemVar}
                                  initial="hidden"
                                  animate="visible"
                                  transition={{ delay: index * 0.03 }}
                                  onClick={() => handleVideoClick(video)}
                                  whileHover={{ y: -2 }}
                                  whileTap={{ scale: 0.98 }}
                                >
                                  <div className="video-preview">
                                    {video.thumbnail_url ? (
                                        <img
                                            src={video.thumbnail_url}
                                            alt="Превью видео"
                                            className="thumbnail-image"
                                            onError={(e) => {
                                                (e.target as HTMLImageElement).style.display = 'none'
                                                const parent = (e.target as HTMLImageElement).parentElement
                                                if (parent) {
                                                    parent.classList.add('thumbnail-error')
                                                }
                                            }}
                                        />
                                    ) : (
                                        <div className="thumbnail-placeholder">
                                            <FileVideo size={32} />
                                        </div>
                                    )}
                                    <div className="play-overlay">
                                      <Play size={24} className="play-icon" />
                                    </div>
                                    <div className="video-duration">
                                      {formatDuration(video.duration_seconds)}
                                    </div>
                                  </div>

                                  <div className="video-card-content">
                                    <div className="video-card-title">
                                      {formatTime(video.start_time || video.last_modified)}
                                    </div>
                                    {video.recognized == null && !video.recognition_error && !isStuckProcessing(video) && (
                                      <div className="video-card-processing">
                                        <div className="video-card-processing-label">
                                          <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 0.8, ease: 'linear' }} style={{ display: 'flex' }}>
                                            <Loader2 size={16} />
                                          </motion.div>
                                          <span>В обработке</span>
                                        </div>
                                        <div className="video-card-progress-track">
                                          <div className="video-card-progress-bar" />
                                        </div>
                                      </div>
                                    )}
                                    {video.recognized == null && !video.recognition_error && isStuckProcessing(video) && (
                                      <div className="video-card-processing-stuck" title={`Прошло больше ${PROCESSING_STUCK_MINUTES} мин, а результата всё нет — похоже, обработка упала`}>
                                        <AlertCircle size={16} />
                                        <span>Не удалось обработать</span>
                                      </div>
                                    )}
                                    {video.recognized && video.recognized.length > 0 && (
                                      <div className="video-card-recognized">
                                        <Users size={18} />
                                        <span>{video.recognized.map(recognizedDisplayName).join(', ')}</span>
                                      </div>
                                    )}
                                    {video.direction === 'entering' && (
                                      <div
                                        className="video-card-direction-entering"
                                        title={video.direction_low_confidence ? 'Похоже, но не уверен' : undefined}
                                      >
                                        <LogIn size={18} />
                                        <span>Вошёл</span>
                                      </div>
                                    )}
                                    {video.direction === 'exiting' && (
                                      <div
                                        className="video-card-direction-exiting"
                                        title={video.direction_low_confidence ? 'Похоже, но не уверен' : undefined}
                                      >
                                        <LogOut size={18} />
                                        <span>Вышел</span>
                                      </div>
                                    )}
                                    {video.recognition_error && (
                                      <div className="video-card-recognition-error" title="Не удалось проверить, распознан ли кто-то на видео">
                                        <AlertTriangle size={16} />
                                        <span>Ошибка проверки распознавания</span>
                                      </div>
                                    )}
                                    <div className="video-card-footer">
                                      <div className="video-card-subtitle">
                                        {formatDate(video.start_time || video.last_modified)}
                                      </div>
                                      <div className="video-card-actions">
                                        <button
                                          className="download-btn small"
                                          onClick={(e) => handleShare(video, e)}
                                          title="Переслать в чат"
                                          disabled={sharingId !== null}
                                        >
                                          {sharingId === (video.video_id || video.key.split('/').pop()?.replace('.mp4', ''))
                                            ? <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 0.8, ease: 'linear' }} style={{ display: 'flex' }}><RefreshCw size={18} /></motion.div>
                                            : <MessageCircle size={18} />
                                          }
                                        </button>
                                        <button
                                          className="download-btn small"
                                          onClick={(e) => handleDownload(video, e)}
                                          title="Скачать"
                                          disabled={downloadingId !== null}
                                        >
                                          {downloadingId === (video.video_id || video.key.split('/').pop()?.replace('.mp4', ''))
                                            ? <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 0.8, ease: 'linear' }} style={{ display: 'flex' }}><RefreshCw size={18} /></motion.div>
                                            : <Download size={18} />
                                          }
                                        </button>
                                      </div>
                                    </div>
                                  </div>
                                </motion.div>
                              ))}
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  )
                })}
              </div>
            )}
          </motion.div>

          {/* Статистика */}
          <motion.div variants={itemVar} className="stats-section">
            <div className="stats-grid">
              <div className="stat-card glass-card">
                <div className="stat-icon videos">
                  <FileVideo size={24} />
                </div>
                <div className="stat-info">
                  <span className="stat-label">Всего видео</span>
                  <span className="stat-value">{filteredVideos.length}</span>
                </div>
              </div>
              <div className="stat-card glass-card">
                <div className="stat-icon duration">
                  <Clock size={24} />
                </div>
                <div className="stat-info">
                  <span className="stat-label">Длительность</span>
                  <span className="stat-value">{getTotalDuration()}</span>
                </div>
              </div>
              <div className="stat-card glass-card">
                <div className="stat-icon size">
                  <HardDrive size={24} />
                </div>
                <div className="stat-info">
                  <span className="stat-label">Общий размер</span>
                  <span className="stat-value">{getTotalSize()}</span>
                </div>
              </div>
            </div>
          </motion.div>
        </motion.div>
      </div>

      <AnimatePresence>
        {downloadingId && (
          <motion.div
            initial={{ y: 100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 100, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            style={{
              position: 'fixed', bottom: 90, left: 16, right: 16, zIndex: 100,
              background: 'rgba(15, 23, 42, 0.92)',
              backdropFilter: 'blur(16px)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 16,
              padding: '14px 16px',
              display: 'flex', alignItems: 'center', gap: 12,
            }}
          >
            <Download size={18} style={{ color: '#a78bfa', flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ margin: '0 0 6px', fontSize: 13, color: 'rgba(255,255,255,0.9)' }}>
                {downloadProgress < 0
                  ? 'Подготовка скачивания...'
                  : downloadProgress < 100
                    ? `Скачивание ${downloadProgress}%`
                    : 'Завершение...'}
              </p>
              <div style={{ height: 4, background: 'rgba(255,255,255,0.1)', borderRadius: 2 }}>
                <motion.div
                  style={{ height: '100%', background: 'linear-gradient(90deg, #a78bfa, #06b6d4)', borderRadius: 2 }}
                  animate={{ width: downloadProgress < 0 ? '35%' : `${downloadProgress}%` }}
                  transition={downloadProgress < 0
                    ? { repeat: Infinity, repeatType: 'reverse', duration: 1, ease: 'easeInOut' }
                    : { duration: 0.15 }
                  }
                />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Модальное окно для просмотра видео */}
      {selectedVideo && (
        <div className="video-modal-overlay" onClick={closeModal}>
          <div className="video-modal-container" onClick={e => e.stopPropagation()}>
            <div className="video-modal-header">
              <button className="modal-close-btn" onClick={closeModal}>
                ✕
              </button>
            </div>
            {selectedVideo.url ? (
              <video
                ref={videoRef}
                src={selectedVideo.url}
                controls
                autoPlay
                className="video-player-modal"
                onLoadStart={() => console.log('Video load start')}
                onLoadedData={() => console.log('Video loaded data')}
                onError={(e) => console.error('Video error:', e)}
              >
                Ваш браузер не поддерживает воспроизведение видео
              </video>
            ) : (
              <div className="video-placeholder">
                <FileVideo size={64} />
                <p>Ссылка на видео недоступна</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}