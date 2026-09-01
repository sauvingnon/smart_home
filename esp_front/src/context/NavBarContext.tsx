// src/context/NavBarContext.tsx
import React, { createContext, useContext, useState, useEffect, useRef, ReactNode } from 'react'

interface NavBarContextType {
  hidden: boolean
  setHidden: (hidden: boolean) => void
  reselectTick: number
  triggerReselect: () => void
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

// Дергает <BottomNavBar /> по тапу на уже активный таб.
export const useTriggerTabReselect = () => useNavBar().triggerReselect

// Классический iOS-жест: повторный тап по уже открытому табу что-то делает
// с его содержимым — обычно скроллит наверх, но, например, в чате логичнее
// вниз (к последним сообщениям), поэтому решение остаётся за страницей. Тик
// меняется только по реселекту (не на первом монтировании), а колбэк лежит
// в ref, чтобы не тянуть его в deps эффекта — иначе страницы ловили бы
// лишний вызов при каждом ре-рендере.
export const useOnTabReselect = (onReselect: () => void) => {
  const { reselectTick } = useNavBar()
  const callbackRef = useRef(onReselect)
  callbackRef.current = onReselect

  const isFirst = useRef(true)
  useEffect(() => {
    if (isFirst.current) {
      isFirst.current = false
      return
    }
    callbackRef.current()
  }, [reselectTick])
}

interface NavBarProviderProps {
  children: ReactNode
}

export const NavBarProvider: React.FC<NavBarProviderProps> = ({ children }) => {
  const [hidden, setHidden] = useState(false)
  const [reselectTick, setReselectTick] = useState(0)
  const triggerReselect = () => setReselectTick((t) => t + 1)

  return (
    <NavBarContext.Provider value={{ hidden, setHidden, reselectTick, triggerReselect }}>
      {children}
    </NavBarContext.Provider>
  )
}
