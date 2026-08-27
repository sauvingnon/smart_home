import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MotionConfig } from 'framer-motion'
import './index.css'
import App from './App.tsx'
import { AuthProvider } from './context/AuthContext'

// Service worker только для Web Push уведомлений чата — без прекэша/офлайна.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('Не удалось зарегистрировать service worker:', err)
    })
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <AuthProvider>
        <App />
      </AuthProvider>
    </MotionConfig>
  </StrictMode>,
)