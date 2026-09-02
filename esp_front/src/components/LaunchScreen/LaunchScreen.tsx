import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import styles from './LaunchScreen.module.css'
// ?inline — логотип уезжает в бандл как data-URI, а не отдельным файлом.
// Раньше он был отдельным ассетом, и браузер узнавал его адрес только после
// того, как скачает и распарсит бандл: запрос за картинкой стартовал ровно в
// тот момент, когда React уже рисовал этот экран. Вход логотипа успевал
// проиграть по пустой рамке, а сам логотип вваливался в неё позже — это и
// выглядело как рваная анимация. Data-URI приезжает вместе с кодом, так что
// к первому кадру картинка гарантированно уже в памяти.
// Исходник был PNG RGBA 512×512 на 440 КБ, причём альфа во всех пикселях
// непрозрачная (скругление даёт CSS, а не картинка) — в WebP то же самое
// весит 9,8 КБ, около 13 КБ в base64.
import logo from '../../assets/logo.webp?inline'

// Ждать декода всё равно приходится: data-URI избавляет от запроса по сети, но
// не от разбора битмапа. Страховка по таймауту — на случай, если decode()
// отвалится: экран не должен остаться без логотипа и заголовка.
const DECODE_FALLBACK_MS = 400

// Анимации идут цепочкой, а не пачкой: логотип 0–0.35s, затем пульсация
// ореола (её задержка живёт в CSS) и заголовок 0.35–0.75s. Отсчёт начинается
// не от монтирования, а от готового битмапа — иначе цепочка снова разъедется
// с картинкой. Вся цепочка укладывается в 0.75s, то есть внутрь минимального
// времени показа самого экрана (1s, см. App.tsx), иначе хвост анимации
// срезало бы переходом.
export const LaunchScreen = () => {
  const logoRef = useRef<HTMLImageElement>(null)
  const [logoReady, setLogoReady] = useState(false)

  useEffect(() => {
    const img = logoRef.current
    if (!img) return

    let settled = false
    const start = () => {
      if (settled) return
      settled = true
      setLogoReady(true)
    }

    const fallback = setTimeout(start, DECODE_FALLBACK_MS)
    img.decode().then(start, start)

    return () => clearTimeout(fallback)
  }, [])

  return (
    <div className={styles.container}>
      {/* Стеклянный оверлей */}
      <div className={styles.glassOverlay} />

      <div className={styles.content}>
        {/* Лого */}
        <div className={styles.logoContainer}>
          <div className={`${styles.logoGlow} ${logoReady ? styles.logoGlowOn : ''}`} />
          <motion.div
            className={styles.logoFrame}
            initial={{ opacity: 0, scale: 0.85 }}
            animate={logoReady ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.85 }}
            transition={{ duration: 0.35, ease: [0.23, 1, 0.32, 1] }}
          >
            <img
              ref={logoRef}
              src={logo}
              alt="Logo"
              className={styles.logo}
              decoding="async"
            />
          </motion.div>
        </div>

        {/* Текст */}
        <motion.h1
          className={styles.title}
          initial={{ opacity: 0, y: 20 }}
          animate={logoReady ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
          transition={{ delay: 0.35, duration: 0.4 }}
        >
          Умный дом
        </motion.h1>
      </div>
    </div>
  );
};
