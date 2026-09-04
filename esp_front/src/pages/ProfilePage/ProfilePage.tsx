import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, BellOff, BellRing, Loader2, Users, Cpu, MessageCircle, LogOut, AlertTriangle } from 'lucide-react';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { useChatPush } from '../../hooks/useChatPush';
import { apiClient } from '../../api/client';
import type { NotifyPrefs } from '../../api/client';
import { PEOPLE_FILTERS, recognizedDisplayName } from '../../constants/people';
import './ProfilePage.css';

const containerVar = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.05 } },
};
const itemVar = {
  hidden: { y: 12, opacity: 0 },
  visible: { y: 0, opacity: 1 },
};

const DEFAULT_PREFS: NotifyPrefs = {
  visit_people: {}, board_offline: false, chat_messages: true,
  // Своего тумблера ниже пока нет — тема включена всегда, но в объекте
  // присутствует, чтобы сохранение соседней настройки не отправляло prefs без
  // неё (см. NotifyPrefs в api/client.ts).
  chat_reactions: true,
};

export const ProfilePage: React.FC = () => {
  const { theme } = useTheme();
  const { displayName, username, isAdmin, logout } = useAuth();
  const navigate = useNavigate();
  const { notifStatus, subscribed, busy: pushBusy, requestAccess, unsubscribe } = useChatPush();

  const [prefs, setPrefs] = useState<NotifyPrefs>(DEFAULT_PREFS);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  useEffect(() => {
    apiClient.getNotifyPrefs()
      .then(setPrefs)
      .catch((err) => console.error('Не удалось загрузить настройки уведомлений', err));
  }, []);

  const canToggleNotif = notifStatus === 'default' || notifStatus === 'granted';
  const pushOn = notifStatus === 'granted' && subscribed;

  // Темы имеют смысл только при живой подписке: если пуш на устройстве выключен,
  // ни одна из них всё равно не сработает. Гасим секции целиком, а не делаем вид,
  // что тумблеры что-то решают.
  const topicsEnabled = pushOn;

  // Незнакомый ключ (ещё не сохранённый) по умолчанию выключен — уведомления
  // о приходе опт-ин, а не опт-аут. Для чата наоборот, см. NotifyPrefs на бэке.
  const isPersonNotified = (label: string) => prefs.visit_people[label] ?? false;

  const savePrefs = (next: NotifyPrefs) => {
    const prev = prefs;
    setPrefs(next);
    apiClient.saveNotifyPrefs(next).catch((err) => {
      console.error('Не удалось сохранить настройки уведомлений', err);
      setPrefs(prev);
    });
  };

  const togglePerson = (label: string) => {
    savePrefs({ ...prefs, visit_people: { ...prefs.visit_people, [label]: !isPersonNotified(label) } });
  };

  // Выход ждём ответа сервера: если запрос не дошёл, cookie осталась на месте,
  // и молча показать экран логина значит соврать — перезагрузка вернёт сессию.
  const handleLogout = async () => {
    if (loggingOut) return;
    if (!window.confirm('Выйти из аккаунта?')) return;
    setLoggingOut(true);
    setLogoutError(null);
    try {
      await logout();
    } catch {
      setLogoutError('Не удалось выйти. Проверь связь и попробуй ещё раз.');
    } finally {
      setLoggingOut(false);
    }
  };

  const initial = (displayName || username || '?').trim().charAt(0).toUpperCase();

  return (
    <div className={`profile-page ${theme}`}>
      <div className="background-spot">
        <div className="spot-1"></div>
        <div className="spot-2"></div>
        <div className="spot-3"></div>
      </div>

      <div className="profile-container">
        <motion.div
          className="profile-header glass-card"
          initial={{ y: -20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
        >
          <button className="back-button" onClick={() => navigate('/settings')} title="Назад в управление">
            <ArrowLeft size={20} />
          </button>
          <div className="profile-identity">
            <div className="profile-avatar" aria-hidden="true">{initial}</div>
            <div className="profile-identity-text">
              <span className="profile-name">{displayName || username || 'Профиль'}</span>
              <span className="profile-role">{isAdmin ? 'администратор' : 'участник'}</span>
            </div>
          </div>
        </motion.div>

        <motion.div variants={containerVar} initial="hidden" animate="visible">

          {/* Мастер-выключатель: одна push-подписка на устройство, общая для всех
              тем. Раньше этот же тумблер стоял двумя копиями — в настройках чата
              и в настройках видео — и любая из них сносила подписку целиком. */}
          <motion.div variants={itemVar} className="profile-section glass-card">
            <div className="profile-row">
              <div className="profile-row-icon">
                {pushOn ? <BellRing size={20} /> : <BellOff size={20} />}
              </div>
              <div className="profile-row-text">
                <span className="profile-row-title">Уведомления на этом устройстве</span>
                <span className="profile-row-desc">
                  {notifStatus === 'unsupported' && 'Этот браузер не поддерживает push-уведомления.'}
                  {notifStatus === 'ios-not-installed' && 'Добавь приложение на экран «Домой» (Поделиться → На экран «Домой»), чтобы получать их.'}
                  {notifStatus === 'denied' && 'Заблокированы браузером — включить можно только вручную, в настройках сайта.'}
                  {notifStatus === 'default' && 'Получать уведомления, когда приложение закрыто.'}
                  {notifStatus === 'granted' && (subscribed ? 'Включены.' : 'Выключены на этом устройстве.')}
                </span>
              </div>
              {canToggleNotif && (
                pushBusy ? (
                  <Loader2 size={20} className="profile-spin" />
                ) : (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={pushOn}
                    className={`profile-switch ${pushOn ? 'on' : ''}`}
                    onClick={() => (pushOn ? unsubscribe() : requestAccess())}
                  >
                    <span className="profile-switch-knob" />
                  </button>
                )
              )}
            </div>
          </motion.div>

          {/* Секции ниже гаснут именно из-за этого — без явного объяснения
              выглядело бы как баг ("почему тумблеры не нажимаются"), а не
              как логичное следствие выключенных уведомлений на устройстве. */}
          <AnimatePresence>
            {!topicsEnabled && (
              <motion.div
                className="profile-notice"
                initial={{ height: 0, opacity: 0, marginBottom: 0 }}
                animate={{ height: 'auto', opacity: 1, marginBottom: '1rem' }}
                exit={{ height: 0, opacity: 0, marginBottom: 0 }}
                transition={{ duration: 0.2 }}
              >
                <AlertTriangle size={18} className="profile-notice-icon" />
                <span>Опции ниже недоступны — нет доступа к уведомлениям на этом устройстве.</span>
              </motion.div>
            )}
          </AnimatePresence>

          <motion.div
            variants={itemVar}
            className={`profile-section glass-card ${topicsEnabled ? '' : 'muted'}`}
            aria-disabled={!topicsEnabled}
          >
            <div className="profile-section-title">
              <MessageCircle size={16} />
              <span>Чат</span>
            </div>
            <div className="profile-row">
              <div className="profile-row-text">
                <span className="profile-row-title">Новые сообщения</span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={prefs.chat_messages}
                disabled={!topicsEnabled}
                className={`profile-switch ${prefs.chat_messages ? 'on' : ''}`}
                onClick={() => savePrefs({ ...prefs, chat_messages: !prefs.chat_messages })}
              >
                <span className="profile-switch-knob" />
              </button>
            </div>
          </motion.div>

          <motion.div
            variants={itemVar}
            className={`profile-section glass-card ${topicsEnabled ? '' : 'muted'}`}
            aria-disabled={!topicsEnabled}
          >
            <div className="profile-section-title">
              <Users size={16} />
              <span>Кто пришёл</span>
            </div>
            {PEOPLE_FILTERS.map((label) => (
              <div className="profile-row" key={label}>
                <div className="profile-row-text">
                  <span className="profile-row-title">{recognizedDisplayName(label)}</span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={isPersonNotified(label)}
                  disabled={!topicsEnabled}
                  className={`profile-switch ${isPersonNotified(label) ? 'on' : ''}`}
                  onClick={() => togglePerson(label)}
                >
                  <span className="profile-switch-knob" />
                </button>
              </div>
            ))}
          </motion.div>

          <motion.div
            variants={itemVar}
            className={`profile-section glass-card ${topicsEnabled ? '' : 'muted'}`}
            aria-disabled={!topicsEnabled}
          >
            <div className="profile-section-title">
              <Cpu size={16} />
              <span>Дом</span>
            </div>
            <div className="profile-row">
              <div className="profile-row-text">
                <span className="profile-row-title">Плата недоступна</span>
                <span className="profile-row-desc">Сообщать, если плата, датчик двери и камера пропали одновременно — похоже на то, что дом обесточен.</span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={prefs.board_offline}
                disabled={!topicsEnabled}
                className={`profile-switch ${prefs.board_offline ? 'on' : ''}`}
                onClick={() => savePrefs({ ...prefs, board_offline: !prefs.board_offline })}
              >
                <span className="profile-switch-knob" />
              </button>
            </div>
          </motion.div>

          <motion.div variants={itemVar} className="profile-logout-block">
            <button className="profile-logout-button" onClick={handleLogout} disabled={loggingOut}>
              <LogOut size={18} />
              {loggingOut ? 'Выходим…' : 'Выйти из аккаунта'}
            </button>
            {logoutError && (
              <motion.p
                className="profile-logout-error"
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
              >
                {logoutError}
              </motion.p>
            )}
          </motion.div>

        </motion.div>
      </div>
    </div>
  );
};

export default ProfilePage;
