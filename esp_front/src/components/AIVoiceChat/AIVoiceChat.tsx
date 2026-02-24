import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { 
  Mic, MicOff, Send, X, Bot, User, Sparkles, 
  ChevronDown, Trash2, Volume2, VolumeX 
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
  
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const chatContainerRef = useRef<HTMLDivElement>(null)
  const recognitionRef = useRef<any>(null)
  const synthRef = useRef(window.speechSynthesis)

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

      // Озвучивание ответа
      if (voiceOutput && synthRef.current) {
        const utterance = new SpeechSynthesisUtterance(assistantMessage.content)
        utterance.lang = 'ru-RU'
        utterance.rate = 1.0
        synthRef.current.speak(utterance)
      }

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

  const isDark = theme === 'dark'

  return (
    <motion.div 
      className={`ai-chat-container ${isDark ? 'dark' : 'light'}`}
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.2 }}
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

      {/* Поле ввода */}
      <div className="input-area">
        <div className="input-wrapper">
          <input
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