import { NavLink, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useTheme } from '../../context/ThemeContext';
import { useChat } from '../../context/ChatContext';
import { useNavBarHidden, useTriggerTabReselect } from '../../context/NavBarContext';
import { Home, MessageCircle, Video, SlidersHorizontal } from 'lucide-react';
import './BottomNavBar.css';

// Четыре вкладки по задачам, а не по устройствам. Камеры среди них нет
// намеренно: живой поток лежит в «Видео», рядом с записями той же камеры, а
// сервисные настройки платы — в «Управлении».
const navItems = [
  { path: '/', icon: Home, label: 'Дом' },
  { path: '/chat', icon: MessageCircle, label: 'Чат' },
  { path: '/videos', icon: Video, label: 'Видео' },
  { path: '/settings', icon: SlidersHorizontal, label: 'Управление' },
];

export const BottomNavBar = () => {
  const { theme } = useTheme();
  const { unreadCount } = useChat();
  const location = useLocation();
  const triggerReselect = useTriggerTabReselect();
  // Прячем классом, а не размонтированием: компонент живёт один раз на всё
  // приложение (см. App.tsx), и его размонтирование убивало бы shared-layout
  // анимацию таблетки — ровно то, ради чего он туда и поднят.
  const hidden = useNavBarHidden();

  return (
    <nav className={`bottom-nav ${theme} ${hidden ? 'hidden' : ''}`}>
      {navItems.map(({ path, icon: Icon, label }) => {
        const isActive = path === '/'
          ? location.pathname === '/'
          : location.pathname.startsWith(path.split('/').slice(0, 2).join('/'));

        return (
          <NavLink
            key={path}
            to={path}
            className={`nav-item ${isActive ? 'active' : ''}`}
            onClick={() => {
              if (isActive) triggerReselect();
            }}
          >
            {isActive && (
              <motion.div
                className="nav-pill"
                layoutId="nav-pill"
                transition={{ type: 'spring', stiffness: 380, damping: 32 }}
              />
            )}
            <span className="nav-icon-wrap">
              <Icon size={22} strokeWidth={1.5} className="nav-icon" />
              {path === '/chat' && unreadCount > 0 && (
                <span className="nav-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>
              )}
            </span>
            <span className="nav-label">{label}</span>
          </NavLink>
        );
      })}
    </nav>
  );
};