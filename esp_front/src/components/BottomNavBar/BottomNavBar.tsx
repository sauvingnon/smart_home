import { NavLink, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useTheme } from '../../context/ThemeContext';
import { Home, Camera, Video, Settings } from 'lucide-react';
import './BottomNavBar.css';

const navItems = [
  { path: '/', icon: Home, label: 'Главная' },
  { path: '/camera/cam1', icon: Camera, label: 'Камера' },
  { path: '/videos', icon: Video, label: 'Видео' },
  { path: '/settings', icon: Settings, label: 'Настройки' },
];

export const BottomNavBar = () => {
  const { theme } = useTheme();
  const location = useLocation();

  return (
    <nav className={`bottom-nav ${theme}`}>
      {navItems.map(({ path, icon: Icon, label }) => {
        const isActive = path === '/'
          ? location.pathname === '/'
          : location.pathname.startsWith(path.split('/').slice(0, 2).join('/'));

        return (
          <NavLink
            key={path}
            to={path}
            className={`nav-item ${isActive ? 'active' : ''}`}
          >
            {isActive && (
              <motion.div
                className="nav-pill"
                layoutId="nav-pill"
                transition={{ type: 'spring', stiffness: 380, damping: 32 }}
              />
            )}
            <Icon size={22} strokeWidth={1.5} className="nav-icon" />
            <span className="nav-label">{label}</span>
          </NavLink>
        );
      })}
    </nav>
  );
};