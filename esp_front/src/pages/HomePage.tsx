import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Moon } from 'lucide-react'
import { 
  Thermometer, Droplets, Bluetooth, Fan, Lightbulb, Gauge, Clock, AlertCircle,
  Sun, Cloud, CloudRain, CloudSnow, CloudLightning, CloudDrizzle, Wind, 
  Sunrise, Sunset
} from 'lucide-react'
import SettingsPage from './SettingsPage'
import { API_ENDPOINTS } from '../config'

// Тип для данных погоды
type WeatherData = {
  current_temp: number
  current_feels_like: number
  current_condition: string
  humidity: number
  wind_speed: number
  evening_temp?: number
  night_temp?: number
  morning_temp?: number
  day_temp?: number
  timestamp: string
  expires_at: string
  api_calls_today: number
}

type Telemetry = {
  device_id: string
  temperature: number
  humidity: number
  free_memory?: number
  uptime?: number
  timestamp?: string
  bluetooth_is_active?: boolean
}

// Словарь для перевода погодных условий (приводим к нижнему регистру)
const weatherTranslations: Record<string, string> = {
  'clear': 'Ясно',
  'partly_cloudy': 'Переменная облачность',
  'cloudy': 'Облачно',
  'overcast': 'Пасмурно',
  'light_rain': 'Небольшой дождь',
  'rain': 'Дождь',
  'heavy_rain': 'Сильный дождь',
  'showers': 'Ливень',
  'sleet': 'Мокрый снег',
  'light_snow': 'Небольшой снег',
  'snow': 'Снег',
  'snowfall': 'Снегопад',
  'hail': 'Град',
  'thunderstorm': 'Гроза',
  'thunderstorm_with_rain': 'Гроза с дождем',
  'thunderstorm_with_hail': 'Гроза с градом',
}

// Функция перевода погоды
const translateWeather = (condition: string): string => {
  if (!condition) return 'Неизвестно'
  // Приводим к нижнему регистру и убираем лишние пробелы
  const normalized = condition.toLowerCase().trim()
  // Ищем в словаре, если нет - возвращаем как есть
  return weatherTranslations[normalized] || condition
}

// Функция для получения иконки погоды (на основе английских ключей)
const getWeatherIcon = (condition: string, size: number = 24) => {
  const cond = condition.toLowerCase().trim()
  const props = { size, strokeWidth: 1.5 }
  
  if (cond.includes('clear')) return <Sun {...props} className="weather-icon sun" />
  if (cond.includes('partly_cloudy')) return <Cloud {...props} className="weather-icon cloud" />
  if (cond.includes('cloudy')) return <Cloud {...props} className="weather-icon cloud" />
  if (cond.includes('overcast')) return <Cloud {...props} className="weather-icon cloud" />
  if (cond.includes('rain') || cond.includes('showers')) return <CloudRain {...props} className="weather-icon rain" />
  if (cond.includes('snow') || cond.includes('sleet') || cond.includes('snowfall')) return <CloudSnow {...props} className="weather-icon snow" />
  if (cond.includes('thunderstorm')) return <CloudLightning {...props} className="weather-icon storm" />
  if (cond.includes('hail')) return <CloudDrizzle {...props} className="weather-icon hail" />
  
  return <Cloud {...props} className="weather-icon" />
}

// Цвета для разных температур
const getTempColor = (temp: number) => {
  if (temp <= -10) return 'cold'
  if (temp <= 0) return 'cool'
  if (temp <= 15) return 'mild'
  if (temp <= 25) return 'warm'
  return 'hot'
}

