import { useState, useEffect } from 'react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts'
import { apiClient } from '../../api/client'

// Типы для диапазонов
type TimeRange = '6h' | '12h' | '24h' | '48h' | '7d'
type DataType = 'temperature' | 'humidity'

// Маппинг диапазонов в часы
const rangeToHours: Record<TimeRange, number> = {
  '6h': 6,
  '12h': 12,
  '24h': 24,
  '48h': 48,
  '7d': 168
}

// Количество точек для каждого диапазона
const rangePoints: Record<TimeRange, number> = {
  '6h': 50,
  '12h': 50,
  '24h': 50,
  '48h': 50,
  '7d': 50
}

interface HistoryRecord {
  timestamp: string
  temp_in: number | null
  temp_out: number | null
  hum_in: number | null
  hum_out: number | null
}

interface StatsData {
  period_hours: number
  total_records: number
  esp_records: number
  weather_records: number
  avg_temp_in: number | null
  min_temp_in: number | null
  max_temp_in: number | null
  avg_hum_in: number | null
  min_hum_in: number | null
  max_hum_in: number | null
  avg_temp_out: number | null
  min_temp_out: number | null
  max_temp_out: number | null
}

interface TemperatureChartProps {
  theme?: 'light' | 'dark'
  deviceId?: string
}

