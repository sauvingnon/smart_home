import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Calendar, ChevronDown, RotateCw, Sparkles } from 'lucide-react'
import { apiClient } from '../../api/client'
import './AIReport.css'

type ReportType = 'daily' | 'weekly'

interface AIReportProps {
  theme?: 'light' | 'dark'
}

export default function AIReport({ theme = 'dark' }: AIReportProps) {
  const [reportType, setReportType] = useState<ReportType>('daily')
  const [report, setReport] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(true)

  const fetchReport = async (type: ReportType) => {
    setLoading(true)
    setError(null)
    
    try {
      const endpoint = type === 'daily' ? '/esp_service/ai_report/daily' : '/esp_service/ai_report/weekly'
      const response = await apiClient.fetch(endpoint)
      setReport(response)
    } catch (err) {
      console.error('Failed to fetch report:', err)
      setError('Не удалось загрузить отчёт')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchReport(reportType)
  }, [reportType])

  const handleRefresh = () => {
    fetchReport(reportType)
  }

  const handleTypeChange = (type: ReportType) => {
    setReportType(type)
    setExpanded(true)
  }

  const isDark = theme === 'dark'

  return (
    <motion.div 
      className={`ai-report-card ${isDark ? 'dark' : 'light'}`}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.4 }}
    >
      {/* Заголовок с переключателем */}
      <div className="report-header">
        <div className="report-title">
          <Sparkles size={18} className="report-icon" />
          <span>Аналитика от ИИ</span>
        </div>

        <div className="report-controls">
          <div className="report-type-toggle">
            <button
              className={`type-btn ${reportType === 'daily' ? 'active' : ''}`}
              onClick={() => handleTypeChange('daily')}
            >
              День
            </button>
            <button
              className={`type-btn ${reportType === 'weekly' ? 'active' : ''}`}
              onClick={() => handleTypeChange('weekly')}
            >
              Неделя
            </button>
          </div>

          <button
            className="refresh-btn"
            onClick={handleRefresh}
            disabled={loading}
            title="Обновить"
          >
            <RotateCw size={16} className={loading ? 'spin' : ''} />
          </button>

          <button
            className="expand-btn"
            onClick={() => setExpanded(!expanded)}
          >
            <ChevronDown size={16} className={`chevron ${expanded ? 'expanded' : ''}`} />
          </button>
        </div>
      </div>

      {/* Контент отчёта */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="report-content"
          >
            {loading ? (
              <div className="report-loading">
                <div className="loading-spinner" />
                <span>ИИ анализирует данные...</span>
              </div>
            ) : error ? (
              <div className="report-error">
                <span>⚠️ {error}</span>
                <button onClick={handleRefresh} className="retry-btn">
                  Повторить
                </button>
              </div>
            ) : report ? (
              <div className="report-text">
                {report.split('\n').map((paragraph, idx) => (
                  <p key={idx}>{paragraph}</p>
                ))}
              </div>
            ) : (
              <div className="report-empty">
                Нет данных для отчёта
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}