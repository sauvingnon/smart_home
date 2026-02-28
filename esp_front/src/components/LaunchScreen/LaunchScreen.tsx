import { motion } from 'framer-motion'
import styles from './LaunchScreen.module.css'

export const LaunchScreen = () => {
  return (
    <div className={styles.container}>
      {/* Стеклянный оверлей */}
      <div className={styles.glassOverlay} />
      
      <div className={styles.content}>
        {/* Лого с оборотом по Y */}
        <motion.div 
          className={styles.logoContainer}
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.8, ease: [0.23, 1, 0.32, 1] }}
        >
          <div className={styles.logoGlow} />
          <img 
            src="/public/android-chrome-512x512.png" 
            alt="Logo" 
            className={styles.logo}
          />
        </motion.div>
        
        {/* Текст */}
        <motion.h1
          className={styles.title}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3, duration: 0.6 }}
        >
          Умный дом
        </motion.h1>
        
        <motion.p
          className={styles.subtitle}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5, duration: 0.6 }}
        >
          SMART LIVING
        </motion.p>
      </div>
    </div>
  );
};