export default function TemperatureChart({ 
  theme = 'dark', 
  deviceId = 'greenhouse_01' 
}: TemperatureChartProps) {
  const [selectedRange, setSelectedRange] = useState<TimeRange>('24h')
  const [dataType, setDataType] = useState<DataType>('temperature')
  const [data, setData] = useState<any[]>([])
  const [stats, setStats] = useState<StatsData | null>(null)
  const [loading, setLoading] = useState(false)
  const [statsLoading, setStatsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const [containerRef, setContainerRef] = useState<HTMLDivElement | null>(null)

  // Загрузка истории
  useEffect(() => {
    const fetchHistory = async () => {
      setLoading(true)
      setError(null)
      
      try {
        const hours = rangeToHours[selectedRange]
        const points = rangePoints[selectedRange]
        const response = await apiClient.fetch(`/esp_service/history?hours=${hours}&max_points=${points}`)
        
        const chartData = response.records.map((record: HistoryRecord) => {
          const date = new Date(record.timestamp)
          
          let timeFormat: string
          if (selectedRange === '7d') {
            timeFormat = date.toLocaleDateString([], { 
              day: '2-digit', 
              month: '2-digit' 
            })
          } else {
            timeFormat = date.toLocaleTimeString([], { 
              hour: '2-digit', 
              minute: '2-digit',
              hour12: false 
            })
          }
          
          return {
            time: timeFormat,
            inside: dataType === 'temperature' ? record.temp_in : record.hum_in,
            outside: dataType === 'temperature' ? record.temp_out : record.hum_out,
            rawTime: date.getTime()
          }
        })
        
        setData(chartData)
      } catch (err) {
        console.error('Failed to fetch history:', err)
        setError('Не удалось загрузить данные')
      } finally {
        setLoading(false)
      }
    }

    fetchHistory()
  }, [selectedRange, deviceId, dataType])

  // Загрузка статистики
  useEffect(() => {
    const fetchStats = async () => {
      setStatsLoading(true)
      try {
        const hours = rangeToHours[selectedRange]
        const response = await apiClient.fetch(`/esp_service/stats?hours=${hours}`)
        setStats(response)
      } catch (err) {
        console.error('Failed to fetch stats:', err)
      } finally {
        setStatsLoading(false)
      }
    }

    fetchStats()
  }, [selectedRange, deviceId])

  // Измеряем ширину контейнера
  useEffect(() => {
    const updateWidth = () => {
      if (containerRef) {
        setContainerWidth(containerRef.clientWidth)
      }
    }
    
    updateWidth()
    window.addEventListener('resize', updateWidth)
    return () => window.removeEventListener('resize', updateWidth)
  }, [containerRef])

  const isMobile = containerWidth < 768
  const isDark = theme === 'dark'

  // Цвета в зависимости от темы
  const colors = {
    bg: isDark ? '#1a1a1a' : '#ffffff',
    text: isDark ? '#ffffff' : '#1f2937',
    textSecondary: isDark ? '#9ca3af' : '#6b7280',
    grid: isDark ? '#374151' : '#e5e7eb',
    axis: isDark ? '#9ca3af' : '#6b7280',
    inside: dataType === 'temperature' ? '#f97316' : '#3b82f6',
    outside: dataType === 'temperature' ? '#3b82f6' : '#10b981',
    cardBg: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.02)',
    border: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'
  }

  const ranges: { value: TimeRange; label: string }[] = [
    { value: '6h', label: '6ч' },
    { value: '12h', label: '12ч' },
    { value: '24h', label: '24ч' },
    { value: '48h', label: '48ч' },
    { value: '7d', label: '7д' }
  ]

  const chartHeight = isMobile ? 450 : 450
  const chartWidth = isMobile ? 450 : Math.min(containerWidth - 40, 600)

  const formatValue = (value: number | null, type: 'temp' | 'hum') => {
    if (value === null || value === undefined) return '—'
    return type === 'temp' ? `${value.toFixed(1)}°C` : `${Math.round(value)}%`
  }

  return (
    <div 
      ref={setContainerRef}
      style={{
        width: '100%',
        backgroundColor: colors.bg,
        borderRadius: 24,
        padding: isMobile ? 12 : 20,
        boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -1px rgba(0,0,0,0.06)',
        border: `1px solid ${colors.border}`
      }}
    >
      
      {/* Заголовок и выбор диапазона - теперь по центру */}
      <div style={{
        display: 'flex',
        flexDirection: isMobile ? 'column' : 'row',
        justifyContent: 'center',  // ← было 'space-between', стало 'center'
        alignItems: 'center',
        gap: isMobile ? 16 : 32,    // ← увеличил gap для разделения
        marginBottom: 20,
        flexWrap: 'wrap'
      }}>
        {/* Левая часть с иконкой и заголовком */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 24 }}>
            {dataType === 'temperature' ? '🌡️' : '💧'}
          </span>
          <span style={{ color: colors.text, fontWeight: 600, fontSize: isMobile ? 16 : 18 }}>
            {dataType === 'temperature' ? 'Температура' : 'Влажность'}: дом / улица
          </span>
          {(loading || statsLoading) && <span style={{ color: colors.textSecondary, fontSize: 12 }}>⏳</span>}
          {error && <span style={{ color: '#ef4444', fontSize: 12 }}>⚠️</span>}
        </div>

        {/* Правая часть с кнопками */}
        <div style={{
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          flexWrap: 'wrap',
          justifyContent: 'center'  // ← центрируем кнопки внутри
        }}>
          {/* Переключатель температура/влажность */}
          <div style={{
            display: 'flex',
            gap: 4,
            backgroundColor: colors.cardBg,
            padding: 4,
            borderRadius: 12
          }}>
            <button
              onClick={() => setDataType('temperature')}
              style={{
                padding: isMobile ? '6px 10px' : '8px 12px',
                borderRadius: 10,
                border: 'none',
                backgroundColor: dataType === 'temperature' ? colors.inside : 'transparent',
                color: dataType === 'temperature' ? '#ffffff' : colors.textSecondary,
                fontSize: isMobile ? 12 : 14,
                fontWeight: 500,
                cursor: 'pointer',
                transition: 'all 0.2s'
              }}
            >
              🌡️
            </button>
            <button
              onClick={() => setDataType('humidity')}
              style={{
                padding: isMobile ? '6px 10px' : '8px 12px',
                borderRadius: 10,
                border: 'none',
                backgroundColor: dataType === 'humidity' ? colors.inside : 'transparent',
                color: dataType === 'humidity' ? '#ffffff' : colors.textSecondary,
                fontSize: isMobile ? 12 : 14,
                fontWeight: 500,
                cursor: 'pointer',
                transition: 'all 0.2s'
              }}
            >
              💧
            </button>
          </div>

          {/* Кнопки выбора диапазона */}
          <div style={{
            display: 'flex',
            gap: 4,
            backgroundColor: colors.cardBg,
            padding: 4,
            borderRadius: 12,
            flexWrap: 'wrap',
            justifyContent: 'center'
          }}>
            {ranges.map(({ value, label }) => (
              <button
                key={value}
                onClick={() => setSelectedRange(value)}
                disabled={loading}
                style={{
                  padding: isMobile ? '6px 10px' : '8px 16px',
                  borderRadius: 10,
                  border: 'none',
                  backgroundColor: selectedRange === value ? colors.inside : 'transparent',
                  color: selectedRange === value ? '#ffffff' : colors.textSecondary,
                  fontSize: isMobile ? 12 : 14,
                  fontWeight: 500,
                  cursor: loading ? 'wait' : 'pointer',
                  transition: 'all 0.2s',
                  opacity: loading ? 0.5 : 1
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* График */}
      <div style={{ 
        width: '100%', 
        height: isMobile ? 480 : 500,
        overflowX: isMobile ? 'auto' : 'visible'
      }}>
        {data.length === 0 && !loading ? (
          <div style={{
            width: '100%', 
            height: isMobile ? 350 : 450,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: colors.textSecondary
          }}>
            Нет данных за выбранный период
          </div>
        ) : (
          <div style={{ 
            width: chartWidth,
            height: chartHeight
          }}>
            <LineChart
              width={chartWidth}
              height={chartHeight}
              data={data}
              margin={{ top: 0, right: 30, left: 0, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} />
              
              <XAxis 
                dataKey="time" 
                stroke={colors.axis}
                tick={{ fill: colors.axis, fontSize: isMobile ? 11 : 13 }}
                tickLine={{ stroke: colors.grid }}
                interval={isMobile ? 4 : 1}
                angle={-45}
                textAnchor={isMobile ? 'end' : 'middle'}
                height={isMobile ? 10 : 20}
              />
              
              <YAxis 
                stroke={colors.axis}
                tick={{ fill: colors.axis, fontSize: isMobile ? 11 : 13 }}
                tickLine={{ stroke: colors.grid }}
                domain={['auto', 'auto']}
                width={isMobile ? 35 : 40}
                unit={dataType === 'temperature' ? '°C' : '%'}
              />
              
              <Tooltip
                contentStyle={{
                  backgroundColor: colors.cardBg,
                  border: `1px solid ${colors.border}`,
                  borderRadius: 12,
                  backdropFilter: 'blur(8px)',
                  color: colors.text
                }}
                labelStyle={{ color: colors.text, fontWeight: 600, marginBottom: 4 }}
                formatter={(value: number, name: string) => {
                  if (value === null) return ['—', name === 'inside' ? 'Внутри' : 'Снаружи']
                  const unit = dataType === 'temperature' ? '°C' : '%'
                  return [`${value.toFixed(1)}${unit}`, name === 'inside' ? 'Внутри' : 'Снаружи']
                }}
              />
              
              <Legend 
                wrapperStyle={{ 
                  color: colors.text, 
                  paddingTop: 0,
                  fontSize: isMobile ? 13 : 15
                }}
                iconType="circle"
                formatter={(value) => {
                  return value === 'inside' ? 'Внутри' : 'Снаружи'
                }}
              />
              
              <Line
                type="monotone"
                dataKey="inside"
                name="inside"
                stroke={colors.inside}
                strokeWidth={isMobile ? 2 : 2.5}
                dot={false}
                connectNulls={true}
                activeDot={{ r: isMobile ? 4 : 6, fill: colors.inside }}
                animationDuration={1000}
              />
              
              <Line
                type="monotone"
                dataKey="outside"
                name="outside"
                stroke={colors.outside}
                strokeWidth={isMobile ? 2 : 2.5}
                dot={false}
                connectNulls={true}
                activeDot={{ r: isMobile ? 4 : 6, fill: colors.outside }}
                animationDuration={1000}
              />
            </LineChart>
          </div>
        )}
      </div>

      {/* Статистика - теперь из реальных данных */}
      {stats && (
        <div style={{
          marginTop: 24,
          padding: isMobile ? 16 : 20,
          backgroundColor: colors.cardBg,
          borderRadius: 16,
          border: `1px solid ${colors.border}`
        }}>
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 16,
            flexWrap: 'wrap',
            gap: 12
          }}>
            <span style={{ color: colors.text, fontWeight: 600, fontSize: isMobile ? 14 : 16 }}>
              📊 Статистика за {stats.period_hours}ч
            </span>
          </div>

          {/* Сетка с внутренней/внешней статистикой */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: isMobile ? '1fr' : 'repeat(2, 1fr)',
            gap: isMobile ? 20 : 24
          }}>
            {/* Внутренние датчики */}
            <div>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 12
              }}>
                <span style={{ fontSize: 20 }}>🏠</span>
                <span style={{ color: colors.text, fontWeight: 500, fontSize: isMobile ? 14 : 16 }}>
                  Внутри
                </span>
              </div>
              
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: isMobile ? 8 : 12
              }}>
                <StatValue 
                  label="Средняя" 
                  temp={stats.avg_temp_in} 
                  hum={stats.avg_hum_in}
                  dataType={dataType}
                  color={colors.inside}
                  isMobile={isMobile}
                />
                <StatValue 
                  label="Мин" 
                  temp={stats.min_temp_in} 
                  hum={stats.min_hum_in}
                  dataType={dataType}
                  color={colors.inside}
                  isMobile={isMobile}
                />
                <StatValue 
                  label="Макс" 
                  temp={stats.max_temp_in} 
                  hum={stats.max_hum_in}
                  dataType={dataType}
                  color={colors.inside}
                  isMobile={isMobile}
                />
              </div>
            </div>

            {/* Уличные датчики */}
            <div>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 12
              }}>
                <span style={{ fontSize: 20 }}>🌍</span>
                <span style={{ color: colors.text, fontWeight: 500, fontSize: isMobile ? 14 : 16 }}>
                  Снаружи
                </span>
              </div>
              
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: isMobile ? 8 : 12
              }}>
                <StatValue 
                  label="Средняя" 
                  temp={stats.avg_temp_out} 
                  hum={stats.avg_hum_out}
                  dataType={dataType}
                  color={colors.outside}
                  isMobile={isMobile}
                />
                <StatValue 
                  label="Мин" 
                  temp={stats.min_temp_out} 
                  hum={stats.min_hum_out}
                  dataType={dataType}
                  color={colors.outside}
                  isMobile={isMobile}
                />
                <StatValue 
                  label="Макс" 
                  temp={stats.max_temp_out} 
                  hum={stats.max_hum_out}
                  dataType={dataType}
                  color={colors.outside}
                  isMobile={isMobile}
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Компонент для отображения значения статистики
function StatValue({ 
  label, 
  temp, 
  hum, 
  dataType, 
  color, 
  isMobile 
}: { 
  label: string
  temp: number | null
  hum: number | null
  dataType: DataType
  color: string
  isMobile: boolean 
}) {
  const value = dataType === 'temperature' ? temp : hum
  const unit = dataType === 'temperature' ? '°C' : '%'
  
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      textAlign: 'center'
    }}>
      <span style={{
        color: '#9ca3af',
        fontSize: isMobile ? 10 : 11,
        marginBottom: 4
      }}>
        {label}
      </span>
      <span style={{
        color: value !== null ? color : '#9ca3af',
        fontSize: isMobile ? 16 : 18,
        fontWeight: 600
      }}>
        {value !== null && value !== undefined 
          ? `${value.toFixed(1)}${unit}` 
          : '—'
        }
      </span>
    </div>
  )
}