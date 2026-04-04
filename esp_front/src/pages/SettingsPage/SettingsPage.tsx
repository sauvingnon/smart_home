import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useNavigate } from 'react-router-dom'
import {
  Clock, Fan, Sun, Moon, Bath, Monitor, Thermometer, Cloud,
  Settings2, AlertCircle, ChevronLeft, Save, Calendar,
  Sunrise, Sunset, Wind, Droplets, Power, VolumeX, Gauge
} from 'lucide-react'
import { apiClient } from '../../api/client'
import './SettingsPage.css'

type SettingsPageProps = {
  theme?: 'light' | 'dark'
}

type Settings = {
  displayMode: number
  dayOnHour: number
  dayOnMinute: number
  dayOffHour: number
  dayOffMinute: number
  nightOnHour: number
  nightOnMinute: number
  nightOffHour: number
  nightOffMinute: number
  toiletOnHour: number
  toiletOnMinute: number
  toiletOffHour: number
  toiletOffMinute: number
  relayMode: boolean
  manualDayState: boolean
  manualNightState: boolean
  displayTimeout: number
  displayChangeModeTimeout: number
  fanDelay: number
  fanDuration: number
  offlineModeActive: boolean
  showForecastScreen: boolean
  showTempScreen: boolean
  silentMode: boolean
  forcedVentilationTimeout: number
}

const defaultSettings: Settings = {
  displayMode: 1,
  dayOnHour: 8, dayOnMinute: 0, dayOffHour: 22, dayOffMinute: 0,
  nightOnHour: 22, nightOnMinute: 0, nightOffHour: 8, nightOffMinute: 0,
  toiletOnHour: 8, toiletOnMinute: 0, toiletOffHour: 20, toiletOffMinute: 0,
  relayMode: false, manualDayState: false, manualNightState: false,
  displayTimeout: 30, displayChangeModeTimeout: 20,
  fanDelay: 60, fanDuration: 5,
  offlineModeActive: false, showForecastScreen: true, showTempScreen: true,
  silentMode: false, forcedVentilationTimeout: 0,
}

const TimeInput = ({ hour, minute, onHourChange, onMinuteChange }: any) => {
  // Форматирование с ведущим нулём для отображения в поле
  const displayHour = hour.toString().padStart(2, '0')
  const displayMinute = minute.toString().padStart(2, '0')
  
  // Добавление минут с учётом перехода через час
  const addMinutes = (mins: number) => {
    let totalMinutes = hour * 60 + minute + mins
    if (totalMinutes < 0) totalMinutes = 23 * 60 + 30
    if (totalMinutes > 23 * 60 + 59) totalMinutes = 0
    
    const newHour = Math.floor(totalMinutes / 60)
    const newMinute = totalMinutes % 60
    onHourChange(newHour)
    onMinuteChange(newMinute)
  }

  // Обработчик изменения часа с форматированием
  const handleHourChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let val = parseInt(e.target.value) || 0
    if (val < 0) val = 0
    if (val > 23) val = 23
    onHourChange(val)
  }

  // Обработчик изменения минуты с форматированием
  const handleMinuteChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let val = parseInt(e.target.value) || 0
    if (val < 0) val = 0
    if (val > 59) val = 59
    onMinuteChange(val)
  }

  return (
    <div className="time-input-wrapper">
      {/* Кнопка - */}
      <motion.button
        className="time-adjust-btn"
        onClick={() => addMinutes(-30)}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
      >
        <span className="symbol">−</span>
      </motion.button>

      {/* Поля ввода */}
      <div className="time-input-group">
        <input 
          type="text" 
          className="time-input"
          value={displayHour}
          onChange={handleHourChange}
          onBlur={(e) => {
            const val = parseInt(e.target.value) || 0
            onHourChange(Math.min(23, Math.max(0, val)))
          }}
        />
        <span className="time-separator">:</span>
        <input 
          type="text" 
          className="time-input"
          value={displayMinute}
          onChange={handleMinuteChange}
          onBlur={(e) => {
            const val = parseInt(e.target.value) || 0
            onMinuteChange(Math.min(59, Math.max(0, val)))
          }}
        />
      </div>

      {/* Кнопка + */}
      <motion.button
        className="time-adjust-btn"
        onClick={() => addMinutes(30)}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
      >
        <span className="symbol">+</span>
      </motion.button>
    </div>
  )
}

