// src/contexts/ThemeContext.tsx
import React, { createContext, useContext, useState, useEffect, useRef, ReactNode } from 'react'

type Theme = 'light' | 'dark'

interface ThemeContextType {
  theme: Theme
  toggleTheme: () => void
  setTheme: (theme: Theme) => void
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined)

export const useTheme = () => {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider')
  }
  return context
}

interface ThemeProviderProps {
  children: ReactNode
}

export const ThemeProvider: React.FC<ThemeProviderProps> = ({ children }) => {
  const getThemeByTime = (): Theme => {
    const hour = new Date().getHours()
    return hour >= 6 && hour < 18 ? 'light' : 'dark'
  }

  const [theme, setTheme] = useState<Theme>(getThemeByTime)
  // Ручное переключение (кнопкой) должно "залипать" — иначе автосмена по
  // времени суток перетирала бы выбор пользователя в течение минуты.
  const manualOverrideRef = useRef(false)

  // Применяем тему к документу
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)

    // Полосу под чёлкой/Dynamic Island красит сам html (background-color,
    // см. index.css) — никакой элемент страницы туда не дотягивается, пока в
    // viewport-мете нет viewport-fit=cover. Плюс дублируем цвет в theme-color:
    // на iOS 16.4+/Android им тонируется системная плашка статус-бара, а
    // статикой в manifest.json он вечно белый.
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) {
      meta.setAttribute('content', theme === 'dark' ? '#0f172a' : '#e0f2fe')
    }
  }, [theme])

  // Автоматически переключаем тему по времени суток каждую минуту, пока юзер
  // не переключил её вручную в этой сессии.
  useEffect(() => {
    const interval = setInterval(() => {
      if (!manualOverrideRef.current) setTheme(getThemeByTime())
    }, 60_000)
    return () => clearInterval(interval)
  }, [])

  const toggleTheme = () => {
    manualOverrideRef.current = true
    setTheme(prev => prev === 'light' ? 'dark' : 'light')
  }

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}