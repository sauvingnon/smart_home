import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Thermometer, Droplets, Bluetooth, Fan, Lightbulb, Gauge, Clock, AlertCircle } from 'lucide-react'
import SettingsPage from './SettingsPage'
import { API_ENDPOINTS } from '../config'

type Telemetry = {
  device_id: string
  temperature: number
  humidity: number
  free_memory?: number
  uptime?: number
  timestamp?: string
  bluetooth_is_active?: boolean
}

export default function HomePage() {
  const [data, setData] = useState<Telemetry | null>(null)
  const [loading, setLoading] = useState(true)
  const [relayState, setRelayState] = useState({ fan: false, light: false })
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
      // fallback mock
      setIsStale(true)
      setData({ device_id: 'demo-01', temperature: 21.7, humidity: 47.2, free_memory: 54000, uptime: 4523, timestamp: new Date().toISOString(), bluetooth_is_active: true })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
    const iv = setInterval(fetchData, 30000)
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
                  <div className="stat"><Bluetooth className="icon-xs"/> <span>{data?.bluetooth_is_active ? 'Bluetooth активен' : 'Bluetooth неактивен'}</span></div>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="card control-card">
          <div className="card-header">Потенциальное место для погоды</div>
          <div className="card-body">
            <div className="control-row">
              <div className="control-left">
                <div className="control-icon fan-icon"><Fan/></div>
                <div>
                  <div className="font-medium">Вентиляция</div>
                  <div className="text-xs muted">Реле #1</div>
                </div>
              </div>
              <label className="switch">
                <input type="checkbox" checked={relayState.fan} onChange={e => setRelayState(prev=>({...prev, fan: e.target.checked}))} />
                <span className="slider" />
              </label>
            </div>

            <div className="control-row">
              <div className="control-left">
                <div className="control-icon light-icon"><Lightbulb/></div>
                <div>
                  <div className="font-medium">Основной свет</div>
                  <div className="text-xs muted">Реле #2</div>
                </div>
              </div>
              <label className="switch">
                <input type="checkbox" checked={relayState.light} onChange={e => setRelayState(prev=>({...prev, light: e.target.checked}))} />
                <span className="slider" />
              </label>
            </div>
          </div>
        </div>

        <button className="btn primary" onClick={fetchData} disabled={loading}>{loading ? 'Загрузка...' : 'Обновить данные'}</button>
        <button className="btn secondary" onClick={() => setShowSettings(true)}>Настройки</button>

        {lastUpdate && (
          <p className={`ts ${isStale ? 'ts-stale' : 'ts-ok'}`}>Последнее обновление: {formatTime(lastUpdate)}{data && ` • ${new Date(data.timestamp||'').toLocaleTimeString('ru-RU', { timeZone: 'Europe/Samara' })} с ESP`}</p>
        )}
      </div>
    </div>
  )
}