export default function HomePage() {
  const [data, setData] = useState<Telemetry | null>(null)
  const [weather, setWeather] = useState<WeatherData | null>(null)
  const [weatherLoading, setWeatherLoading] = useState(true)
  const [loading, setLoading] = useState(true)
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [isStale, setIsStale] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  const isDataFresh = (timestamp?: string) => {
    if (!timestamp) return false
    const dataTime = new Date(timestamp)
    const now = new Date()
    const diffMinutes = (now.getTime() - dataTime.getTime()) / (1000 * 60)
    return diffMinutes <= 2
  }

  const fetchData = async () => {
    try {
      setLoading(true)
      const res = await fetch(API_ENDPOINTS.telemetry)
      if (!res.ok) throw new Error('fetch')
      const json = await res.json()
      setData(json)
      setLastUpdate(new Date())
      setIsStale(!isDataFresh(json.timestamp))
    } catch (e) {
      setIsStale(true)
      setData(null)
    } finally {
      setLoading(false)
    }
  }

  const fetchWeather = async () => {
    try {
      setWeatherLoading(true)
      const res = await fetch(API_ENDPOINTS.weather)
      if (!res.ok) throw new Error('weather fetch')
      const json = await res.json()
      setWeather(json)
    } catch (e) {
      console.error('Weather fetch failed:', e)
      setWeather(null)
    } finally {
      setWeatherLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
    fetchWeather()
    const iv = setInterval(() => {
      fetchData()
      fetchWeather()
    }, 30000)
    return () => clearInterval(iv)
  }, [])

  const formatTime = (d: Date) => d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Europe/Samara' })
  const formatUptime = (s?: number) => {
    if (!s) return '--ч --м'
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    return `${h}ч ${m}м`
  }

  if (showSettings) {
    return <SettingsPage onClose={() => setShowSettings(false)} />
  }

  return (
    <div className="page-bg">
      <div className="center-col">
        <div className="header-row">
          <h1 className="device-title">{data?.device_id || 'ESP Control'}</h1>
          <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} className={`status-badge ${loading ? 'status-loading' : isStale ? 'status-stale' : 'status-ok'}`}>
            <span className={`dot ${loading ? 'dot-yellow' : isStale ? 'dot-red' : 'dot-green'}`} />
            <span className="status-text">{loading ? 'Загрузка' : isStale ? 'Данные устарели' : 'Онлайн'}</span>
          </motion.div>
        </div>

        <AnimatePresence>
          {isStale && !loading && (
            <motion.div initial={{ opacity:0, y:-6 }} animate={{ opacity:1, y:0 }} exit={{ opacity:0, y:-6 }} className="stale-warning">
              <AlertCircle className="warn-icon" />
              <div>
                <div className="font-medium">Данные устарели</div>
                <div className="text-xs muted">Последнее обновление: {lastUpdate ? formatTime(lastUpdate) : 'никогда'}</div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="card climate-card">
          <div className="climate-inner">
            {loading && !data ? (
              <div className="loading-block">
                <div className="spinner" />
                <div className="muted">Загрузка данных...</div>
              </div>
            ) : (
              <>
                <div className="grid-2">
                  <div>
                    <div className="label"><Thermometer className="icon-sm"/> Температура</div>
                    <div className="big-val">{data ? data.temperature.toFixed(1) : '--'} <span className="unit">°C</span></div>
                  </div>
                  <div>
                    <div className="label"><Droplets className="icon-sm"/> Влажность</div>
                    <div className="big-val">{data ? data.humidity.toFixed(1) : '--'} <span className="unit">%</span></div>
                  </div>
                </div>

                <div className="climate-stats">
                  <div className="stat"><Clock className="icon-xs"/> <span>{formatUptime(data?.uptime)}</span></div>
                  <div className="stat"><Gauge className="icon-xs"/> <span>{data ? `${Math.round((data.free_memory||0)/1024)}Кб` : '--'}</span></div>
                  <div className="stat"><Bluetooth className="icon-xs"/> <span>{data && !isStale
  ? data.bluetooth_is_active
    ? 'Bluetooth активен'
    : 'Bluetooth неактивен'
  : 'Неизвестно'}
</span></div>
                </div>
              </>
            )}
          </div>
        </div>

        {/* КРАСИВЫЙ БЛОК ПОГОДЫ */}
        <motion.div 
          className="card weather-card"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          <div className="weather-header">
            <div className="weather-title">
              <Sun size={20} />
              <span>Погода сейчас</span>
            </div>
            {weather?.api_calls_today !== undefined && (
              <div className="weather-api-calls">
                <span className="api-badge">API: {weather.api_calls_today}/30</span>
              </div>
            )}
          </div>

          {weatherLoading && !weather ? (
            <div className="weather-loading">
              <div className="spinner small" />
              <span>Загрузка погоды...</span>
            </div>
          ) : weather ? (
            <>
              {/* Основной блок с текущей погодой */}
              <div className="weather-current">
                <div className="weather-main">
                  <div className="weather-icon-large">
                    {getWeatherIcon(weather.current_condition, 64)}
                  </div>
                  <div className="weather-temp-large">
                    <span className={`temp-value ${getTempColor(weather.current_temp)}`}>
                      {weather.current_temp > 0 ? '+' : ''}{weather.current_temp}°
                    </span>
                    <span className="weather-condition">
                      {translateWeather(weather.current_condition)}
                    </span>
                  </div>
                </div>

                <div className="weather-feels-like">
                  Ощущается как {weather.current_feels_like > 0 ? '+' : ''}{weather.current_feels_like}°
                </div>

                {/* Детальная информация */}
                <div className="weather-details">
                  <div className="weather-detail-item">
                    <Droplets size={18} />
                    <div>
                      <div className="detail-label">Влажность</div>
                      <div className="detail-value">{weather.humidity}%</div>
                    </div>
                  </div>
                  <div className="weather-detail-item">
                    <Wind size={18} />
                    <div>
                      <div className="detail-label">Ветер</div>
                      <div className="detail-value">{weather.wind_speed} м/с</div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Прогноз по времени суток */}
              {(weather.morning_temp !== undefined || weather.day_temp !== undefined || 
                weather.evening_temp !== undefined || weather.night_temp !== undefined) && (
                <div className="weather-forecast">
                  <div className="forecast-title">Прогноз на день</div>
                  <div className="forecast-grid">
                    {weather.morning_temp !== undefined && (
                      <div className="forecast-item">
                        <Sunrise size={16} />
                        <span className="forecast-time">Утро</span>
                        <span className={`forecast-temp ${getTempColor(weather.morning_temp)}`}>
                          {weather.morning_temp > 0 ? '+' : ''}{weather.morning_temp}°
                        </span>
                      </div>
                    )}
                    {weather.day_temp !== undefined && (
                      <div className="forecast-item">
                        <Sun size={16} />
                        <span className="forecast-time">День</span>
                        <span className={`forecast-temp ${getTempColor(weather.day_temp)}`}>
                          {weather.day_temp > 0 ? '+' : ''}{weather.day_temp}°
                        </span>
                      </div>
                    )}
                    {weather.evening_temp !== undefined && (
                      <div className="forecast-item">
                        <Sunset size={16} />
                        <span className="forecast-time">Вечер</span>
                        <span className={`forecast-temp ${getTempColor(weather.evening_temp)}`}>
                          {weather.evening_temp > 0 ? '+' : ''}{weather.evening_temp}°
                        </span>
                      </div>
                    )}
                    {weather.night_temp !== undefined && (
                      <div className="forecast-item">
                        <Moon size={16} />
                        <span className="forecast-time">Ночь</span>
                        <span className={`forecast-temp ${getTempColor(weather.night_temp)}`}>
                          {weather.night_temp > 0 ? '+' : ''}{weather.night_temp}°
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Время обновления */}
              <div className="weather-footer">
                <Clock size={14} />
                <span>Обновлено: {new Date(weather.timestamp).toLocaleTimeString('ru-RU')}</span>
              </div>
            </>
          ) : (
            <div className="weather-error">
              <AlertCircle size={20} />
              <span>Не удалось загрузить погоду</span>
            </div>
          )}
        </motion.div>

        <button className="btn primary" onClick={fetchData} disabled={loading}>{loading ? 'Загрузка...' : 'Обновить данные'}</button>
        <button className="btn secondary" onClick={() => setShowSettings(true)}>Настройки</button>

        {lastUpdate && (
          <p className={`ts ${isStale ? 'ts-stale' : 'ts-ok'}`}>Последнее обновление: {formatTime(lastUpdate)}{data && ` • ${new Date(data.timestamp||'').toLocaleTimeString('ru-RU', { timeZone: 'Europe/Samara' })} с ESP`}</p>
        )}
      </div>
    </div>
  )
}