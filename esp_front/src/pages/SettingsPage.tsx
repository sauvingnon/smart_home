import { useEffect, useState } from 'react'
import { Clock, Fan, Sun, Moon, Bath, Monitor, Thermometer, Cloud, Settings2 } from 'lucide-react'
import { API_ENDPOINTS } from '../config'
import './SettingsPage.css'
import './rele.css'
import './screen.css'

type SettingsPageProps = {
  onClose?: () => void
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


export default function SettingsPage({ onClose }: SettingsPageProps) {
  const [settings, setSettings] = useState<Settings>(defaultSettings)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [activeTab, setActiveTab] = useState('schedule')

  useEffect(() => {
    let mounted = true
    const fetchSettings = async () => {
      try {
        const res = await fetch(API_ENDPOINTS.settings)
        if (res.ok) {
          const json = await res.json()
          if (mounted) setSettings(json)
        }
      } catch (e) {
        // fallback to defaults
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
      await fetch(API_ENDPOINTS.settings, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      })
      alert('Настройки сохранены')
    } catch (e) {
      alert('Ошибка при сохранении')
    } finally {
      setSaving(false)
    }
  }

  const TimeInput = ({ hour, minute, onHourChange, onMinuteChange }: any) => (
    <div className="time-input">
      <input type="number" className="time-field" min={0} max={23} value={hour} onChange={e => onHourChange(Number(e.target.value))} />
      <span>:</span>
      <input type="number" className="time-field" min={0} max={59} value={minute} onChange={e => onMinuteChange(Number(e.target.value))} />
    </div>
  )

  if (loading) {
    return (
      <div className="settings-card loading-state">
        <div className="spinner" />
        <p className="muted">Загрузка настроек...</p>
      </div>
    )
  }

  return (
    <div className="settings-card">
      <div className="settings-header">
        <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Clock style={{ width: 20, height: 20 }} />
          Настройки системы
        </h2>
        <div className="header-actions">
          <button className="btn-close" onClick={() => onClose?.()}>Закрыть</button>
          <button className="btn primary" onClick={saveSettings} disabled={saving}>{saving ? 'Сохранение...' : 'Сохранить'}</button>
        </div>
      </div>

      <div className="tabs-container">
        <div className="tabs-list">
          {[
            { id: 'schedule', label: '📅 Расписание' },
            { id: 'relay', label: '⚡ Реле' },
            { id: 'display', label: '🖥️ Экран' },
            { id: 'fan', label: '🌀 Вентилятор' }
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`tab-trigger ${activeTab === tab.id ? 'active' : ''}`}
            >
              <span className="tab-icon">{tab.icon}</span>
              <span className="tab-label">{tab.label}</span>
              {activeTab === tab.id && <span className="tab-active-indicator" />}
            </button>
          ))}
        </div>


        <div className="tabs-content">
          {activeTab === 'schedule' && (
            <div className="tab-space">

              <div className="fan-section">
                <Fan style={{ width: 20, height: 20 }} />
                <h3 className="font-medium">Настройки расписания</h3>
              </div>

              <div className="schedule-section">
                <h3 className="section-title sun-color">
                  <Sun style={{ width: 16, height: 16 }} />
                  Дневной свет
                </h3>
                <div className="schedule-grid">
                  <div className="time-input-wrapper">
                    <label>Включение</label>
                    <div className="time-controls">
                      <TimeInput 
                        hour={settings.dayOnHour} 
                        minute={settings.dayOnMinute} 
                        onHourChange={h => update('dayOnHour', h)} 
                        onMinuteChange={m => update('dayOnMinute', m)} 
                      />
                    </div>
                  </div>
                  <div className="time-input-wrapper">
                    <label>Выключение</label>
                    <div className="time-controls">
                      <TimeInput 
                        hour={settings.dayOffHour} 
                        minute={settings.dayOffMinute} 
                        onHourChange={h => update('dayOffHour', h)} 
                        onMinuteChange={m => update('dayOffMinute', m)} 
                      />
                    </div>
                  </div>
                </div>
              </div>

              <div className="schedule-section">
                <h3 className="section-title moon-color">
                  <Moon style={{ width: 16, height: 16 }} />
                  Ночной свет
                </h3>
                <div className="schedule-grid">
                  <div className="time-input-wrapper">
                    <label>Включение</label>
                    <div className="time-controls">
                      <TimeInput 
                        hour={settings.nightOnHour} 
                        minute={settings.nightOnMinute} 
                        onHourChange={h => update('nightOnHour', h)} 
                        onMinuteChange={m => update('nightOnMinute', m)} 
                      />
                    </div>
                  </div>
                  <div className="time-input-wrapper">
                    <label>Выключение</label>
                    <div className="time-controls">
                      <TimeInput 
                        hour={settings.nightOffHour} 
                        minute={settings.nightOffMinute} 
                        onHourChange={h => update('nightOffHour', h)} 
                        onMinuteChange={m => update('nightOffMinute', m)} 
                      />
                    </div>
                  </div>
                </div>
              </div>

              <div className="schedule-section">
                <h3 className="section-title bath-color">
                  <Bath style={{ width: 16, height: 16 }} />
                  Уборная
                </h3>
                <div className="schedule-grid">
                  <div className="time-input-wrapper">
                    <label>Включение</label>
                    <div className="time-controls">
                      <TimeInput 
                        hour={settings.toiletOnHour} 
                        minute={settings.toiletOnMinute} 
                        onHourChange={h => update('toiletOnHour', h)} 
                        onMinuteChange={m => update('toiletOnMinute', m)} 
                      />
                    </div>
                  </div>
                  <div className="time-input-wrapper">
                    <label>Выключение</label>
                    <div className="time-controls">
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
            </div>
          )}

          {activeTab === 'relay' && (
            <div className="tab-space">

              <div className="fan-section">
                <Fan style={{ width: 20, height: 20 }} />
                <h3 className="font-medium">Настройки реле</h3>
              </div>

              <div className="relay-segment">
                <div className="relay-icon"><Settings2 style={{ width: 16, height: 16 }} /></div>
                <span className="font-medium">Режим управления</span>
              </div>
              <div className="segment-control">
                <button onClick={() => update('relayMode', false)} className={`segment ${!settings.relayMode ? 'active' : ''}`}>Автоматический</button>
                <button onClick={() => update('relayMode', true)} className={`segment ${settings.relayMode ? 'active' : ''}`}>Ручной</button>
              </div>
              <p className="text-xs muted">{!settings.relayMode ? 'Реле работают по расписанию' : 'Управляйте реле вручную ниже'}</p>

              {settings.relayMode && (
                <div className="relay-controls">
                  <div className="relay-switch">
                    <div className="relay-info">
                      <div className="relay-icon day"><Sun style={{ width: 20, height: 20 }} /></div>
                      <div>
                        <p className="font-medium">Дневной свет</p>
                        <p className="text-xs muted">Реле #2</p>
                      </div>
                    </div>
                    <label className="switch">
                      <input type="checkbox" checked={settings.manualDayState} onChange={e => update('manualDayState', e.target.checked)} />
                      <span className="slider" />
                    </label>
                  </div>

                  <div className="relay-switch">
                    <div className="relay-info">
                      <div className="relay-icon night"><Moon style={{ width: 20, height: 20 }} /></div>
                      <div>
                        <p className="font-medium">Ночной свет</p>
                        <p className="text-xs muted">Реле #3</p>
                      </div>
                    </div>
                    <label className="switch">
                      <input type="checkbox" checked={settings.manualNightState} onChange={e => update('manualNightState', e.target.checked)} />
                      <span className="slider" />
                    </label>
                  </div>
                </div>
              )}

              <div className="info-box">
                <p>ℹ️ В автоматическом режиме реле управляются по расписанию. В ручном — вручную.</p>
              </div>
            </div>
          )}

          {activeTab === 'display' && (
            <div className="tab-space">

              <div className="fan-section">
                <Fan style={{ width: 20, height: 20 }} />
                <h3 className="font-medium">Настройки экрана</h3>
              </div>

              <div className="display-section">
                <div className="display-icon"><Monitor style={{ width: 16, height: 16 }} /></div>
                <span className="font-medium">Режим экрана</span>
              </div>
              <div className="segment-control three">
                <button onClick={() => update('displayMode', 0)} className={`segment ${settings.displayMode === 0 ? 'active' : ''}`}>Постоянный</button>
                <button onClick={() => update('displayMode', 1)} className={`segment ${settings.displayMode === 1 ? 'active' : ''}`}>Авто</button>
                <button onClick={() => update('displayMode', 2)} className={`segment ${settings.displayMode === 2 ? 'active' : ''}`}>Умный</button>
              </div>
              <p className="text-xs muted">
                {settings.displayMode === 0 && 'Экран всегда включен'}
                {settings.displayMode === 1 && 'Экран гаснет через таймаут'}
                {settings.displayMode === 2 && 'Умное управление яркостью'}
              </p>

              <div className="control-with-buttons">
                <span className="text-sm">Таймаут экрана</span>
                <div className="number-control">
                  <button className="btn-mini" onClick={() => update('displayTimeout', Math.max(0, settings.displayTimeout - 5))}>−</button>
                  <span className="value">{settings.displayTimeout}с</span>
                  <button className="btn-mini" onClick={() => update('displayTimeout', Math.min(255, settings.displayTimeout + 5))}>+</button>
                </div>
              </div>

              <div className="control-with-buttons">
                <span className="text-sm">Смена режимов</span>
                <div className="number-control">
                  <button className="btn-mini" onClick={() => update('displayChangeModeTimeout', Math.max(0, settings.displayChangeModeTimeout - 5))}>−</button>
                  <span className="value">{settings.displayChangeModeTimeout}с</span>
                  <button className="btn-mini" onClick={() => update('displayChangeModeTimeout', Math.min(255, settings.displayChangeModeTimeout + 5))}>+</button>
                </div>
              </div>

              <div className="display-toggles">
                <div className="toggle-row">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <Thermometer style={{ width: 16, height: 16 }} />
                    <span className="text-sm">Показывать датчики</span>
                  </div>
                  <label className="switch">
                    <input type="checkbox" checked={settings.showTempScreen} onChange={e => update('showTempScreen', e.target.checked)} />
                    <span className="slider" />
                  </label>
                </div>

                <div className="toggle-row">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <Cloud style={{ width: 16, height: 16 }} />
                    <span className="text-sm">Показывать прогноз</span>
                  </div>
                  <label className="switch">
                    <input type="checkbox" checked={settings.showForecastScreen} onChange={e => update('showForecastScreen', e.target.checked)} />
                    <span className="slider" />
                  </label>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'fan' && (
            <div className="tab-space">
              <div className="fan-section">
                <Fan style={{ width: 20, height: 20 }} />
                <h3 className="font-medium">Настройки вентиляции</h3>
              </div>

              {/* Кнопка режима тишины */}
              <div className="control-with-buttons silent-mode-control">
                <span className="text-sm">Режим тишины</span>
                <button 
                  className={`silent-mode-btn ${settings.silentMode ? 'active' : ''}`}
                  onClick={() => update('silentMode', true)}
                >
                  <span className="silent-icon">🔇</span>
                  Активировать режим тишины
                </button>
              </div>

              {/* Принудительное вентилирование */}
              <div className="control-with-buttons">
                <span className="text-sm">Принудительное вентилирование</span>
                <div className="number-control forced-control">
                  <button 
                    className="btn-mini" 
                    onClick={() => update('forcedVentilationTimeout', Math.max(0, settings.forcedVentilationTimeout - 5))}
                    disabled={settings.forcedVentilationTimeout <= 0}
                  >−</button>
                  <span className="value">{settings.forcedVentilationTimeout} сек</span>
                  <button 
                    className="btn-mini" 
                    onClick={() => update('forcedVentilationTimeout', Math.min(3600, settings.forcedVentilationTimeout + 5))}
                  >+</button>
                </div>
              </div>

              {/* Существующие поля */}
              <div className="control-with-buttons">
                <span className="text-sm">Задержка перед включением</span>
                <div className="number-control">
                  <button className="btn-mini" onClick={() => update('fanDelay', Math.max(0, settings.fanDelay - 5))}>−</button>
                  <span className="value">{settings.fanDelay} сек</span>
                  <button className="btn-mini" onClick={() => update('fanDelay', Math.min(255, settings.fanDelay + 5))}>+</button>
                </div>
              </div>

              <div className="control-with-buttons">
                <span className="text-sm">Длительность работы</span>
                <div className="number-control">
                  <button className="btn-mini" onClick={() => update('fanDuration', Math.max(1, settings.fanDuration - 1))}>−</button>
                  <span className="value">{settings.fanDuration} мин</span>
                  <button className="btn-mini" onClick={() => update('fanDuration', Math.min(255, settings.fanDuration + 1))}>+</button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