const Counter = ({ value, onChange, min, max, step = 1, unit = '' }: any) => {
  const displayUnit = unit || (step === 1 ? 'мин' : 'с')
  
  return (
    <div className="counter-group">
      <motion.button 
        className="counter-btn"
        onClick={() => onChange(Math.max(min, value - step))}
        disabled={value <= min}
        whileHover={{ scale: 1.05, backgroundColor: 'rgba(14, 165, 233, 0.1)' }}
        whileTap={{ scale: 0.95 }}
        transition={{ type: "spring", stiffness: 400, damping: 17 }}
      >
        <span className="counter-symbol">−</span>
      </motion.button>
      
      <motion.div 
        className="counter-value-wrapper"
        animate={{
          scale: [1, 1.02, 1],
          transition: { duration: 0.2 }
        }}
        key={value}
      >
        <span className="counter-number">{value}</span>
        <span className="counter-unit">{displayUnit}</span>
      </motion.div>
      
      <motion.button 
        className="counter-btn"
        onClick={() => onChange(Math.min(max, value + step))}
        disabled={value >= max}
        whileHover={{ scale: 1.05, backgroundColor: 'rgba(14, 165, 233, 0.1)' }}
        whileTap={{ scale: 0.95 }}
        transition={{ type: "spring", stiffness: 400, damping: 17 }}
      >
        <span className="counter-symbol">+</span>
      </motion.button>
    </div>
  )
}

const ToggleSwitch = ({ checked, onChange, color = 'blue' }: any) => {
  const getColorStyles = () => {
    switch(color) {
      case 'amber':
        return { bg: 'var(--accent-amber)', border: '#fbbf24' }
      case 'indigo':
        return { bg: 'var(--accent-indigo)', border: '#818cf8' }
      default:
        return { bg: 'var(--accent-blue)', border: '#3b82f6' }
    }
  }

  const colors = getColorStyles()

  return (
    <motion.button
      className={`toggle-switch ${checked ? 'active' : ''}`}
      onClick={() => onChange(!checked)}
      whileTap={{ scale: 0.95 }}
      animate={{
        backgroundColor: checked ? colors.bg : 'transparent',
        borderColor: checked ? colors.border : 'var(--glass-border)'
      }}
      transition={{ type: "spring", stiffness: 300, damping: 20 }}
    >
      <motion.div
        className="toggle-thumb"
        animate={{
          x: checked ? 22 : 0,
          backgroundColor: checked ? 'white' : 'var(--text-tertiary)'
        }}
        transition={{ type: "spring", stiffness: 500, damping: 30 }}
      />
      {checked && (
        <motion.span 
          className="toggle-check"
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ delay: 0.1 }}
        >
          ✓
        </motion.span>
      )}
    </motion.button>
  )
}

const containerVar = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.05 } }
}

const itemVar = {
  hidden: { y: 20, opacity: 0 },
  visible: { y: 0, opacity: 1 }
}

