import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, Settings, BellOff, BellRing, Loader2, Users, Cpu } from 'lucide-react';
import { useTheme } from '../../context/ThemeContext';
import { useChatPush } from '../../hooks/useChatPush';
import { apiClient } from '../../api/client';
import type { VideoNotifyPrefs } from '../../api/client';
import { PEOPLE_FILTERS, recognizedDisplayName } from '../../constants/people';
import './VideoSettingsPage.css';

const containerVar = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.05 } },
};
const itemVar = {
  hidden: { y: 12, opacity: 0 },
  visible: { y: 0, opacity: 1 },
};

const DEFAULT_PREFS: VideoNotifyPrefs = { visit_people: {}, board_offline: true };

export const VideoSettingsPage: React.FC = () => {
  const { theme } = useTheme();
  const navigate = useNavigate();
  // Тот же пуш, что и в настройках чата — подписка на устройство одна,
  // тумблер здесь просто дублирует тот же переключатель.
  const { notifStatus, subscribed, busy: pushBusy, requestAccess, unsubscribe } = useChatPush();

  const canToggleNotif = notifStatus === 'default' || notifStatus === 'granted';

  // По какой теме что слать — грузится отдельно от самой push-подписки.
  const [prefs, setPrefs] = useState<VideoNotifyPrefs>(DEFAULT_PREFS);

  useEffect(() => {
    apiClient.getVideoNotifyPrefs()
      .then(setPrefs)
      .catch((err) => console.error('Не удалось загрузить настройки уведомлений', err));
  }, []);

  // Незнакомый человеку ключ (ещё не сохранённый) по умолчанию включён —
  // так добавление нового лица в датасет не требует явного опта.
  const isPersonNotified = (label: string) => prefs.visit_people[label] ?? true;

  const savePrefs = (next: VideoNotifyPrefs) => {
    const prev = prefs;
    setPrefs(next);
    apiClient.saveVideoNotifyPrefs(next).catch((err) => {
      console.error('Не удалось сохранить настройки уведомлений', err);
      setPrefs(prev);
    });
  };

  const togglePerson = (label: string) => {
    savePrefs({ ...prefs, visit_people: { ...prefs.visit_people, [label]: !isPersonNotified(label) } });
  };

  const toggleBoardOffline = () => {
    savePrefs({ ...prefs, board_offline: !prefs.board_offline });
  };

  return (
    <div className={`video-settings-page ${theme}`}>
      <div className="background-spot">
        <div className="spot-1"></div>
        <div className="spot-2"></div>
        <div className="spot-3"></div>
      </div>

      <div className="video-settings-container">
        <motion.div
          className="video-settings-header glass-card"
          initial={{ y: -20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
        >
          <button className="back-button" onClick={() => navigate('/videos')} title="Назад к видео">
            <ArrowLeft size={20} />
          </button>
          <div className="video-settings-title-row">
            <Settings size={22} className="title-icon" />
            <h1>Настройки видео</h1>
          </div>
        </motion.div>

        <motion.div variants={containerVar} initial="hidden" animate="visible">
          <motion.div variants={itemVar} className="video-settings-section glass-card">
            <div className="video-settings-row">
              <div className="video-settings-row-icon">
                {notifStatus === 'granted' && subscribed ? <BellRing size={20} /> : <BellOff size={20} />}
              </div>
              <div className="video-settings-row-text">
                <span className="video-settings-row-title">Уведомления</span>
                <span className="video-settings-row-desc">
                  {notifStatus === 'unsupported' && 'Этот браузер не поддерживает push-уведомления.'}
                  {notifStatus === 'ios-not-installed' && 'Добавь приложение на экран «Домой» (Поделиться → На экран «Домой»), чтобы получать их.'}
                  {notifStatus === 'denied' && 'Заблокированы браузером — включить можно только вручную, в настройках сайта.'}
                  {notifStatus === 'default' && 'Получать уведомления, когда приложение закрыто.'}
                  {notifStatus === 'granted' && (subscribed ? 'Включены на этом устройстве.' : 'Выключены на этом устройстве.')}
                </span>
              </div>
              {canToggleNotif && (
                pushBusy ? (
                  <Loader2 size={20} className="video-settings-spin" />
                ) : (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={notifStatus === 'granted' && subscribed}
                    className={`video-settings-switch ${notifStatus === 'granted' && subscribed ? 'on' : ''}`}
                    onClick={() => (notifStatus === 'granted' && subscribed ? unsubscribe() : requestAccess())}
                  >
                    <span className="video-settings-switch-knob" />
                  </button>
                )
              )}
            </div>
          </motion.div>

          <motion.div variants={itemVar} className="video-settings-section glass-card">
            <div className="video-settings-section-title">
              <Users size={16} />
              <span>Уведомлять о посещении</span>
            </div>
            {PEOPLE_FILTERS.map((label) => (
              <div className="video-settings-row" key={label}>
                <div className="video-settings-row-text">
                  <span className="video-settings-row-title">{recognizedDisplayName(label)}</span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={isPersonNotified(label)}
                  className={`video-settings-switch ${isPersonNotified(label) ? 'on' : ''}`}
                  onClick={() => togglePerson(label)}
                >
                  <span className="video-settings-switch-knob" />
                </button>
              </div>
            ))}
          </motion.div>

          <motion.div variants={itemVar} className="video-settings-section glass-card">
            <div className="video-settings-section-title">
              <Cpu size={16} />
              <span>Недоступность платы</span>
            </div>
            <div className="video-settings-row">
              <div className="video-settings-row-text">
                <span className="video-settings-row-title">Центральная плата</span>
                <span className="video-settings-row-desc">Сообщать, если плата, датчик двери и камера пропали одновременно — похоже на то, что дом обесточен.</span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={prefs.board_offline}
                className={`video-settings-switch ${prefs.board_offline ? 'on' : ''}`}
                onClick={toggleBoardOffline}
              >
                <span className="video-settings-switch-knob" />
              </button>
            </div>
          </motion.div>
        </motion.div>
      </div>
    </div>
  );
};

export default VideoSettingsPage;
