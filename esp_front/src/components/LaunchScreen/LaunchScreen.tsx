import { motion } from 'framer-motion'
import styles from './LaunchScreen.module.css'
import logo from '../../assets/logo.png'

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
          transition={{ delay: 0.2, duration: 0.5 }}
        >
          Умный дом
        </motion.h1>

        <motion.p
          className={styles.subtitle}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.35, duration: 0.5 }}
        >
          SMART LIVING
        </motion.p>
      </div>
    </div>
  );
};