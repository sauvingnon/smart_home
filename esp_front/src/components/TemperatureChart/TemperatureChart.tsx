import { useState, useEffect } from 'react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts'
import { apiClient } from '../../api/client'

// Типы для диапазонов
type TimeRange = '6h' | '12h' | '24h' | '48h' | '7d'

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
  '6h': 50,   // 6 часов = 50 точек
  '12h': 75,  // 12 часов = 75 точек
  '24h': 100, // 24 часа = 100 точек
  '48h': 120, // 48 часов = 120 точек
  '7d': 168   // 7 дней = 168 точек (каждый час)
}

interface HistoryRecord {
  timestamp: string
  temp_in: number | null
  temp_out: number | null
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
  const [data, setData] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const [containerRef, setContainerRef] = useState<HTMLDivElement | null>(null)

  // Загрузка реальных данных
  useEffect(() => {
    const fetchHistory = async () => {
      setLoading(true)
      setError(null)
      
      try {
        const hours = rangeToHours[selectedRange]
        const points = rangePoints[selectedRange]
        const response = await apiClient.fetch(`/esp_service/history?hours=${hours}&max_points=${points}`)
        
        // Преобразуем данные для графика
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
            inside: record.temp_in,
            outside: record.temp_out,
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
    inside: '#f97316',
    outside: '#3b82f6',
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

  // Статистика (только для не-null значений)
  const validInside = data.filter(d => d.inside !== null).map(d => d.inside)
  const validOutside = data.filter(d => d.outside !== null).map(d => d.outside)
  
  const avgInside = validInside.length 
    ? (validInside.reduce((a, b) => a + b, 0) / validInside.length).toFixed(1)
    : '--'
  
  const avgOutside = validOutside.length 
    ? (validOutside.reduce((a, b) => a + b, 0) / validOutside.length).toFixed(1)
    : '--'
  
  const minInside = validInside.length ? Math.min(...validInside).toFixed(1) : '--'
  const maxInside = validInside.length ? Math.max(...validInside).toFixed(1) : '--'

 // Вместо фиксированной высоты:
  const chartHeight = isMobile ? 350 : 450
  const chartWidth = isMobile ? 450 : Math.min(containerWidth - 40, 600) // Уменьшил ширину

  return (
    <div 
      ref={setContainerRef}
      style={{
        width: '100%',
        backgroundColor: colors.bg,
        borderRadius: 24,
        padding: isMobile ? 12 : 20,
        marginTop: 20,
        boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -1px rgba(0,0,0,0.06)',
        border: `1px solid ${colors.border}`
      }}
    >
      
      {/* Заголовок и выбор диапазона */}
      <div style={{
        display: 'flex',
        flexDirection: isMobile ? 'column' : 'row',
        justifyContent: 'space-between',
        alignItems: isMobile ? 'stretch' : 'center',
        gap: 12,
        marginBottom: 20
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 24 }}>🌡️</span>
          <span style={{ color: colors.text, fontWeight: 600, fontSize: isMobile ? 16 : 18 }}>
            Температура: дом / улица
          </span>
          {loading && <span style={{ color: colors.textSecondary, fontSize: 12 }}>⏳</span>}
          {error && <span style={{ color: '#ef4444', fontSize: 12 }}>⚠️</span>}
        </div>

        {/* Кнопки выбора диапазона */}
        <div style={{
          display: 'flex',
          gap: 4,
          backgroundColor: colors.cardBg,
          padding: 4,
          borderRadius: 12,
          flexWrap: 'wrap'
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
                flex: isMobile ? 1 : 'auto',
                opacity: loading ? 0.5 : 1
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* График */}
      <div style={{ 
        width: '100%', 
        height: isMobile ? 380 : 500,
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
              margin={{ top: 20, right: 30, left: 0, bottom: 30 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} />
              
              <XAxis 
                dataKey="time" 
                stroke={colors.axis}
                tick={{ fill: colors.axis, fontSize: isMobile ? 9 : 11 }}
                tickLine={{ stroke: colors.grid }}
                interval={isMobile ? 2 : 1}
                angle={-60}
                textAnchor={isMobile ? 'end' : 'middle'}
                height={isMobile ? 60 : 40}
              />
              
              <YAxis 
                stroke={colors.axis}
                tick={{ fill: colors.axis, fontSize: isMobile ? 9 : 11 }}
                tickLine={{ stroke: colors.grid }}
                domain={['auto', 'auto']}
                width={isMobile ? 30 : 40}
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
                  return [`${value.toFixed(1)}°C`, name === 'inside' ? 'Внутри' : 'Снаружи']
                }}
              />
              
              <Legend 
                wrapperStyle={{ 
                  color: colors.text, 
                  paddingTop: 10,
                  fontSize: isMobile ? 11 : 13
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

      {/* Статистика внизу */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: isMobile ? 'repeat(3, 1fr)' : 'repeat(4, 1fr)',
        gap: isMobile ? 8 : 16,
        marginTop: 20,
        padding: isMobile ? 12 : 16,
        backgroundColor: colors.cardBg,
        borderRadius: 16,
        border: `1px solid ${colors.border}`
      }}>
        <StatBlock 
          label="Средняя внутри"
          value={`${avgInside}°C`}
          color={colors.inside}
          isMobile={isMobile}
        />
        <StatBlock 
          label="Средняя снаружи"
          value={`${avgOutside}°C`}
          color={colors.outside}
          isMobile={isMobile}
        />
        <StatBlock 
          label="Мин/макс вн."
          value={`${minInside} / ${maxInside}°`}
          color={colors.inside}
          isMobile={isMobile}
        />
        <StatBlock 
          label="Разница"
          value={avgInside !== '--' && avgOutside !== '--' 
            ? `${(Number(avgInside) - Number(avgOutside)).toFixed(1)}°C`
            : '--'
          }
          color="#10b981"
          isMobile={isMobile}
        />
      </div>
    </div>
  )
}

// Компонент для блока статистики
function StatBlock({ label, value, color, isMobile }: { 
  label: string
  value: string
  color: string
  isMobile: boolean 
}) {
  return (
    <div style={{ textAlign: isMobile ? 'center' : 'left' }}>
      <div style={{ 
        color: '#9ca3af', 
        fontSize: isMobile ? 9 : 11,
        marginBottom: 4,
        textTransform: 'uppercase',
        letterSpacing: '0.5px'
      }}>
        {label}
      </div>
      <div style={{ 
        color, 
        fontSize: isMobile ? 14 : 18, 
        fontWeight: 600 
      }}>
        {value}
      </div>
    </div>
  )
}