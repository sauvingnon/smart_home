import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Thermometer, Droplets, Camera, Cpu, AlertCircle,
  Sun, Cloud, CloudRain, CloudSnow,
  Sunrise, Sunset, Moon, Wind, DoorOpen, HardDrive
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

// Маппинг статусов на русский
const getBoardStatusText = (status: string): string => {
  const map: Record<string, string> = {
    'online': 'Онлайн',
    'offline': 'Нет связи',
    'dead': 'Не отвечает',
    'never_connected': 'Не подключена'
  };
  return map[status.toLowerCase()] || status;
};

const getCameraStatusText = (status: string): string => {
  const map: Record<string, string> = {
    'connected': 'Подключена',
    'streaming': 'Стрим',
    'recording': 'Запись',
    'offline': 'Нет связи',
    'never_connected': 'Не подключена'
  };
  return map[status.toLowerCase()] || status;
};

// Определение цвета иконки для статуса
const getStatusIconClass = (status: string): string => {
  const activeStatuses = ['online', 'connected', 'streaming', 'recording'];
  return activeStatuses.includes(status.toLowerCase()) ? 'active' : 'inactive';
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
  const { theme, toggleTheme } = useTheme()
  const [data, setData] = useState<GeneralResponse | null>(null)
  const [weather, setWeather] = useState<WeatherData | null>(null)
  const [loading, setLoading] = useState(true)

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

  // Функция проверки - все ли устройства онлайн
  const isAllOnline = (): boolean => {
    if (!data) return false;
    
    const allStatuses = [
      data.central_board_status,
      data.camera_status,
      data.sensor_status,
      data.toilet_status
    ];
    
    // Все должны быть online или connected/streaming/recording для камеры
    return allStatuses.every(status => {
      const activeStatuses = ['online', 'connected', 'streaming', 'recording'];
      return activeStatuses.includes(status?.toLowerCase() || '');
    });
  };

  // Функция получения текста статуса
  const getGlobalStatusText = (): string => {
    if (loading) return 'Обновление...';
    if (!data) return 'Нет данных';
    
    const allOnline = isAllOnline();
    
    if (allOnline) return 'Всё работает';
    
    // Считаем сколько офлайн
    const offlineCount = [
      data.central_board_status,
      data.camera_status,
      data.sensor_status,
      data.toilet_status
    ].filter(status => {
      const activeStatuses = ['online', 'connected', 'streaming', 'recording'];
      return !activeStatuses.includes(status?.toLowerCase() || '');
    }).length;
    
    if (offlineCount === 4) return 'Нет связи';
    if (offlineCount >= 2) return 'Частично недоступно';
    return 'Есть проблемы';
  };
  
  useEffect(() => {
    fetchData();
    fetchWeather();
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
              whileHover={{ scale: 1.1, rotate: theme === 'light' ? 180 : -180 }}
              whileTap={{ scale: 0.9 }}
              onClick={toggleTheme}
              className="theme-button"
              title={theme === 'light' ? 'Переключить на тёмную тему' : 'Переключить на светлую тему'}
            >
              {theme === 'light' ? <Moon size={20} /> : <Sun size={20} />}
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
                {/* Центральная плата */}
                <div className="stat-item">
                  <div className={`stat-icon ${getStatusIconClass(data?.central_board_status || 'offline')}`} 
                      style={getStatusIconClass(data?.central_board_status || 'offline') === 'active' 
                        ? { background: 'rgba(147, 51, 234, 0.2)', color: '#c084fc' } 
                        : { background: 'rgba(239, 68, 68, 0.15)', color: '#f87171' }}>
                    <Cpu size={18} />
                    {getStatusIconClass(data?.central_board_status || 'offline') !== 'active' && (
                      <span className="stat-icon-pulse" />
                    )}
                  </div>
                  <div className="stat-info">
                    <span className="stat-label">Центральная плата</span>
                    <span className={`stat-value ${getStatusIconClass(data?.central_board_status || 'offline') !== 'active' ? 'offline-text' : ''}`}>
                      {getBoardStatusText(data?.central_board_status || 'offline')}
                    </span>
                  </div>
                </div>

                {/* Камера */}
                <div className="stat-item">
                  <div className={`stat-icon ${getStatusIconClass(data?.camera_status || 'offline')}`}
                      style={getStatusIconClass(data?.camera_status || 'offline') !== 'active' 
                        ? { background: 'rgba(239, 68, 68, 0.15)', color: '#f87171' } 
                        : {}}>
                    <Camera size={18} />
                    {getStatusIconClass(data?.camera_status || 'offline') !== 'active' && (
                      <span className="stat-icon-pulse" />
                    )}
                  </div>
                  <div className="stat-info">
                    <span className="stat-label">Камера</span>
                    <span className={`stat-value ${getStatusIconClass(data?.camera_status || 'offline') !== 'active' ? 'offline-text' : ''}`}>
                      {getCameraStatusText(data?.camera_status || 'offline')}
                    </span>
                  </div>
                </div>

                {/* Датчик двери */}
                <div className="stat-item">
                  <div className={`stat-icon ${getStatusIconClass(data?.sensor_status || 'offline')}`}
                      style={getStatusIconClass(data?.sensor_status || 'offline') !== 'active' 
                        ? { background: 'rgba(239, 68, 68, 0.15)', color: '#f87171' } 
                        : {}}>
                    <DoorOpen size={18} />
                    {getStatusIconClass(data?.sensor_status || 'offline') !== 'active' && (
                      <span className="stat-icon-pulse" />
                    )}
                  </div>
                  <div className="stat-info">
                    <span className="stat-label">Датчик двери</span>
                    <span className={`stat-value ${getStatusIconClass(data?.sensor_status || 'offline') !== 'active' ? 'offline-text' : ''}`}>
                      {getBoardStatusText(data?.sensor_status || 'offline')}
                    </span>
                  </div>
                </div>

                {/* Уборная */}
                <div className="stat-item">
                  <div className={`stat-icon ${getStatusIconClass(data?.toilet_status || 'offline')}`}
                      style={getStatusIconClass(data?.toilet_status || 'offline') === 'active' 
                        ? { background: 'rgba(34, 197, 94, 0.2)', color: '#4ade80' } 
                        : { background: 'rgba(239, 68, 68, 0.15)', color: '#f87171' }}>
                    <DoorOpen size={18} />
                    {getStatusIconClass(data?.toilet_status || 'offline') !== 'active' && (
                      <span className="stat-icon-pulse" />
                    )}
                  </div>
                  <div className="stat-info">
                    <span className="stat-label">Уборная</span>
                    <span className={`stat-value ${getStatusIconClass(data?.toilet_status || 'offline') !== 'active' ? 'offline-text' : ''}`}>
                      {getBoardStatusText(data?.toilet_status || 'offline')}
                    </span>
                  </div>
                </div>
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
                      undefined,
                  }}
                />
              </div>
            </motion.div>

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
          
          <TemperatureChart theme={theme} />

          {/* Новый блок с ИИ отчётами */}
          <AIReport theme={theme} />

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