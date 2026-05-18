import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Thermometer, Droplets, Camera, Cpu, AlertCircle,
  Sun, Cloud, CloudRain, CloudSnow,
  Sunrise, Sunset, Moon, Wind, Bath, Eye, HardDrive, RefreshCw, User, Users
} from 'lucide-react'
import { apiClient } from '../../api/client'
import './HomePage.css'
import TemperatureChart from '../../components/TemperatureChart/TemperatureChart'
import AIReport from '../../components/AIReport/AIReport'
import { useTheme } from '../../context/ThemeContext'
import { BottomNavBar } from '../../components/BottomNavBar/BottomNavBar';

// --- Типы и Хелперы ---
type WeatherData = {
  current_temp: number; current_feels_like: number; current_condition: string;
  humidity: number; wind_speed: number; evening_temp?: number;
  night_temp?: number; morning_temp?: number; day_temp?: number;
  timestamp: string; expires_at: string; api_calls_today: number;
}

type VisitStats = {
  name: string
  days: Record<string, string[]>
}[]

type DayDowntime = {
  intervals: { start: string; end: string | null }[]
  downtime_seconds: number
  uptime_pct: number
}

type DeviceDowntime = {
  name: string
  days: Record<string, DayDowntime>
  total_downtime_seconds: number
}

type DowntimeStats = Record<string, DeviceDowntime>

type DiskUsage = {
  total_gb: number;
  free_gb: number;
  used_percent: number;
}

type GeneralResponse = {
  telemetry: {
    device_id: string;
    temperature: number;
    humidity: number;
    free_memory?: number;
    uptime?: number;
    timestamp?: string;
  };
  central_board_status: string;
  camera_status: string;
  sensor_status: string;
  toilet_status: string;
  disk_usage?: DiskUsage;
}

const weatherTranslations: Record<string, string> = {
  'clear': 'Ясно', 'partly_cloudy': 'Облачно', 'cloudy': 'Облачно',
  'overcast': 'Пасмурно', 'light_rain': 'Дождь', 'rain': 'Дождь',
  'heavy_rain': 'Ливень', 'thunderstorm': 'Гроза', 'snow': 'Снег',
}

const getWeatherIcon = (condition: string, size = 24) => {
  const cond = condition.toLowerCase();
  const props = { size, strokeWidth: 1.5 };
  if (cond.includes('clear')) return <Sun {...props} className="weather-icon sun" />;
  if (cond.includes('rain')) return <CloudRain {...props} className="weather-icon rain" />;
  if (cond.includes('cloud')) return <Cloud {...props} className="weather-icon cloud" />;
  if (cond.includes('snow')) return <CloudSnow {...props} className="weather-icon snow" />;
  return <Sun {...props} className="weather-icon" />;
}

const getStatusStyle = (status: string) => {
  switch (status.toLowerCase()) {
    case 'online':
    case 'connected':
      return { text: 'Онлайн',       active: true,  color: '#4ade80', bg: 'rgba(34,197,94,0.15)' }
    case 'streaming':
      return { text: 'Стрим',        active: true,  color: '#818cf8', bg: 'rgba(99,102,241,0.15)' }
    case 'recording':
      return { text: 'Запись',       active: true,  color: '#fb923c', bg: 'rgba(251,146,60,0.15)' }
    case 'offline':
      return { text: 'Нет связи',    active: false, color: '#f87171', bg: 'rgba(239,68,68,0.15)' }
    case 'dead':
      return { text: 'Не отвечает',  active: false, color: '#f87171', bg: 'rgba(239,68,68,0.15)' }
    default:
      return { text: 'Не подключена', active: false, color: '#94a3b8', bg: 'rgba(148,163,184,0.1)' }
  }
};

const containerVar = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.1 } }
}
const itemVar = {
  hidden: { y: 20, opacity: 0, scale: 0.95 },
  visible: { y: 0, opacity: 1, scale: 1, transition: { type: "spring", stiffness: 150, damping: 15 } }
}

