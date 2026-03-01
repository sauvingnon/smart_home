import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { 
  Mic, MicOff, Send, X, Bot, User, Sparkles, 
  ChevronDown, Trash2, Volume2, VolumeX, Play 
} from 'lucide-react'
import { apiClient } from '../../api/client'
import './AIVoiceChat.css'

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
}

interface AIVoiceChatProps {
  theme?: 'light' | 'dark'
  onClose?: () => void
}

export default function AIVoiceChat({ theme = 'dark', onClose }: AIVoiceChatProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [inputText, setInputText] = useState('')
  const [loading, setLoading] = useState(false)
  const [isListening, setIsListening] = useState(false)
  const [speechSupported, setSpeechSupported] = useState(true)
  const [voiceOutput, setVoiceOutput] = useState(true)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const [isMobile, setIsMobile] = useState(false)
  
  // ФИЧА 1: Состояния для ручного воспроизведения на мобилках
  const [manualPlayRequired, setManualPlayRequired] = useState(false)
  const [pendingResponse, setPendingResponse] = useState<string | null>(null)
  const [voiceInitialized, setVoiceInitialized] = useState(false)
  
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const chatContainerRef = useRef<HTMLDivElement>(null)
  const recognitionRef = useRef<any>(null)
  const synthRef = useRef<SpeechSynthesis | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Инициализация синтезатора речи
  useEffect(() => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      synthRef.current = window.speechSynthesis
    }
  }, [])

  // Определяем мобильное устройство и проверяем поддержку голоса
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth <= 480)
    }
    checkMobile()
    window.addEventListener('resize', checkMobile)

    // Проверяем мобильный браузер по user-agent
    const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
    
    // На мобильных iOS особенно проблемно
    if (isMobileDevice && synthRef.current) {
      // Проверяем работает ли синтез (на iOS возвращает false если не инициализирован)
      try {
        const testUtterance = new SpeechSynthesisUtterance('')
        const success = synthRef.current.speak(testUtterance)
        synthRef.current.cancel()
        
        if (!success) {
          setManualPlayRequired(true)
          console.log('📱 Мобильное устройство требует ручного воспроизведения')
        }
      } catch (e) {
        setManualPlayRequired(true)
        console.log('📱 Ошибка инициализации голоса, будет ручное воспроизведение')
      }
    }

    return () => {
      window.removeEventListener('resize', checkMobile)
    }
  }, [])

  // Инициализация SpeechRecognition
  useEffect(() => {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      setSpeechSupported(false)
      return
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    recognitionRef.current = new SpeechRecognition()
    recognitionRef.current.lang = 'ru-RU'
    recognitionRef.current.continuous = false
    recognitionRef.current.interimResults = false

    recognitionRef.current.onresult = (event: any) => {
      const text = event.results[0][0].transcript
      setInputText(text)
      inputRef.current?.focus()
      setIsListening(false)
    }

    recognitionRef.current.onerror = () => {
      setIsListening(false)
    }

    recognitionRef.current.onend = () => {
      setIsListening(false)
    }

    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.abort()
      }
    }
  }, [])

  // Загрузка истории из localStorage
  useEffect(() => {
    const saved = localStorage.getItem('ai_chat_history')
    if (saved) {
      try {
        const parsed = JSON.parse(saved)
        setMessages(parsed.map((msg: any) => ({
          ...msg,
          timestamp: new Date(msg.timestamp)
        })))
      } catch (e) {
        console.error('Failed to load chat history:', e)
      }
    }
  }, [])

  // Сохранение в localStorage
  useEffect(() => {
    if (messages.length > 0) {
      localStorage.setItem('ai_chat_history', JSON.stringify(messages))
    }
  }, [messages])

  // Скролл к последнему сообщению
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  // Проверка скролла для показа кнопки
  const handleScroll = () => {
    if (!chatContainerRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = chatContainerRef.current
    const isNearBottom = scrollHeight - scrollTop - clientHeight < 100
    setShowScrollBtn(!isNearBottom)
  }

  // Функция принудительной инициализации голоса по жесту пользователя
  const initializeVoice = () => {
    if (!synthRef.current || voiceInitialized) return
    
    try {
      // Пробуем активировать голос
      const utterance = new SpeechSynthesisUtterance('')
      synthRef.current.speak(utterance)
      synthRef.current.cancel()
      setVoiceInitialized(true)
      setManualPlayRequired(false)
      console.log('🔊 Голос активирован по жесту')
    } catch (e) {
      console.log('❌ Не удалось активировать голос')
    }
  }

  // Функция ручного воспроизведения последнего ответа
  const playLastResponse = () => {
    if (!pendingResponse || !synthRef.current) return
    
    try {
      synthRef.current.cancel()
      const utterance = new SpeechSynthesisUtterance(pendingResponse)
      utterance.lang = 'ru-RU'
      utterance.rate = 1.0
      utterance.onend = () => {
        setPendingResponse(null)
      }
      synthRef.current.speak(utterance)
    } catch (e) {
      console.error('Ошибка воспроизведения:', e)
    }
  }

  // Функция озвучивания
  const speakResponse = (text: string) => {
    if (!voiceOutput || !synthRef.current) return
    
    // Если требуется ручное воспроизведение - сохраняем текст
    if (manualPlayRequired) {
      setPendingResponse(text)
      return
    }
    
    try {
      synthRef.current.cancel()
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.lang = 'ru-RU'
      utterance.rate = 1.0
      utterance.onerror = () => {
        // Если ошибка - переключаем в ручной режим
        setManualPlayRequired(true)
        setPendingResponse(text)
      }
      synthRef.current.speak(utterance)
    } catch (e) {
      console.error('Ошибка озвучивания:', e)
      setManualPlayRequired(true)
      setPendingResponse(text)
    }
  }

  // Отправка сообщения
  const sendMessage = async () => {
    if (!inputText.trim() || loading) return

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: inputText,
      timestamp: new Date()
    }

    setMessages(prev => [...prev, userMessage])
    setInputText('')
    setLoading(true)

    try {
      const response = await apiClient.fetch('/esp_service/ai_command', {
        method: 'POST',
        body: JSON.stringify({ text: inputText })
      })

      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: response,
        timestamp: new Date()
      }

      setMessages(prev => [...prev, assistantMessage])

      // Озвучиваем ответ
      speakResponse(assistantMessage.content)

    } catch (error) {
      console.error('AI command failed:', error)
      
      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: '❌ Не удалось выполнить команду',
        timestamp: new Date()
      }
      setMessages(prev => [...prev, errorMessage])
    } finally {
      setLoading(false)
    }
  }

  // Очистка истории
  const clearHistory = () => {
    setMessages([])
    localStorage.removeItem('ai_chat_history')
  }

  // Запуск/остановка записи
  const toggleListening = () => {
    if (!recognitionRef.current) return

    if (isListening) {
      recognitionRef.current.abort()
      setIsListening(false)
    } else {
      try {
        recognitionRef.current.start()
        setIsListening(true)
      } catch (e) {
        console.error('Speech recognition failed:', e)
      }
    }
  }

  // Обработчик касания для инициализации голоса
  const handleTouchStart = () => {
    if (!voiceInitialized) {
      initializeVoice()
    }
  }

  const isDark = theme === 'dark'

  return (
    <motion.div 
      className={`ai-chat-container ${isDark ? 'dark' : 'light'} ${isMobile ? 'mobile' : ''}`}
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.2 }}
      onTouchStart={handleTouchStart}
      onClick={handleTouchStart}
    >
      {/* Заголовок */}
      <div className="chat-header">
        <div className="chat-title">
          <Sparkles size={20} className="title-icon" />
          <h2>AI Ассистент</h2>
        </div>
        
        <div className="header-controls">
          <button
            className={`voice-output-btn ${voiceOutput ? 'active' : ''}`}
            onClick={() => setVoiceOutput(!voiceOutput)}
            title={voiceOutput ? 'Отключить озвучку' : 'Включить озвучку'}
          >
            {voiceOutput ? <Volume2 size={18} /> : <VolumeX size={18} />}
          </button>
          
          <button
            className="clear-btn"
            onClick={clearHistory}
            title="Очистить историю"
          >
            <Trash2 size={18} />
          </button>
          
          {onClose && (
            <button
              className="close-btn"
              onClick={onClose}
              title="Закрыть"
            >
              <X size={18} />
            </button>
          )}
        </div>
      </div>

      {/* Сообщения */}
      <div 
        className="messages-container"
        ref={chatContainerRef}
        onScroll={handleScroll}
      >
        {messages.length === 0 ? (
          <div className="empty-state">
            <Bot size={48} className="empty-icon" />
            <p>Ожидаю твою команду</p>
            <p className="empty-hint">Например: "активируй вентилятор" или "включи свет"</p>
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`message ${msg.role}`}
            >
              <div className="message-avatar">
                {msg.role === 'user' ? <User size={16} /> : <Bot size={16} />}
              </div>
              <div className="message-content">
                <div className="message-header">
                  <span className="message-author">
                    {msg.role === 'user' ? 'Вы' : 'Ассистент'}
                  </span>
                  <span className="message-time">
                    {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <div className="message-text">{msg.content}</div>
              </div>
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Кнопка прокрутки вниз */}
      <AnimatePresence>
        {showScrollBtn && (
          <motion.button
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            className="scroll-bottom-btn"
            onClick={scrollToBottom}
          >
            <ChevronDown size={20} />
          </motion.button>
        )}
      </AnimatePresence>

      {/* ФИЧА 1: Кнопка ручного воспроизведения для мобилок */}
      <AnimatePresence>
        {manualPlayRequired && pendingResponse && (
          <motion.button
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            className="play-voice-btn"
            onClick={playLastResponse}
            title="Озвучить ответ"
          >
            <Play size={20} />
          </motion.button>
        )}
      </AnimatePresence>

      {/* ФИЧА 2: Поле ввода с фиксированной шириной для мобильных */}
      <div className="input-area">
        <div className="input-wrapper">
          <input
            ref={inputRef}
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
            placeholder="Напишите сообщение..."
            disabled={loading}
            className="message-input"
          />
          
          {speechSupported && (
            <button
              className={`mic-btn ${isListening ? 'listening' : ''}`}
              onClick={toggleListening}
              disabled={loading}
              title={isListening ? 'Остановить запись' : 'Голосовой ввод'}
            >
              {isListening ? <Mic size={18} /> : <MicOff size={18} />}
            </button>
          )}
          
          <button
            className="send-btn"
            onClick={sendMessage}
            disabled={!inputText.trim() || loading}
          >
            <Send size={18} />
          </button>
        </div>
      </div>

      {/* Индикатор записи */}
      <AnimatePresence>
        {isListening && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            className="recording-indicator"
          >
            <span className="recording-pulse" />
            <span>Слушаю...</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Индикатор загрузки */}
      <AnimatePresence>
        {loading && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="loading-indicator"
          >
            <div className="typing-dots">
              <span>.</span><span>.</span><span>.</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}