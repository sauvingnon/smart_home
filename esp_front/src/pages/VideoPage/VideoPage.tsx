import React, { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Video,
  Clock,
  FileVideo,
  Download,
  Play,
  RefreshCw,
  HardDrive
} from 'lucide-react'
import { apiClient } from '../../api/client'
import './VideoPage.css'
import { useTheme } from '../../context/ThemeContext'
import { BottomNavBar } from '../../components/BottomNavBar/BottomNavBar'

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
}

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
  const [videos, setVideos] = useState<VideoItem[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedVideo, setSelectedVideo] = useState<VideoItem | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set())

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

  const formatDayHeader = (dateString: string) => {
    const date = new Date(dateString)
    return date.toLocaleDateString('ru-RU', {
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
    const totalSeconds = videos.reduce((sum, video) => sum + (video.duration_seconds || 0), 0)
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    if (hours > 0) {
      return `${hours} ч ${minutes} мин`
    }
    return totalSeconds > 0 ? `${minutes} мин` : '0 мин'
  }

  const getTotalSize = () => {
    const totalBytes = videos.reduce((sum, video) => sum + video.size_bytes, 0)
    return formatSize(totalBytes)
  }

  // 🔧 ИСПРАВЛЕНИЕ handleVideoClick:
  const handleVideoClick = (video: VideoItem) => {
      console.log('🎬 Opening video:', video.video_url)
      setSelectedVideo({ ...video, url: video.video_url })
  }

  const handleDownload = async (video: VideoItem, e: React.MouseEvent) => {
      e.stopPropagation()
      try {
          // 🔧 Используем video_id и camera_id вместо key
          const videoId = video.video_id || video.key.split('/').pop()?.replace('.mp4', '')
          const cameraId = video.camera_id
          
          if (!videoId || !cameraId) {
              throw new Error('Missing video_id or camera_id')
          }
          
          // 🔧 Получаем токен из localStorage или контекста (если нужен)
          const token = localStorage.getItem('session_token') || ''
          
          const response = await apiClient.fetchRaw(
              `/esp_service/videos/download?video_id=${encodeURIComponent(videoId)}&camera_id=${encodeURIComponent(cameraId)}&token=${encodeURIComponent(token)}`
          )
          
          if (!response.ok) {
              throw new Error(`Download failed: ${response.status}`)
          }
          
          const blob = await response.blob()
          const downloadUrl = URL.createObjectURL(blob)
          const safeFileName = `${cameraId}_${video.start_time?.replace(/[:T]/g, '-') || Date.now()}.mp4`
          
          const link = document.createElement('a')
          link.href = downloadUrl
          link.download = safeFileName
          document.body.appendChild(link)
          link.click()
          document.body.removeChild(link)
          URL.revokeObjectURL(downloadUrl)
          
      } catch (error) {
          console.error('Failed to download video:', error)
          // 🔧 Можно показать уведомление пользователю
          alert('Не удалось скачать видео')
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

  // Группировка видео по дням (по дате из start_time или last_modified)
  const groupedVideos = videos.reduce<Record<string, VideoItem[]>>((groups, video) => {
    const dateKey = getVideoSortDate(video).slice(0, 10) // YYYY-MM-DD
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
                                    <div className="video-card-footer">
                                      <div className="video-card-subtitle">
                                        {formatDate(video.last_modified)}
                                      </div>
                                      <button
                                        className="download-btn small"
                                        onClick={(e) => handleDownload(video, e)}
                                        title="Скачать"
                                      >
                                        <Download size={18} />
                                      </button>
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
                  <span className="stat-value">{videos.length}</span>
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

      <BottomNavBar />

      {/* Модальное окно для просмотра видео */}
      {selectedVideo && (
        <div className="video-modal-overlay" onClick={closeModal}>
          <div className="video-modal-container" onClick={e => e.stopPropagation()}>
            <div className="video-modal-header">
              <button className="modal-close-btn" onClick={closeModal}>
                ✕
              </button>
              <button 
                className="modal-fullscreen-btn" 
                onClick={() => videoRef.current?.requestFullscreen()}
              >
                ⛶
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