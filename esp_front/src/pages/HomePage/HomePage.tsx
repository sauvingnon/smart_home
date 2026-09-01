import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence, animate, useMotionValue } from 'framer-motion'
import {
  Thermometer, Droplets, Camera, Cpu, AlertCircle,
  Sun, Cloud, CloudRain, CloudSnow,
  Sunrise, Sunset, Moon, Wind, Bath, Eye, Activity, HardDrive, MemoryStick, RefreshCw, User, Users, ChevronDown, Search, Fan, Check, X,
} from 'lucide-react'
import { apiClient } from '../../api/client'
import './HomePage.css'
import TemperatureChart from '../../components/TemperatureChart/TemperatureChart'
import { useTheme } from '../../context/ThemeContext'
import { useAuth } from '../../context/AuthContext'
import { usePageVisit } from '../../hooks/usePageVisit'

// --- Типы и Хелперы ---
type WeatherData = {
  current_temp: number; current_feels_like: number; current_condition: string;
  humidity: number; wind_speed: number; evening_temp?: number;
  night_temp?: number; morning_temp?: number; day_temp?: number;
  timestamp: string; expires_at: string; api_calls_today: number;
}

type VisitEntry = {
  time: string
  routes: string[]
}

type VisitStats = {
  name: string
  days: Record<string, VisitEntry[]>
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

type MemoryUsage = {
  total_gb: number;
  used_gb: number;
  used_percent: number;
}

type CpuUsage = {
  used_percent: number;
  cores: number;
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
  memory_usage?: MemoryUsage;
  cpu_usage?: CpuUsage;
}

// Кеш последних значений живёт в памяти модуля и дублируется в localStorage.
// Память модуля переживает размонтирование HomePage при уходе на другую
// вкладку внутри SPA, но обнуляется при холодном старте PWA (новый JS-
// контекст) — тогда единственное, что успевает подставиться до первого
// ответа сервера, это то, что мы успели сохранить в localStorage в прошлый
// раз. Без этого при каждом заходе (и особенно при первом после перезапуска
// PWA) стейты и температура на миг проваливались в "--", пока не придёт
// ответ home_bootstrap, и было видно как значения дёргаются.
type HomeCache = {
  data: GeneralResponse | null
  weather: WeatherData | null
  downtimeStats: DowntimeStats | null
  visitStats: VisitStats | null
}

// Версия в ключе — если форма закешированных объектов когда-нибудь поменяется
// несовместимо, старые записи у пользователей просто перестанут матчиться и
// будут проигнорированы вместо попытки отрендерить их в новом формате.
const HOME_CACHE_KEY = 'home_cache_v1'

function readHomeCacheFromStorage(): HomeCache {
  const empty: HomeCache = { data: null, weather: null, downtimeStats: null, visitStats: null }
  try {
    const raw = localStorage.getItem(HOME_CACHE_KEY)
    if (!raw) return empty
    return { ...empty, ...JSON.parse(raw) }
  } catch {
    return empty
  }
}

const homeCache: HomeCache = readHomeCacheFromStorage()

function persistHomeCache() {
  try {
    localStorage.setItem(HOME_CACHE_KEY, JSON.stringify(homeCache))
  } catch {
    // приватный режим / забита квота — просто не кешируем на диск
  }
}

// Плавно едет от старого числа к новому вместо мгновенной подмены — так
// обновление кеша свежими данными с сервера не выглядит как дёрганье.
function useAnimatedNumber(value: number | null | undefined, decimals = 1): number | null {
  const motionValue = useMotionValue(value ?? 0)
  const [display, setDisplay] = useState<number | null>(value ?? null)
  const prevValue = useRef<number | null | undefined>(value)

  useEffect(() => {
    if (value == null) return
    if (prevValue.current == null) {
      motionValue.set(value)
      setDisplay(value)
      prevValue.current = value
      return
    }
    if (prevValue.current === value) return
    prevValue.current = value
    const controls = animate(motionValue, value, {
      duration: 0.6,
      ease: 'easeOut',
      onUpdate: v => setDisplay(v),
    })
    return () => controls.stop()
  }, [value])

  return display == null ? null : Number(display.toFixed(decimals))
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

const getUptimeColor = (pct: number) =>
  pct >= 99 ? '#34d399' : pct >= 95 ? '#fbbf24' : '#f87171'

// Плитки телеметрии красятся по метрике, а не по нагрузке: раньше цвет
// зависел от процента и в норме все три были одинаково зелёные — то есть
// неразличимы с одного взгляда. Диск отдельно: там цвет всё ещё умеет
// предупреждать, место на сервере кончается по-настоящему (см. ниже).
const TILE_COLORS = {
  disk: { color: '#60a5fa', bg: 'rgba(59,130,246,0.15)' },
  memory: { color: '#34d399', bg: 'rgba(52,211,153,0.15)' },
  cpu: { color: '#f87171', bg: 'rgba(239,68,68,0.15)' },
};

// Остаток места на диске, ниже которого плитка перестаёт быть синей. Пороги
// тут, а не по месту: их три потребителя — иконка плитки, её полоска и
// нижний баннер "диск почти заполнен", и разъезжаться им нельзя.
const DISK_CRITICAL_GB = 2;
const DISK_WARNING_GB = 5;

// Та же логика для RAM и CPU, только шкала в процентах занятого, а не в
// оставшихся гигабайтах: до порога — свой цвет плитки, дальше предупреждение.
const LOAD_WARNING_PERCENT = 75;
const LOAD_CRITICAL_PERCENT = 90;

const ALERT_ICON = { background: 'rgba(239,68,68,0.15)', color: '#f87171' };
const WARN_ICON = { background: 'rgba(251,191,36,0.15)', color: '#fbbf24' };

const loadIconStyle = (percent: number | undefined, base: { color: string; bg: string }) => {
  if (percent === undefined) return {};
  if (percent >= LOAD_CRITICAL_PERCENT) return ALERT_ICON;
  if (percent >= LOAD_WARNING_PERCENT) return WARN_ICON;
  return { background: base.bg, color: base.color };
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
  usePageVisit('home')
  const { theme } = useTheme()
  const { isAdmin } = useAuth()
  const [data, setData] = useState<GeneralResponse | null>(() => homeCache.data)
  const [weather, setWeather] = useState<WeatherData | null>(() => homeCache.weather)
  const [loading, setLoading] = useState(() => !homeCache.data)
  const [visitStats, setVisitStats] = useState<VisitStats | null>(() => homeCache.visitStats)
  const [downtimeStats, setDowntimeStats] = useState<DowntimeStats | null>(() => homeCache.downtimeStats)
  const [selectedDowntimeDevice, setSelectedDowntimeDevice] = useState<string | null>(null)
  const [selectedDowntimeDate, setSelectedDowntimeDate] = useState<string | null>(null)
  const [expandedDevices, setExpandedDevices] = useState<Set<string>>(new Set())
  const [silentLoading, setSilentLoading] = useState(false)
  const [silentFeedback, setSilentFeedback] = useState<'ok' | 'error' | null>(null)

  useEffect(() => {
    if (selectedDowntimeDevice) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
  }, [selectedDowntimeDevice])

  useEffect(() => {
    if (!selectedDowntimeDevice || !selectedDowntimeDate) return
    const id = requestAnimationFrame(() => {
      document.querySelector(`[data-downtime-date="${selectedDowntimeDate}"]`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
    return () => cancelAnimationFrame(id)
  }, [selectedDowntimeDevice, selectedDowntimeDate])

  const fetchData = async () => {
    try {
      setLoading(true)
      const res = await apiClient.fetch('/esp_service/telemetry')
      setData(res)
      homeCache.data = res
      persistHomeCache()
    } catch { } finally { setLoading(false) }
  }

  const fetchWeather = async () => {
    try {
      const res = await apiClient.fetch('/esp_service/weather');
      setWeather(res);
      homeCache.weather = res
      persistHomeCache()
    } catch {}
  }

  const activateSilentMode = async () => {
    if (silentLoading) return
    setSilentLoading(true)
    setSilentFeedback(null)
    try {
      const currentSettings = await apiClient.fetch('/esp_service/settings')
      await apiClient.fetch('/esp_service/settings', {
        method: 'POST',
        body: JSON.stringify({ ...currentSettings, silentMode: true })
      })
      setSilentFeedback('ok')
    } catch {
      setSilentFeedback('error')
    } finally {
      setSilentLoading(false)
      setTimeout(() => setSilentFeedback(null), 2500)
    }
  }

  const isAllOnline = (): boolean => {
    if (!data) return false;
    return [data.central_board_status, data.camera_status, data.sensor_status, data.toilet_status]
      .every(s => getStatusStyle(s || '').active);
  };

  const getGlobalStatusText = (): string => {
    if (!data) return loading ? 'Обновление...' : 'Нет данных';
    if (isAllOnline()) return 'Всё работает';
    const offlineCount = [data.central_board_status, data.camera_status, data.sensor_status, data.toilet_status]
      .filter(s => !getStatusStyle(s || '').active).length;
    if (offlineCount === 4) return 'Нет связи';
    if (offlineCount >= 2) return 'Частично недоступно';
    return 'Есть проблемы';
  };
  
  const fetchBootstrap = async () => {
    try {
      setLoading(true)
      const res = await apiClient.fetch('/esp_service/home_bootstrap')
      if (res.status) { setData(res.status); homeCache.data = res.status }
      if (res.weather) { setWeather(res.weather); homeCache.weather = res.weather }
      if (res.downtime) { setDowntimeStats(res.downtime); homeCache.downtimeStats = res.downtime }
      if (isAdmin && res.login_stats) { setVisitStats(res.login_stats); homeCache.visitStats = res.login_stats }
      persistHomeCache()
    } catch { } finally { setLoading(false) }
  }

  useEffect(() => {
    // Раньше 4 отдельных запроса (telemetry, weather, downtime, login_stats)
    // улетали в маунт одним залпом — вместе с чатом это давало ~7 новых
    // соединений в первую секунду холодного старта, что для anti-DDoS
    // слабого сервера выглядело флудом. Теперь это один запрос — бэкенд сам
    // собирает всё параллельно на своей стороне, без открытия новых TCP-
    // соединений на клиенте.
    fetchBootstrap()
  }, [isAdmin])

  const animatedTemp = useAnimatedNumber(data?.telemetry?.temperature, 1)
  const animatedHumidity = useAnimatedNumber(data?.telemetry?.humidity, 0)
  const animatedWeatherTemp = useAnimatedNumber(weather?.current_temp, 0)

  const overallUptime = downtimeStats
    ? (() => {
        const devices = Object.values(downtimeStats)
        if (!devices.length) return 100
        const avg = devices.reduce((sum, device) => {
          const days = Object.values(device.days)
          const dayAvg = days.length ? days.reduce((s, d) => s + d.uptime_pct, 0) / days.length : 100
          return sum + dayAvg
        }, 0) / devices.length
        return Math.round(avg * 10) / 10
      })()
    : 100

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
              onClick={activateSilentMode}
              className={`theme-button silent-mode-button ${silentFeedback === 'ok' ? 'silent-ok' : ''} ${silentFeedback === 'error' ? 'silent-error' : ''}`}
              title="Включить режим тишины вентилятора"
              disabled={silentLoading}
            >
              <AnimatePresence mode="wait" initial={false}>
                {silentLoading ? (
                  <motion.span
                    key="loading"
                    initial={{ opacity: 0, scale: 0.5 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.5 }}
                    transition={{ duration: 0.15 }}
                    className="silent-icon-wrap"
                  >
                    <RefreshCw size={20} className="spin" />
                  </motion.span>
                ) : silentFeedback === 'ok' ? (
                  <motion.span
                    key="ok"
                    initial={{ opacity: 0, scale: 0.3, rotate: -45 }}
                    animate={{ opacity: 1, scale: 1, rotate: 0 }}
                    exit={{ opacity: 0, scale: 0.5 }}
                    transition={{ type: 'spring', stiffness: 500, damping: 20 }}
                    className="silent-icon-wrap"
                  >
                    <Check size={20} />
                  </motion.span>
                ) : silentFeedback === 'error' ? (
                  <motion.span
                    key="error"
                    initial={{ opacity: 0, scale: 0.3 }}
                    animate={{ opacity: 1, scale: 1, x: [0, -4, 4, -3, 3, 0] }}
                    exit={{ opacity: 0, scale: 0.5 }}
                    transition={{ duration: 0.4 }}
                    className="silent-icon-wrap"
                  >
                    <X size={20} />
                  </motion.span>
                ) : (
                  <motion.span
                    key="idle"
                    initial={{ opacity: 0, scale: 0.5 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.5 }}
                    transition={{ duration: 0.15 }}
                    className="silent-icon-wrap fan-off-icon"
                  >
                    <Fan size={20} />
                  </motion.span>
                )}
              </AnimatePresence>
            </motion.button>
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
                      {animatedTemp != null ? animatedTemp.toFixed(1) : '--'}
                    </span>
                    <span className="temperature-unit">°</span>
                  </div>
                </div>
                <div className="humidity-indicator">
                  <Droplets size={20} className="humidity-icon" />
                  <span className="humidity-value">{animatedHumidity != null ? animatedHumidity.toFixed(0) : '--'}%</span>
                </div>
              </div>

              <div className="stats-grid">
                {([
                  { key: data?.central_board_status, label: 'Центральная плата', Icon: Cpu,    defaultStatus: 'online' },
                  { key: data?.camera_status,         label: 'Камера',            Icon: Camera, defaultStatus: 'never_connected' },
                  { key: data?.sensor_status,         label: 'Датчик двери',      Icon: Eye,    defaultStatus: 'online' },
                  { key: data?.toilet_status,         label: 'Уборная',           Icon: Bath,   defaultStatus: 'online' },
                ] as const).map(({ key, label, Icon, defaultStatus }) => {
                  const s = getStatusStyle(key || defaultStatus)
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
                    {animatedWeatherTemp ?? '--'}°
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
              <div className="tile-glow" style={{ background: 'rgba(96,165,250,0.2)' }} />
              <div className="card-icon" style={
                !data?.disk_usage ? {} :
                data.disk_usage.free_gb <= DISK_CRITICAL_GB ? ALERT_ICON :
                data.disk_usage.free_gb <= DISK_WARNING_GB ? WARN_ICON :
                { background: TILE_COLORS.disk.bg, color: TILE_COLORS.disk.color }
              }>
                <HardDrive size={20} />
              </div>
              <div>
                <div className="card-label">Диск</div>
                <div className="card-value">
                  {data?.disk_usage ? `${data.disk_usage.free_gb} GB` : '--'}
                </div>
                <div className="card-detail">
                  {data?.disk_usage ? `свободно из ${data.disk_usage.total_gb} GB` : 'нет данных'}
                </div>
              </div>
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{
                    width: data?.disk_usage ? `${data.disk_usage.used_percent}%` : '0%',
                  }}
                />
              </div>
            </motion.div>

            <motion.div variants={itemVar} className="system-card">
              <div className="tile-glow" style={{ background: 'rgba(129,140,248,0.2)' }} />
              <div className="card-icon" style={
                (weather?.wind_speed ?? 0) >= 12 ? { background: 'rgba(239,68,68,0.15)', color: '#f87171' } :
                (weather?.wind_speed ?? 0) >= 8  ? { background: 'rgba(251,191,36,0.15)', color: '#fbbf24' } :
                { background: 'rgba(99,102,241,0.15)', color: '#818cf8' }
              }>
                <Wind size={20} />
              </div>
              <div>
                <div className="card-label">Ветер</div>
                <div className="card-value">{weather?.wind_speed ?? '--'}</div>
                <div className="card-detail">м/с</div>
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

            {/* RAM */}
            <motion.div variants={itemVar} className="system-card">
              <div className="tile-glow" style={{ background: 'rgba(52,211,153,0.2)' }} />
              <div className="card-icon" style={loadIconStyle(data?.memory_usage?.used_percent, TILE_COLORS.memory)}>
                <MemoryStick size={20} />
              </div>
              <div>
                <div className="card-label">Память</div>
                <div className="card-value">
                  {data?.memory_usage ? `${data.memory_usage.used_gb} GB` : '--'}
                </div>
                <div className="card-detail">
                  {data?.memory_usage ? `занято из ${data.memory_usage.total_gb} GB` : 'нет данных'}
                </div>
              </div>
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{
                    width: data?.memory_usage ? `${data.memory_usage.used_percent}%` : '0%',
                  }}
                />
              </div>
            </motion.div>

            {/* CPU */}
            <motion.div variants={itemVar} className="system-card">
              <div className="tile-glow" style={{ background: 'rgba(248,113,113,0.2)' }} />
              <div className="card-icon" style={loadIconStyle(data?.cpu_usage?.used_percent, TILE_COLORS.cpu)}>
                <Cpu size={20} />
              </div>
              <div>
                <div className="card-label">Процессор</div>
                <div className="card-value">
                  {data?.cpu_usage ? `${data.cpu_usage.used_percent}%` : '--'}
                </div>
                <div className="card-detail">
                  {data?.cpu_usage ? `загрузка · ${data.cpu_usage.cores} ядер` : 'нет данных'}
                </div>
              </div>
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{
                    width: data?.cpu_usage ? `${data.cpu_usage.used_percent}%` : '0%',
                  }}
                />
              </div>
            </motion.div>
          </div>
          
          <TemperatureChart theme={theme} />

          {downtimeStats && (
            <motion.div variants={itemVar} className="glass-card">
              <div className="card-content">
                <div className="stat-item" style={{ marginBottom: '16px', paddingBottom: '12px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                  <div className="stat-icon" style={{ background: 'rgba(16,185,129,0.15)', color: '#34d399' }}>
                    <Activity size={18} />
                  </div>
                  <div className="stat-info">
                    <span className="stat-label">Доступность · 7 дней</span>
                    <span className="stat-value" style={{ color: getUptimeColor(overallUptime), fontWeight: 700 }}>
                      {overallUptime}% в среднем
                    </span>
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  {Object.entries(downtimeStats).map(([deviceId, device]) => {
                    const sortedDays = Object.entries(device.days).sort(([a], [b]) => a.localeCompare(b))
                    const totalMin = Math.round(device.total_downtime_seconds / 60)
                    const avgUptime = sortedDays.length
                      ? Math.round(sortedDays.reduce((s, [, d]) => s + d.uptime_pct, 0) / sortedDays.length * 10) / 10
                      : 100
                    const isExpanded = expandedDevices.has(deviceId)

                    return (
                      <div key={deviceId} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', paddingBottom: '12px' }}>

                        {/* Заголовок — разворачивает полосы */}
                        <div
                          onClick={() => setExpandedDevices(prev => {
                            const next = new Set(prev)
                            next.has(deviceId) ? next.delete(deviceId) : next.add(deviceId)
                            return next
                          })}
                          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: isExpanded ? '10px' : 0, cursor: 'pointer', userSelect: 'none' }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <ChevronDown size={15} style={{
                              color: 'var(--text-secondary)',
                              transform: isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)',
                              transition: 'transform 0.2s ease',
                              flexShrink: 0,
                            }} />
                            <span style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>{device.name}</span>
                          </div>
                          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                            {totalMin > 0 && (
                              <span style={{ fontSize: '12px', color: avgUptime < 99 ? '#f87171' : 'var(--text-secondary)' }}>
                                ↓ {totalMin >= 60 ? `${Math.floor(totalMin / 60)}ч ${totalMin % 60}м` : `${totalMin}м`}
                              </span>
                            )}
                            <span style={{ fontSize: '14px', fontWeight: 700, color: getUptimeColor(avgUptime) }}>
                              {avgUptime}%
                            </span>
                          </div>
                        </div>

                        {/* Тайм-лайн: разворачивается по клику на заголовок */}
                        <AnimatePresence initial={false}>
                          {isExpanded && (
                            <motion.div
                              key="days"
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: 'auto', opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ duration: 0.2, ease: 'easeInOut' }}
                              style={{ overflow: 'hidden' }}
                            >
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                {sortedDays.map(([dateStr, dayData]) => {
                                  const label = dateStr.slice(5)
                                  const dayStart = new Date(dateStr + 'T00:00:00+04:00').getTime()
                                  const dayEnd = dayStart + 86400000

                                  return (
                                    <div
                                      key={dateStr}
                                      className="downtime-day-row"
                                      onClick={() => {
                                        setSelectedDowntimeDevice(deviceId)
                                        setSelectedDowntimeDate(dateStr)
                                      }}
                                      style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', borderRadius: '6px', padding: '4px 6px' }}
                                    >
                                      <span style={{ fontSize: '10px', color: 'var(--text-secondary)', width: '36px', flexShrink: 0 }}>{label}</span>
                                      <div style={{ flex: 1, height: '8px', borderRadius: '4px', background: 'rgba(52,211,153,0.25)', position: 'relative', overflow: 'hidden' }}>
                                        {dayData.intervals.filter(iv => {
                                          const startMs = new Date(iv.start).getTime()
                                          const endMs = iv.end ? new Date(iv.end).getTime() : Date.now()
                                          return Math.round((endMs - startMs) / 60000) > 0
                                        }).map((iv, i) => {
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
                                      <span style={{ fontSize: '10px', color: getUptimeColor(dayData.uptime_pct), width: '28px', textAlign: 'right', flexShrink: 0 }}>
                                        {dayData.uptime_pct}%
                                      </span>
                                      <Search size={13} style={{ color: 'var(--text-secondary)', opacity: 0.8, flexShrink: 0 }} />
                                    </div>
                                  )
                                })}
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    )
                  })}
                </div>
              </div>
            </motion.div>
          )}

          {isAdmin && visitStats !== null && (
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
                    {visitStats.map((user, idx) => {
                      const sortedDays = Object.entries(user.days).sort(([a], [b]) => b.localeCompare(a))
                      const totalVisits = Object.values(user.days).reduce((s, d) => s + d.length, 0)
                      const isLast = idx === visitStats.length - 1
                      return (
                        <div key={user.name} style={isLast ? {} : { borderBottom: '1px solid rgba(255,255,255,0.04)', paddingBottom: '10px' }}>
                          <div className="stat-item" style={{ marginBottom: '6px' }}>
                            <div className="stat-icon" style={{ background: 'rgba(99,102,241,0.15)', color: '#818cf8' }}>
                              <User size={18} />
                            </div>
                            <div className="stat-info">
                              <span className="stat-label">{user.name}</span>
                              <span className="stat-value">{totalVisits} визит{totalVisits === 1 ? '' : totalVisits < 5 ? 'а' : 'ов'} за 7 дней</span>
                            </div>
                          </div>
                          <div style={{ paddingLeft: '48px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                            {sortedDays.map(([date, entries]) => (
                              <div key={date} style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                <span style={{ opacity: 0.6, fontWeight: 600 }}>{date}</span>
                                {entries.map((entry, i) => (
                                  <span key={i} style={{ wordBreak: 'break-word' }}>
                                    {entry.time}
                                    {entry.routes.length > 0 && ` (${entry.routes.join(', ')})`}
                                  </span>
                                ))}
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
        {data?.disk_usage && data.disk_usage.free_gb <= DISK_CRITICAL_GB && !loading && (
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
      
      <AnimatePresence>
        {selectedDowntimeDevice && downtimeStats && downtimeStats[selectedDowntimeDevice] && (() => {
          const device = downtimeStats[selectedDowntimeDevice]
          const sortedDays = Object.entries(device.days).sort(([a], [b]) => a.localeCompare(b))
          const totalMin = Math.round(device.total_downtime_seconds / 60)

          const fmtTime = (iso: string) =>
            new Date(iso).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })

          const fmtDate = (dateStr: string) => {
            const [, month, day] = dateStr.split('-')
            const months = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек']
            return `${parseInt(day)} ${months[parseInt(month) - 1]}`
          }

          return (
            <motion.div
              key="downtime-modal-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => { setSelectedDowntimeDevice(null); setSelectedDowntimeDate(null) }}
              style={{
                position: 'fixed', inset: 0, zIndex: 1000,
                background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
                display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
              }}
            >
              <motion.div
                key="downtime-modal-panel"
                initial={{ y: 60, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: 60, opacity: 0 }}
                transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                onClick={(e) => e.stopPropagation()}
                style={{
                  width: '100%', maxWidth: '480px',
                  maxHeight: '82vh', overflowY: 'auto', overscrollBehavior: 'contain',
                  background: theme === 'dark' ? '#1a1f2e' : '#fff',
                  borderRadius: '20px 20px 0 0',
                  padding: '24px 20px 40px',
                  boxShadow: '0 -8px 40px rgba(0,0,0,0.4)',
                }}
              >
                {/* Шапка */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                  <div>
                    <div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)' }}>{device.name}</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                      {totalMin === 0
                        ? 'Отключений не зафиксировано'
                        : `Всего: ${totalMin >= 60 ? `${Math.floor(totalMin / 60)}ч ${totalMin % 60}м` : `${totalMin} мин`}`
                      }
                    </div>
                  </div>
                  <button
                    onClick={() => { setSelectedDowntimeDevice(null); setSelectedDowntimeDate(null) }}
                    style={{
                      background: 'rgba(255,255,255,0.08)', border: 'none', borderRadius: '50%',
                      width: '32px', height: '32px', cursor: 'pointer',
                      color: 'var(--text-secondary)', fontSize: '18px', lineHeight: '32px', textAlign: 'center',
                    }}
                  >×</button>
                </div>

                {/* Разбивка по дням */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  {sortedDays.map(([dateStr, dayData]) => {
                    const isHighlighted = dateStr === selectedDowntimeDate
                    return (
                    <div
                      key={dateStr}
                      data-downtime-date={dateStr}
                      style={{
                        borderRadius: '10px',
                        padding: isHighlighted ? '10px' : 0,
                        margin: isHighlighted ? '-10px' : 0,
                        background: isHighlighted ? 'rgba(129,140,248,0.1)' : 'transparent',
                        border: isHighlighted ? '1px solid rgba(129,140,248,0.3)' : '1px solid transparent',
                        transition: 'background 0.3s ease, border-color 0.3s ease',
                      }}
                    >
                      <div style={{
                        fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)',
                        marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.05em'
                      }}>
                        {fmtDate(dateStr)}
                        <span style={{ marginLeft: '8px', fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: getUptimeColor(dayData.uptime_pct) }}>
                          · {dayData.uptime_pct}% онлайн
                        </span>
                      </div>

                      {(() => {
                        const visibleIntervals = dayData.intervals.filter(iv => {
                          const startMs = new Date(iv.start).getTime()
                          const endMs = iv.end ? new Date(iv.end).getTime() : Date.now()
                          return Math.round((endMs - startMs) / 60000) > 0
                        })
                        return visibleIntervals.length === 0 ? (
                          <div style={{ fontSize: '13px', color: '#34d399', paddingLeft: '4px' }}>Без отключений</div>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                            {visibleIntervals.map((iv, i) => {
                              const startMs = new Date(iv.start).getTime()
                              const endMs = iv.end ? new Date(iv.end).getTime() : Date.now()
                              const durMin = Math.round((endMs - startMs) / 60000)
                              return (
                                <div key={i} style={{
                                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                  padding: '6px 10px', borderRadius: '8px',
                                  background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.2)',
                                }}>
                                  <span style={{ fontSize: '13px', color: '#f87171', fontVariantNumeric: 'tabular-nums' }}>
                                    {fmtTime(iv.start)} — {iv.end ? fmtTime(iv.end) : 'сейчас'}
                                  </span>
                                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                                    {durMin >= 60 ? `${Math.floor(durMin / 60)}ч ${durMin % 60}м` : `${durMin} мин`}
                                  </span>
                                </div>
                              )
                            })}
                          </div>
                        )
                      })()}
                    </div>
                  )})}
                </div>
              </motion.div>
            </motion.div>
          )
        })()}
      </AnimatePresence>
    </div>
  )
}