export default function HomePage() {
  const { theme } = useTheme()
  const [data, setData] = useState<GeneralResponse | null>(null)
  const [weather, setWeather] = useState<WeatherData | null>(null)
  const [loading, setLoading] = useState(true)
  const [visitStats, setVisitStats] = useState<VisitStats | null>(null)
  const [downtimeStats, setDowntimeStats] = useState<DowntimeStats | null>(null)

  const fetchData = async () => {
    try {
      setLoading(true)
      const res = await apiClient.fetch('/esp_service/telemetry')
      setData(res)
    } catch { } finally { setLoading(false) }
  }
  
  const fetchWeather = async () => {
    try {
      const res = await apiClient.fetch('/esp_service/weather');
      setWeather(res);
    } catch {}
  }

  const fetchLoginStats = async () => {
    try {
      const res = await apiClient.fetchRaw('/esp_service/login_stats')
      if (res.status === 200) {
        setVisitStats(await res.json())
      }
    } catch {}
  }

  const fetchDowntime = async () => {
    try {
      const res = await apiClient.fetch('/esp_service/downtime')
      setDowntimeStats(res)
    } catch {}
  }

  const isAllOnline = (): boolean => {
    if (!data) return false;
    return [data.central_board_status, data.camera_status, data.sensor_status, data.toilet_status]
      .every(s => getStatusStyle(s || '').active);
  };

  const getGlobalStatusText = (): string => {
    if (loading) return 'Обновление...';
    if (!data) return 'Нет данных';
    if (isAllOnline()) return 'Всё работает';
    const offlineCount = [data.central_board_status, data.camera_status, data.sensor_status, data.toilet_status]
      .filter(s => !getStatusStyle(s || '').active).length;
    if (offlineCount === 4) return 'Нет связи';
    if (offlineCount >= 2) return 'Частично недоступно';
    return 'Есть проблемы';
  };
  
  useEffect(() => {
    fetchData();
    fetchWeather();
    fetchLoginStats();
    fetchDowntime();
  }, [])

  return (
    <div className={`home-container ${theme}`}>
      
      <div className="background-spot">
        <div className="spot-1"></div>
        <div className="spot-2"></div>
        <div className="spot-3"></div>
      </div>

      <div className="main-content">
        
        <header className="header">
          <div>
            <h1 className="header-title">
              {'Умный дом'}
            </h1>
            <div className="status">
              <span className={`status-dot ${isAllOnline() ? 'online' : 'offline'}`}>
                <span></span>
              </span>
              <span className={`status-text ${!isAllOnline() && !loading && data ? 'offline-text' : ''}`}>
                {getGlobalStatusText()}
              </span>
            </div>
          </div>
          
          <div className="header-actions">
            <motion.button
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.9 }}
              animate={{ rotate: loading ? 360 : 0 }}
              transition={{ repeat: loading ? Infinity : 0, duration: 0.8, ease: 'linear' }}
              onClick={() => { fetchData(); fetchWeather(); }}
              className="theme-button"
              title="Обновить данные"
              disabled={loading}
            >
              <RefreshCw size={20} />
            </motion.button>
          </div>
        </header>

        <motion.div 
          variants={containerVar}
          initial="hidden"
          animate="visible"
          className="animated-container"
        >
          
          {/* Main Hero Card */}
          <motion.div 
            variants={itemVar}
            className="glass-card"
          >
            <div className="card-glow" />
            
            <div className="card-content">
              <div className="hero-section">
                <div>
                  <span className="temperature-label">
                    <Thermometer size={14} /> Внутри
                  </span>
                  <div className="temperature-value">
                    <span className="temperature-number">
                      {data?.telemetry?.temperature?.toFixed(1) || '--'}
                    </span>
                    <span className="temperature-unit">°</span>
                  </div>
                </div>
                <div className="humidity-indicator">
                  <Droplets size={20} className="humidity-icon" />
                  <span className="humidity-value">{data?.telemetry?.humidity?.toFixed(0) || '--'}%</span>
                </div>
              </div>

              <div className="stats-grid">
                {([
                  { key: data?.central_board_status, label: 'Центральная плата', Icon: Cpu },
                  { key: data?.camera_status,         label: 'Камера',            Icon: Camera },
                  { key: data?.sensor_status,         label: 'Датчик двери',      Icon: Eye },
                  { key: data?.toilet_status,         label: 'Уборная',           Icon: Bath },
                ] as const).map(({ key, label, Icon }) => {
                  const s = getStatusStyle(key || 'never_connected')
                  return (
                    <div className="stat-item" key={label}>
                      <div className="stat-icon" style={{ background: s.bg, color: s.color }}>
                        <Icon size={18} />
                        {!s.active && <span className="stat-icon-pulse" />}
                      </div>
                      <div className="stat-info">
                        <span className="stat-label">{label}</span>
                        <span className="stat-value" style={!s.active ? { color: '#f87171' } : { color: s.color }}>
                          {s.text}
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </motion.div>

          {/* Остальной код без изменений */}
          <div className="grid-layout">            
            {/* Weather Card */}
            <motion.div 
              variants={itemVar}
              className="weather-card grid-col-span-2"
            >
              <div className="weather-bg-icon">
                {weather ? getWeatherIcon(weather.current_condition, 120) : null}
              </div>

              <div className="weather-header">
                <span className="weather-title">
                  <Sun size={12} /> Снаружи
                </span>
                <span className="weather-time">
                  UPD: {weather ? new Date(weather.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '--:--'}
                </span>
              </div>

              <div className="weather-main">
                <div className="weather-icon-large">
                  {weather ? getWeatherIcon(weather.current_condition, 56) : <Sun size={56} className="weather-icon" />}
                </div>
                <div>
                  <div className="weather-temp">
                    {weather?.current_temp ?? '--'}°
                  </div>
                  <div className="weather-condition">
                    {weather ? weatherTranslations[weather.current_condition] : 'Загрузка...'}
                  </div>
                </div>
              </div>

              <div className="weather-forecast">
                {[
                  { label: 'Утро', val: weather?.morning_temp, icon: Sunrise, color: '#fbbf24' },
                  { label: 'День', val: weather?.day_temp, icon: Sun, color: '#f97316' },
                  { label: 'Вечер', val: weather?.evening_temp, icon: Sunset, color: '#ec4899' },
                  { label: 'Ночь', val: weather?.night_temp, icon: Moon, color: '#818cf8' },
                ].map((item, i) => (
                  <div key={i} className="forecast-item">
                    <span className="forecast-label">{item.label}</span>
                    <item.icon size={14} className="forecast-icon" style={{ color: item.color, opacity: 0.8 }} />
                    <span className="forecast-temp">{item.val ?? '-'}°</span>
                  </div>
                ))}
              </div>
            </motion.div>

            {/* System Stats */}
            <motion.div variants={itemVar} className="system-card">
              <div className="card-icon" style={
                !data?.disk_usage ? {} :
                data.disk_usage.free_gb <= 0.5 ? { background: 'rgba(239,68,68,0.15)', color: '#f87171' } :
                data.disk_usage.free_gb <= 2 ? { background: 'rgba(251,191,36,0.15)', color: '#fbbf24' } :
                { background: 'rgba(52,211,153,0.15)', color: '#34d399' }
              }>
                <HardDrive size={20} />
              </div>
              <div>
                <div className="card-value">
                  {data?.disk_usage ? `${data.disk_usage.free_gb} GB` : '--'}
                </div>
                <div className="card-label">
                  {data?.disk_usage ? `свободно из ${data.disk_usage.total_gb} GB` : 'Диск'}
                </div>
              </div>
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{
                    width: data?.disk_usage ? `${data.disk_usage.used_percent}%` : '0%',
                    background: !data?.disk_usage ? undefined :
                      data.disk_usage.free_gb <= 0.5 ? '#f87171' :
                      data.disk_usage.free_gb <= 2 ? '#fbbf24' :
                      '#34d399',
                  }}
                />
              </div>
            </motion.div>

            <motion.div variants={itemVar} className="system-card">
              <div className="card-icon" style={
                (weather?.wind_speed ?? 0) >= 12 ? { background: 'rgba(239,68,68,0.15)', color: '#f87171' } :
                (weather?.wind_speed ?? 0) >= 8  ? { background: 'rgba(251,191,36,0.15)', color: '#fbbf24' } :
                { background: 'rgba(99,102,241,0.15)', color: '#818cf8' }
              }>
                <Wind size={20} />
              </div>
              <div>
                <div className="card-value">{weather?.wind_speed ?? 0}</div>
                <div className="card-label">Метры/Сек</div>
              </div>
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{
                    width: `${Math.min((weather?.wind_speed ?? 0) / 20 * 100, 100)}%`,
                    background: (weather?.wind_speed ?? 0) >= 12 ? '#f87171' :
                                (weather?.wind_speed ?? 0) >= 8  ? '#fbbf24' :
                                '#818cf8',
                  }}
                />
              </div>
            </motion.div>
          </div>
          
          <TemperatureChart theme={theme} />

          <AIReport theme={theme} />

          {downtimeStats && (
            <motion.div variants={itemVar} className="glass-card">
              <div className="card-content">
                <div className="stat-item" style={{ marginBottom: '16px', paddingBottom: '12px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                  <div className="stat-icon" style={{ background: 'rgba(16,185,129,0.15)', color: '#34d399' }}>
                    <Eye size={18} />
                  </div>
                  <div className="stat-info">
                    <span className="stat-label">Доступность · 7 дней</span>
                    <span className="stat-value">Мониторинг устройств</span>
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  {Object.entries(downtimeStats).map(([deviceId, device]) => {
                    const sortedDays = Object.entries(device.days).sort(([a], [b]) => a.localeCompare(b))
                    const totalMin = Math.round(device.total_downtime_seconds / 60)
                    const avgUptime = sortedDays.length
                      ? Math.round(sortedDays.reduce((s, [, d]) => s + d.uptime_pct, 0) / sortedDays.length * 10) / 10
                      : 100

                    return (
                      <div key={deviceId} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', paddingBottom: '12px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                          <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{device.name}</span>
                          <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                            {totalMin > 0 && (
                              <span style={{ fontSize: '11px', color: '#f87171' }}>
                                ↓ {totalMin >= 60 ? `${Math.floor(totalMin / 60)}ч ${totalMin % 60}м` : `${totalMin}м`}
                              </span>
                            )}
                            <span style={{
                              fontSize: '12px', fontWeight: 700,
                              color: avgUptime >= 99 ? '#34d399' : avgUptime >= 95 ? '#fbbf24' : '#f87171'
                            }}>
                              {avgUptime}%
                            </span>
                          </div>
                        </div>

                        {/* Тайм-лайн: по одной полоске на день */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          {sortedDays.map(([dateStr, dayData]) => {
                            const label = dateStr.slice(5) // "MM-DD"
                            const dayStart = new Date(dateStr + 'T00:00:00+04:00').getTime()
                            const dayEnd = dayStart + 86400000

                            return (
                              <div key={dateStr} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <span style={{ fontSize: '10px', color: 'var(--text-secondary)', width: '36px', flexShrink: 0 }}>{label}</span>
                                <div style={{ flex: 1, height: '8px', borderRadius: '4px', background: 'rgba(52,211,153,0.25)', position: 'relative', overflow: 'hidden' }}>
                                  {dayData.intervals.map((iv, i) => {
                                    const s = Math.max(new Date(iv.start).getTime(), dayStart)
                                    const e = Math.min(iv.end ? new Date(iv.end).getTime() : Date.now(), dayEnd)
                                    const left = ((s - dayStart) / 86400000) * 100
                                    const width = Math.max(((e - s) / 86400000) * 100, 0.5)
                                    return (
                                      <div key={i} style={{
                                        position: 'absolute', top: 0, bottom: 0,
                                        left: `${left}%`, width: `${width}%`,
                                        background: 'rgba(248,113,113,0.85)', borderRadius: '2px'
                                      }} />
                                    )
                                  })}
                                </div>
                                <span style={{ fontSize: '10px', color: 'var(--text-secondary)', width: '36px', textAlign: 'right', flexShrink: 0 }}>
                                  {dayData.uptime_pct}%
                                </span>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </motion.div>
          )}

          {visitStats !== null && (
            <motion.div variants={itemVar} className="glass-card">
              <div className="card-content">
                <div className="stat-item" style={{ marginBottom: '12px', paddingBottom: '12px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                  <div className="stat-icon" style={{ background: 'rgba(99,102,241,0.15)', color: '#818cf8' }}>
                    <Users size={18} />
                  </div>
                  <div className="stat-info">
                    <span className="stat-label">Активность · 7 дней</span>
                    <span className="stat-value">{visitStats.length} пользователей</span>
                  </div>
                </div>

                {visitStats.length === 0 ? (
                  <p style={{ fontSize: '13px', color: 'var(--text-secondary)', textAlign: 'center', padding: '8px 0' }}>Нет активности</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    {visitStats.map((user) => {
                      const sortedDays = Object.entries(user.days).sort(([a], [b]) => b.localeCompare(a))
                      const totalVisits = Object.values(user.days).reduce((s, t) => s + t.length, 0)
                      return (
                        <div key={user.name} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', paddingBottom: '10px' }}>
                          <div className="stat-item" style={{ marginBottom: '6px' }}>
                            <div className="stat-icon" style={{ background: 'rgba(99,102,241,0.15)', color: '#818cf8' }}>
                              <User size={18} />
                            </div>
                            <div className="stat-info">
                              <span className="stat-label">{user.name}</span>
                              <span className="stat-value">{totalVisits} визит{totalVisits === 1 ? '' : totalVisits < 5 ? 'а' : 'ов'} за 7 дней</span>
                            </div>
                          </div>
                          <div style={{ paddingLeft: '48px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                            {sortedDays.map(([date, times]) => (
                              <div key={date} style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', gap: '8px' }}>
                                <span style={{ opacity: 0.6, minWidth: '80px' }}>{date}</span>
                                <span>{times.join(', ')}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </motion.div>
          )}

        </motion.div>
      </div>

      {/* Alert Overlay */}
      <AnimatePresence>
        {data?.central_board_status !== 'online' && !loading && (
          <motion.div
            initial={{ y: 50, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 50, opacity: 0 }}
            className="alert-message"
            style={{ bottom: '100px' }}
          >
            <AlertCircle size={24} className="alert-icon" />
            <div className="alert-content">
              <p className="alert-title">Внимание</p>
              <p className="alert-text">Данные устарели. Проверьте питание главной платы.</p>
            </div>
          </motion.div>
        )}
        {data?.disk_usage && data.disk_usage.free_gb <= 0.5 && !loading && (
          <motion.div
            initial={{ y: 50, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 50, opacity: 0 }}
            className="alert-message"
            style={{ bottom: data?.central_board_status !== 'online' ? '160px' : '100px', background: 'rgba(239,68,68,0.15)', borderColor: '#f87171' }}
          >
            <HardDrive size={24} className="alert-icon" style={{ color: '#f87171' }} />
            <div className="alert-content">
              <p className="alert-title">Диск почти заполнен</p>
              <p className="alert-text">Осталось {data.disk_usage.free_gb} GB — срочно освободите место.</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      
      <BottomNavBar />
    </div>
  )
}