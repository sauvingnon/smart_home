// src/context/NavBarContext.tsx
import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react'

interface NavBarContextType {
  hidden: boolean
  setHidden: (hidden: boolean) => void
}

const NavBarContext = createContext<NavBarContextType | undefined>(undefined)

const useNavBar = () => {
  const context = useContext(NavBarContext)
  if (!context) {
    throw new Error('useNavBar must be used within a NavBarProvider')
  }
  return context
}

// Читает состояние — для самого <BottomNavBar />.
export const useNavBarHidden = () => useNavBar().hidden

// Прячет нав-бар на время жизни компонента, когда hidden = true.
// Именно хук, а не голый setHidden: страница, которая ушла с экрана (или
// размонтировалась в скрытом состоянии), обязана вернуть бар обратно, иначе
// он останется невидимым на всём приложении. Cleanup это гарантирует.
export const useHideNavBar = (hidden: boolean) => {
  const { setHidden } = useNavBar()
  useEffect(() => {
    setHidden(hidden)
    return () => setHidden(false)
  }, [hidden, setHidden])
}

interface NavBarProviderProps {
  children: ReactNode
}

export const NavBarProvider: React.FC<NavBarProviderProps> = ({ children }) => {
  const [hidden, setHidden] = useState(false)

  return (
    <NavBarContext.Provider value={{ hidden, setHidden }}>
      {children}
    </NavBarContext.Provider>
  )
}
