import { NavLink } from 'react-router-dom';
import { useTheme } from '../../context/ThemeContext';
import { Home, Camera, Video, Settings } from 'lucide-react';
import './BottomNavBar.css';

const navItems = [
  { path: '/', icon: Home, label: 'Главная' },
  { path: '/camera', icon: Camera, label: 'Камера' },
  { path: '/videos', icon: Video, label: 'Видео' },
  { path: '/settings', icon: Settings, label: 'Настройки' },
];

export const BottomNavBar = () => {
  const { theme } = useTheme();

  return (
    <nav className={`bottom-nav ${theme}`}>
      {navItems.map(({ path, icon: Icon, label }) => (
        <NavLink
          key={path}
          to={path}
          className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
        >
          <Icon size={22} strokeWidth={1.5} className="nav-icon" />
          <span className="nav-label">{label}</span>
        </NavLink>
      ))}
    </nav>
  );
};