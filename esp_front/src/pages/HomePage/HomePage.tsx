import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { 
  Thermometer, Droplets, Bluetooth, Gauge, Clock, AlertCircle,
  Sun, Cloud, CloudRain, CloudSnow, CloudLightning, CloudDrizzle, 
  Sunrise, Sunset, Moon, Settings2, RefreshCw, Wind, Zap
} from 'lucide-react'
import SettingsPage from '../SettingsPage/SettingsPage'
import { apiClient } from '../../api/client'
import './HomePage.css'

// --- Типы и Хелперы (без изменений) ---
type WeatherData = {
  current_temp: number; current_feels_like: number; current_condition: string;
  humidity: number; wind_speed: number; evening_temp?: number;
  night_temp?: number; morning_temp?: number; day_temp?: number;
  timestamp: string; expires_at: string; api_calls_today: number;
}
type Telemetry = {
  device_id: string; temperature: number; humidity: number;
  free_memory?: number; uptime?: number; timestamp?: string;
  bluetooth_is_active?: boolean;
}

const weatherTranslations: Record<string, string> = {
  'clear': 'Ясно', 'partly_cloudy': 'Облачно', 'cloudy': 'Облачно',
  'overcast': 'Пасмурно', 'light_rain': 'Дождь', 'rain': 'Дождь',
  'heavy_rain': 'Ливень', 'thunderstorm': 'Гроза', 'snow': 'Снег',
}

const getWeatherIcon = (condition: string, size = 24) => {
  const cond = condition.toLowerCase();
  const props = { size, strokeWidth: 1.5 };
  // Класс "weather-icon" будет определён в CSS (можно добавить позже, если нужно)
  if (cond.includes('clear')) return <Sun {...props} className="weather-icon sun" />;
  if (cond.includes('rain')) return <CloudRain {...props} className="weather-icon rain" />;
  if (cond.includes('cloud')) return <Cloud {...props} className="weather-icon cloud" />;
  if (cond.includes('snow')) return <CloudSnow {...props} className="weather-icon snow" />;
  return <Sun {...props} className="weather-icon" />;
}

// --- Анимации (без изменений) ---
const containerVar = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.1 } }
}
const itemVar = {
  hidden: { y: 20, opacity: 0, scale: 0.95 },
  visible: { y: 0, opacity: 1, scale: 1, transition: { type: "spring", stiffness: 150, damping: 15 } }
}

