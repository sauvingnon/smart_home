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

    // #app-background (position:fixed, вне React-дерева — см. index.html)
    // красится только через CSS-переменные на :root[data-theme]. В WebKit/PWA
    // такой fixed-слой под чёлкой/Dynamic Island не всегда перерисовывается
    // от одной только смены custom property без соседнего layout-триггера —
    // раньше "чинить" полосу приходилось случайно, заходя на страницу с
    // подходящими viewport-юнитами. Вместо того чтобы зависеть от вёрстки
    // текущей страницы, форсируем репейнт слоя явно и всегда, при каждой
    // смене темы, независимо от того, что сейчас смонтировано.
    const bg = document.getElementById('app-background')
    if (bg) {
      bg.style.transform = 'translateZ(0)'
      void bg.offsetHeight
      bg.style.transform = ''
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