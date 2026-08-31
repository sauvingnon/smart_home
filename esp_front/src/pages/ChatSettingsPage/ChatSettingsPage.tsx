import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, Settings, Bell, BellOff, BellRing, Loader2, Users } from 'lucide-react';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { useChat } from '../../context/ChatContext';
import { useChatPush } from '../../hooks/useChatPush';
import { apiClient } from '../../api/client';
import type { PushStatusEntry } from '../../api/client';
import './ChatSettingsPage.css';

const formatLastSeen = (iso: string): string => {
  const diffMin = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (diffMin < 1) return 'только что';
  if (diffMin < 60) return `${diffMin} мин назад`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours} ч назад`;
  return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
};

const containerVar = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.05 } },
};
const itemVar = {
  hidden: { y: 12, opacity: 0 },
  visible: { y: 0, opacity: 1 },
};

export const ChatSettingsPage: React.FC = () => {
  const { theme } = useTheme();
  const { userId } = useAuth();
  const navigate = useNavigate();
  const { presence } = useChat();
  const { notifStatus, subscribed, busy: pushBusy, requestAccess, unsubscribe } = useChatPush();

  const [pushStatuses, setPushStatuses] = useState<PushStatusEntry[] | null>(null);

  useEffect(() => {
    apiClient.getChatPushStatus()
      .then((res) => setPushStatuses(res.statuses))
      .catch(() => setPushStatuses([]));
  }, []);

  const subscribedByUser = new Map((pushStatuses ?? []).map((s) => [s.user_id, s.subscribed]));

  // Себя в список не включаем — свой статус уведомлений уже виден в секции выше.
  const others = presence
    .filter((p) => p.user_id !== userId)
    .slice()
    .sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      const aTime = a.last_seen ? new Date(a.last_seen).getTime() : 0;
      const bTime = b.last_seen ? new Date(b.last_seen).getTime() : 0;
      return bTime - aTime;
    });

  const canToggleNotif = notifStatus === 'default' || notifStatus === 'granted';

  return (
    <div className={`chat-settings-page ${theme}`}>
      <div className="background-spot">
        <div className="spot-1"></div>
        <div className="spot-2"></div>
        <div className="spot-3"></div>
      </div>

      <div className="chat-settings-container">
        <motion.div
          className="chat-settings-header glass-card"
          initial={{ y: -20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
        >
          <button className="back-button" onClick={() => navigate('/chat')} title="Назад в чат">
            <ArrowLeft size={20} />
          </button>
          <div className="chat-settings-title-row">
            <Settings size={22} className="title-icon" />
            <h1>Настройки чата</h1>
          </div>
        </motion.div>

        <motion.div variants={containerVar} initial="hidden" animate="visible">
          {/* Свои уведомления — реальный тумблер, а не заглушка. */}
          <motion.div variants={itemVar} className="chat-settings-section glass-card">
            <div className="chat-settings-row">
              <div className="chat-settings-row-icon">
                {notifStatus === 'granted' && subscribed ? <BellRing size={20} /> : <BellOff size={20} />}
              </div>
              <div className="chat-settings-row-text">
                <span className="chat-settings-row-title">Уведомления</span>
                <span className="chat-settings-row-desc">
                  {notifStatus === 'unsupported' && 'Этот браузер не поддерживает push-уведомления.'}
                  {notifStatus === 'ios-not-installed' && 'Добавь приложение на экран «Домой» (Поделиться → На экран «Домой»), чтобы получать их.'}
                  {notifStatus === 'denied' && 'Заблокированы браузером — включить можно только вручную, в настройках сайта.'}
                  {notifStatus === 'default' && 'Получать уведомления о новых сообщениях, когда чат закрыт.'}
                  {notifStatus === 'granted' && (subscribed ? 'Включены на этом устройстве.' : 'Выключены на этом устройстве.')}
                </span>
              </div>
              {canToggleNotif && (
                pushBusy ? (
                  <Loader2 size={20} className="chat-settings-spin" />
                ) : (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={notifStatus === 'granted' && subscribed}
                    className={`chat-settings-switch ${notifStatus === 'granted' && subscribed ? 'on' : ''}`}
                    onClick={() => (notifStatus === 'granted' && subscribed ? unsubscribe() : requestAccess())}
                  >
                    <span className="chat-settings-switch-knob" />
                  </button>
                )
              )}
            </div>
          </motion.div>

          {/* Кто в сети / когда был(а) в последний раз + у кого включены
              уведомления — сразу видно, без отдельного тапа. */}
          <motion.div variants={itemVar} className="chat-settings-section glass-card">
            <div className="chat-settings-section-title">
              <Users size={16} />
              <span>Участники</span>
            </div>
            {others.length === 0 ? (
              <div className="chat-settings-empty">Больше никого нет</div>
            ) : (
              others.map((p) => {
                const notifSubscribed = subscribedByUser.get(p.user_id);
                return (
                  <div className="chat-settings-row chat-settings-participant" key={p.user_id}>
                    <span className={`chat-settings-online-dot ${p.online ? 'online' : ''}`} />
                    <div className="chat-settings-row-text">
                      <span className="chat-settings-row-title">{p.display_name}</span>
                      <span className="chat-settings-row-desc">
                        {p.online ? 'в сети' : p.last_seen ? `был(а) в сети ${formatLastSeen(p.last_seen)}` : 'не в сети'}
                      </span>
                    </div>
                    <span
                      className={`chat-settings-notif-badge ${notifSubscribed ? 'on' : ''}`}
                      title={notifSubscribed ? 'Уведомления включены' : 'Уведомления выключены'}
                    >
                      {notifSubscribed ? <Bell size={16} /> : <BellOff size={16} />}
                    </span>
                  </div>
                );
              })
            )}
          </motion.div>
        </motion.div>
      </div>
    </div>
  );
};

export default ChatSettingsPage;