export default function HomePage() {
  const [theme, setTheme] = useState<'dark' | 'light'>('light')
  const [data, setData] = useState<Telemetry | null>(null)
  const [weather, setWeather] = useState<WeatherData | null>(null)
  const [loading, setLoading] = useState(true)
  const [isStale, setIsStale] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  const fetchData = async () => {
    try {
      setLoading(true)
      const res = await apiClient.fetch('/esp_service/telemetry')
      setData(res)
      setIsStale((new Date().getTime() - new Date(res.timestamp).getTime()) / 60000 > 5)
    } catch { setIsStale(true) } finally { setLoading(false) }
  }
  const fetchWeather = async () => {
    try { const res = await apiClient.fetch('/esp_service/weather'); setWeather(res); } catch {}
  }
  useEffect(() => {
    const hour = new Date().getHours()
    setTheme(hour >= 6 && hour < 18 ? 'light' : 'dark')
    fetchData(); 
    fetchWeather(); 
  }, [])

  const toggleTheme = () => {
    setTheme(prev => prev === 'light' ? 'dark' : 'light')
  }

 if (showSettings) return (
    <SettingsPage 
      onClose={() => setShowSettings(false)} 
      theme={theme}
      onThemeToggle={toggleTheme}
    />
  )

  return (
    <div className={`home-container ${theme}`}>
      
      {/* Живой фон */}
      <div className="background-spot">
        
      </div>

      <div className="main-content">
        
        {/* Header */}
        <header className="header">
          <div>
            <h1 className="header-title">
              {data?.device_id || 'Мой Дом'}
            </h1>
            <div className="status">
              <span className={`status-dot ${isStale ? 'offline' : 'online'}`}>
                <span></span>
              </span>
              <span className="status-text">
                {loading ? 'Обновление...' : isStale ? 'Нет связи' : 'Онлайн'}
              </span>
            </div>
          </div>
          
          <div className="header-actions">
            {/* Кнопка переключения темы */}
            <motion.button
              whileHover={{ scale: 1.1, rotate: theme === 'light' ? 180 : -180 }}
              whileTap={{ scale: 0.9 }}
              onClick={toggleTheme}
              className="theme-button"
              title={theme === 'light' ? 'Переключить на тёмную тему' : 'Переключить на светлую тему'}
            >
              {theme === 'light' ? <Moon size={20} /> : <Sun size={20} />}
            </motion.button>

            {/* Кнопка настроек */}
            <motion.button 
              whileHover={{ rotate: 90 }}
              whileTap={{ scale: 0.9 }}
              onClick={() => setShowSettings(true)}
              className="settings-button"
            >
              <Settings2 size={20} />
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
                      {data?.temperature.toFixed(1) || '--'}
                    </span>
                    <span className="temperature-unit">°</span>
                  </div>
                </div>
                <div className="humidity-indicator">
                  <Droplets size={20} className="humidity-icon" />
                  <span className="humidity-value">{data?.humidity.toFixed(0) || '--'}%</span>
                </div>
              </div>

              <div className="stats-grid">
                <div className="stat-item">
                  <div className={`stat-icon ${data?.bluetooth_is_active ? 'active' : 'inactive'}`}>
                    <Bluetooth size={18} />
                  </div>
                  <div className="stat-info">
                    <span className="stat-label">Bluetooth</span>
                    <span className="stat-value">{data?.bluetooth_is_active ? 'Активен' : 'Выкл'}</span>
                  </div>
                </div>
                <div className="stat-item">
                  <div className="stat-icon active" style={{ background: 'rgba(147, 51, 234, 0.2)', color: '#c084fc' }}>
                    <Zap size={18} />
                  </div>
                  <div className="stat-info">
                    <span className="stat-label">ESP32</span>
                    <span className="stat-value">Работает</span>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>

          {/* Grid Layout */}
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

            {/* System Stats (Memory) */}
            <motion.div variants={itemVar} className="system-card">
              <div className="card-icon icon-emerald">
                <Gauge size={20} />
              </div>
              <div>
                <div className="card-value">{data ? Math.round(data.free_memory! / 1024) : '--'}</div>
                <div className="card-label">Free KB</div>
              </div>
              <div className="progress-bar">
                <div className="progress-fill fill-emerald" style={{ width: '70%' }} />
              </div>
            </motion.div>

            {/* System Stats (Wind) */}
            <motion.div variants={itemVar} className="system-card">
              <div className="card-icon icon-indigo">
                <Wind size={20} />
              </div>
              <div>
                <div className="card-value">{weather?.wind_speed ?? 0}</div>
                <div className="card-label">Метры/Сек</div>
              </div>
              <div className="progress-bar">
                <div className="progress-fill fill-indigo" style={{ width: '40%' }} />
              </div>
            </motion.div>

          </div>
        </motion.div>
      </div>

      {/* Floating Bottom Bar */}
      <div className="bottom-bar">
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={fetchData}
          disabled={loading}
          className="update-button"
        >
          <div className="button-shine" />
          <RefreshCw size={18} className={`button-icon ${loading ? 'spin' : ''}`} />
          {loading ? 'СИНХРОНИЗАЦИЯ...' : 'ОБНОВИТЬ ДАННЫЕ'}
        </motion.button>
      </div>

      {/* Alert Overlay */}
      <AnimatePresence>
        {isStale && !loading && (
          <motion.div 
            initial={{ y: 50, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 50, opacity: 0 }}
            className="alert-message"
          >
            <AlertCircle size={24} className="alert-icon" />
            <div className="alert-content">
              <p className="alert-title">Внимание</p>
              <p className="alert-text">Данные устарели. Проверьте питание ESP.</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  )
}