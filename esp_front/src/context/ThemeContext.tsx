// src/contexts/ThemeContext.tsx
import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react'

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
  const [theme, setTheme] = useState<Theme>('light')

  // Функция для определения темы по времени суток
  const getSystemTheme = (): Theme => {
    const hour = new Date().getHours()
    return hour >= 6 && hour < 18 ? 'light' : 'dark'
  }

  // Инициализация темы при загрузке
  useEffect(() => {
    const savedTheme = localStorage.getItem('theme') as Theme | null
    
    if (savedTheme) {
      // Если есть сохраненная тема - используем её
      setTheme(savedTheme)
    } else {
      // Иначе ставим по времени суток
      setTheme(getSystemTheme())
    }
  }, [])

  // Сохраняем тему в localStorage и применяем к документу
  useEffect(() => {
    localStorage.setItem('theme', theme)
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  const toggleTheme = () => {
    setTheme(prev => prev === 'light' ? 'dark' : 'light')
  }

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}