export default function SettingsPage({ theme = 'light' }: SettingsPageProps) {
  const navigate = useNavigate()
  const [settings, setSettings] = useState<Settings>(defaultSettings)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [activeTab, setActiveTab] = useState('schedule')
  const [showSuccess, setShowSuccess] = useState(false)

  const handleClose = () => {
    navigate('/')
  }

  useEffect(() => {
    let mounted = true
    const fetchSettings = async () => {
      try {
        const data = await apiClient.fetch('/esp_service/settings')
        if (mounted) setSettings(data)
      } catch (e) {
        console.error('Settings fetch failed:', e)
      } finally {
        if (mounted) setLoading(false)
      }
    }
    fetchSettings()
    return () => { mounted = false }
  }, [])

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings(prev => ({ ...prev, [key]: value }))
  }

  const saveSettings = async () => {
    setSaving(true)
    try {
      await apiClient.fetch('/esp_service/settings', {
        method: 'POST',
        body: JSON.stringify(settings)
      })
      setShowSuccess(true)
      setTimeout(() => setShowSuccess(false), 3000)
    } catch (e) {
      console.error('Save failed:', e)
      alert('Ошибка при сохранении')
    } finally {
      setSaving(false)
    }
  }

  const tabs = [
    { id: 'schedule', label: 'Расписание', icon: Calendar },
    { id: 'relay', label: 'Реле', icon: Power },
    { id: 'display', label: 'Экран', icon: Monitor },
    { id: 'fan', label: 'Вентилятор', icon: Fan },
  ]

  if (loading) {
    return (
      <div className="settings-page">
        <div className="background-spot">
          <div className="spot-1"></div>
          <div className="spot-2"></div>
          <div className="spot-3"></div>
        </div>
        <div className="loading-container">
          <div className="loading-card glass-card">
            <div className="spinner" />
            <p className="loading-text">Загрузка настроек...</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={`settings-page ${theme}`}>
      
      {/* Фоновые пятна */}
      <div className="background-spot">
        <div className="spot-1"></div>
        <div className="spot-2"></div>
        <div className="spot-3"></div>
      </div>

      <div className="settings-container">
        
        {/* Хедер */}
        <motion.div 
          className="settings-header glass-card"
          initial={{ y: -20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
        >
          <button onClick={handleClose} className="back-button">
            <ChevronLeft size={24} />
          </button>
          
          <h1 className="settings-title">
            Настройки
          </h1>
          
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={saveSettings}
            disabled={saving}
            className="save-button"
          >
            <Save size={18} />
            <span>{saving ? 'Сохранение...' : 'Сохранить'}</span>
          </motion.button>
        </motion.div>


        {/* Уведомление об успехе */}
        <AnimatePresence>
          {showSuccess && (
            <motion.div 
              className="success-message"
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
            >
              <AlertCircle size={18} />
              Настройки успешно сохранены
            </motion.div>
          )}
        </AnimatePresence>

        {/* Табы - Карточки-плитки */}
        <div className="tabs-header-tiles">
          {tabs.map(tab => {
            const Icon = tab.icon
            return (
              <motion.button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`tab-button-tile ${activeTab === tab.id ? 'active' : ''}`}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                transition={{ type: "spring", stiffness: 400, damping: 17 }}
              >
                <Icon size={24} />
                <span>{tab.label}</span>
              </motion.button>
            )
          })}
        </div>

          {/* Контент табов */}
          <motion.div 
            className="tabs-content"
            variants={containerVar}
            initial="hidden"
            animate="visible"
            key={activeTab}
          >

            {/* Расписание */}
            {activeTab === 'schedule' && (
              <div className="tab-pane">
                
                <div className="section">
                  <div className="section-header">
                    <Sun className="section-icon sun" />
                    <h2>Дневной свет</h2>
                  </div>
                  <div className="schedule-grid">
                    <div className="schedule-item">
                      <span className="schedule-label">Включение</span>
                      <TimeInput 
                        hour={settings.dayOnHour} 
                        minute={settings.dayOnMinute} 
                        onHourChange={h => update('dayOnHour', h)} 
                        onMinuteChange={m => update('dayOnMinute', m)} 
                      />
                    </div>
                    <div className="schedule-item">
                      <span className="schedule-label">Выключение</span>
                      <TimeInput 
                        hour={settings.dayOffHour} 
                        minute={settings.dayOffMinute} 
                        onHourChange={h => update('dayOffHour', h)} 
                        onMinuteChange={m => update('dayOffMinute', m)} 
                      />
                    </div>
                  </div>
                </div>

                <div className="section">
                  <div className="section-header">
                    <Moon className="section-icon moon" />
                    <h2>Ночной свет</h2>
                  </div>
                  <div className="schedule-grid">
                    <div className="schedule-item">
                      <span className="schedule-label">Включение</span>
                      <TimeInput 
                        hour={settings.nightOnHour} 
                        minute={settings.nightOnMinute} 
                        onHourChange={h => update('nightOnHour', h)} 
                        onMinuteChange={m => update('nightOnMinute', m)} 
                      />
                    </div>
                    <div className="schedule-item">
                      <span className="schedule-label">Выключение</span>
                      <TimeInput 
                        hour={settings.nightOffHour} 
                        minute={settings.nightOffMinute} 
                        onHourChange={h => update('nightOffHour', h)} 
                        onMinuteChange={m => update('nightOffMinute', m)} 
                      />
                    </div>
                  </div>
                </div>

                <div className="section">
                  <div className="section-header">
                    <Bath className="section-icon bath" />
                    <h2>Уборная</h2>
                  </div>
                  <div className="schedule-grid">
                    <div className="schedule-item">
                      <span className="schedule-label">Включение</span>
                      <TimeInput 
                        hour={settings.toiletOnHour} 
                        minute={settings.toiletOnMinute} 
                        onHourChange={h => update('toiletOnHour', h)} 
                        onMinuteChange={m => update('toiletOnMinute', m)} 
                      />
                    </div>
                    <div className="schedule-item">
                      <span className="schedule-label">Выключение</span>
                      <TimeInput 
                        hour={settings.toiletOffHour} 
                        minute={settings.toiletOffMinute} 
                        onHourChange={h => update('toiletOffHour', h)} 
                        onMinuteChange={m => update('toiletOffMinute', m)} 
                      />
                    </div>
                  </div>
                </div>

              </div>
            )}

            {/* Реле */}
            {activeTab === 'relay' && (
              <div className="tab-pane">
                
                <div className="section">
                  <div className="section-header">
                    <Settings2 className="section-icon purple" />
                    <h2>Режим управления</h2>
                  </div>
                  
                  {/* iOS-style Segmented Control */}
                  <div className="segmented-control">
                    <motion.button
                      className={`segmented-option ${!settings.relayMode ? 'active' : ''}`}
                      onClick={() => update('relayMode', false)}
                      whileTap={{ scale: 0.97 }}
                    >
                      <motion.div
                        className="segmented-indicator"
                        animate={{
                          backgroundColor: !settings.relayMode ? 'var(--accent-sky)' : 'transparent',
                          boxShadow: !settings.relayMode ? '0 2px 8px rgba(14, 165, 233, 0.3)' : 'none'
                        }}
                        transition={{ type: "spring", stiffness: 300, damping: 20 }}
                      />
                      <span className="segmented-icon">⚡</span>
                      <span className="segmented-label">Авто</span>
                    </motion.button>

                    <motion.button
                      className={`segmented-option ${settings.relayMode ? 'active' : ''}`}
                      onClick={() => update('relayMode', true)}
                      whileTap={{ scale: 0.97 }}
                    >
                      <motion.div
                        className="segmented-indicator"
                        animate={{
                          backgroundColor: settings.relayMode ? 'var(--accent-orange)' : 'transparent',
                          boxShadow: settings.relayMode ? '0 2px 8px rgba(249, 115, 22, 0.3)' : 'none'
                        }}
                        transition={{ type: "spring", stiffness: 300, damping: 20 }}
                      />
                      <span className="segmented-icon">🖐️</span>
                      <span className="segmented-label">Ручной</span>
                    </motion.button>
                  </div>

                  <motion.p 
                    className="mode-description"
                    animate={{ opacity: 1, x: 0 }}
                    initial={{ opacity: 0, x: -10 }}
                    key={settings.relayMode ? 'manual' : 'auto'}
                  >
                    {!settings.relayMode 
                      ? 'Реле работают по расписанию, указанному во вкладке "Расписание"' 
                      : 'Расписание игнорируется. Управляйте реле вручную ниже'}
                  </motion.p>
                </div>

                {settings.relayMode && (
                  <motion.div 
                    className="section"
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.1 }}
                  >
                    <h3 className="manual-section-title">Ручное управление</h3>
                    <div className="manual-controls">
                      <motion.div 
                        className="manual-item"
                        whileHover={{ scale: 1.02, x: 5 }}
                        transition={{ type: "spring", stiffness: 400, damping: 17 }}
                      >
                        <div className="manual-info">
                          <div className="manual-icon sun">
                            <Sun size={24} />
                          </div>
                          <div>
                            <p className="manual-title">Дневной свет</p>
                            <p className="manual-subtitle">Реле #2</p>
                          </div>
                        </div>
                        <ToggleSwitch 
                          checked={settings.manualDayState}
                          onChange={checked => update('manualDayState', checked)}
                          color="amber"
                        />
                      </motion.div>

                      <motion.div 
                        className="manual-item"
                        whileHover={{ scale: 1.02, x: 5 }}
                        transition={{ type: "spring", stiffness: 400, damping: 17 }}
                      >
                        <div className="manual-info">
                          <div className="manual-icon moon">
                            <Moon size={24} />
                          </div>
                          <div>
                            <p className="manual-title">Ночной свет</p>
                            <p className="manual-subtitle">Реле #3</p>
                          </div>
                        </div>
                        <ToggleSwitch 
                          checked={settings.manualNightState}
                          onChange={checked => update('manualNightState', checked)}
                          color="indigo"
                        />
                      </motion.div>
                    </div>
                  </motion.div>
                )}

                <motion.div 
                  className="info-box"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.2 }}
                >
                  <AlertCircle size={20} />
                  <p>В автоматическом режиме реле управляются по расписанию. В ручном режиме вы можете включить/выключить их независимо.</p>
                </motion.div>

              </div>
            )}

            {/* Экран */}
            {activeTab === 'display' && (
              <div className="tab-pane">
                
               <div className="section">
                  <div className="section-header">
                    <Monitor className="section-icon blue" />
                    <h2>Режим экрана</h2>
                  </div>
                  
                  {/* Кнопки режимов */}
                  <div className="mode-buttons">
                    <motion.button
                      className={`mode-btn ${settings.displayMode === 0 ? 'active' : ''}`}
                      onClick={() => update('displayMode', 0)}
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                    >
                      Постоянный
                    </motion.button>

                    <motion.button
                      className={`mode-btn ${settings.displayMode === 1 ? 'active' : ''}`}
                      onClick={() => update('displayMode', 1)}
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                    >
                      Авто
                    </motion.button>

                    <motion.button
                      className={`mode-btn ${settings.displayMode === 2 ? 'active' : ''}`}
                      onClick={() => update('displayMode', 2)}
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                    >
                      Умный
                    </motion.button>
                  </div>

                  {/* Описание режима отдельно */}
                  <motion.p 
                    className="mode-description"
                    key={settings.displayMode}
                    initial={{ opacity: 0, y: -5 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.2 }}
                  >
                    {settings.displayMode === 0 && '🔆 Экран всегда включен'}
                    {settings.displayMode === 1 && '⏱️ Экран гаснет через таймаут'}
                    {settings.displayMode === 2 && '🤖 Умное управление яркостью'}
                  </motion.p>
                </div>

                <div className="section">
                  <div className="setting-row">
                    <span className="setting-label">Таймаут экрана</span>
                    <Counter 
                      value={settings.displayTimeout}
                      onChange={val => update('displayTimeout', val)}
                      min={0}
                      max={255}
                      step={5}
                    />
                  </div>

                  <div className="setting-row">
                    <span className="setting-label">Смена режимов</span>
                    <Counter 
                      value={settings.displayChangeModeTimeout}
                      onChange={val => update('displayChangeModeTimeout', val)}
                      min={0}
                      max={255}
                      step={5}
                    />
                  </div>
                </div>

                <div className="section">
                  <div className="toggle-row large">
                    <div className="toggle-info">
                      <Thermometer size={22} />
                      <span className="toggle-label">Показывать датчики</span>
                      <ToggleSwitch 
                        checked={settings.showTempScreen}
                        onChange={checked => update('showTempScreen', checked)}
                      />
                    </div>
                  </div>

                  <div className="toggle-row large">
                    <div className="toggle-info">
                      <Cloud size={22} />
                      <span className="toggle-label">Показывать прогноз</span>
                      <ToggleSwitch 
                        checked={settings.showForecastScreen}
                        onChange={checked => update('showForecastScreen', checked)}
                      />
                    </div>
                  </div>
                </div>

              </div>
            )}

            {/* Вентилятор */}
            {activeTab === 'fan' && (
              <div className="tab-pane">
                
                <div className="section">
                  <div className="section-header">
                    <VolumeX className="section-icon purple" />
                    <h2>Режим тишины</h2>
                  </div>
                  
                  <div className="silent-mode">
                    <button 
                      className={`silent-button ${settings.silentMode ? 'active' : ''}`}
                      onClick={() => update('silentMode', !settings.silentMode)}
                    >
                      <VolumeX size={20} />
                      {settings.silentMode ? 'Выключить' : 'Активировать'}
                    </button>
                  </div>
                </div>

                <div className="section">
                  <div className="setting-row">
                    <span className="setting-label">Принудительное вентилирование</span>
                    <Counter 
                      value={settings.forcedVentilationTimeout}
                      onChange={val => update('forcedVentilationTimeout', val)}
                      min={0}
                      max={30}
                      step={1}
                    />
                  </div>

                  <div className="setting-row">
                    <span className="setting-label">Задержка перед включением</span>
                    <Counter 
                      value={settings.fanDelay}
                      onChange={val => update('fanDelay', val)}
                      min={0}
                      max={255}
                      step={10}
                    />
                  </div>

                  <div className="setting-row">
                    <span className="setting-label">Длительность работы</span>
                    <Counter 
                      value={settings.fanDuration}
                      onChange={val => update('fanDuration', val)}
                      min={1}
                      max={255}
                      step={1}
                    />
                  </div>
                </div>

              </div>
            )}

          </motion.div>
        </div>

      </div>
    // </div>
  )
}