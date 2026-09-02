import { motion } from 'framer-motion'
import styles from './LaunchScreen.module.css'
import logo from '../../assets/logo.png'

// Анимации идут цепочкой, а не пачкой: логотип 0–0.35s, затем пульсация
// ореола (её задержка живёт в CSS) и заголовок 0.35–0.75s. Раньше всё
// стартовало внахлёст в первые 350 мс — на телефоне это давало рваный вход.
// Вся цепочка укладывается в 0.75s, то есть внутрь минимального времени показа
// самого экрана (1s, см. App.tsx), иначе хвост анимации срезало бы переходом.
export const LaunchScreen = () => {
  return (
    <div className={styles.container}>
      {/* Стеклянный оверлей */}
      <div className={styles.glassOverlay} />

      <div className={styles.content}>
        {/* Лого */}
        <div className={styles.logoContainer}>
          <div className={styles.logoGlow} />
          <motion.div
            className={styles.logoFrame}
            initial={{ opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.35, ease: [0.23, 1, 0.32, 1] }}
          >
            <img src={logo} alt="Logo" className={styles.logo} />
          </motion.div>
        </div>

        {/* Текст */}
        <motion.h1
          className={styles.title}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.35, duration: 0.4 }}
        >
          Умный дом
        </motion.h1>
      </div>
    </div>
  );
};