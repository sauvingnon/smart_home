'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Thermometer, Droplets, Wind, Fan, Lightbulb, Gauge, Clock, AlertCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { SettingsPanel } from '@/components/settings-panel';
import { useTelegram } from '@/hooks/useTelegram';

export default function Dashboard() {
  const { tg } = useTelegram();
  const [showSettings, setShowSettings] = useState(false);
  const [data, setData] = useState<ESPData | null>(null);
  const [loading, setLoading] = useState(true);
  const [relayState, setRelayState] = useState({ fan: false, light: false });
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [isStale, setIsStale] = useState(false);

  // Функция проверки свежести (Ижевск = UTC+4)
  const isDataFresh = (timestamp: string): boolean => {
    const dataTime = new Date(timestamp);
    const now = new Date();
    const diffMinutes = (now.getTime() - dataTime.getTime()) / (1000 * 60);
    return diffMinutes <= 2;
  };

  // Загрузка данных с esp_service
  const fetchData = async () => {
    try {
      setLoading(true);
      const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8005';
      const response = await fetch(`${API_URL}/esp_service/telemetry`);
      const result = await response.json();
      
      setData(result);
      setLastUpdate(new Date());
      setIsStale(!isDataFresh(result.timestamp));
    } catch (error) {
      console.error('Ошибка загрузки:', error);
      setIsStale(true);
    } finally {
      setLoading(false);
    }
  };

  // Первая загрузка и автообновление
  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);

    if (tg) {
      document.documentElement.style.setProperty('--background', tg.themeParams.bg_color);
      document.documentElement.style.setProperty('--foreground', tg.themeParams.text_color);
    }

    return () => clearInterval(interval);
  }, [tg]);

  // Обработчик главной кнопки
  useEffect(() => {
    if (tg) {
      tg.MainButton.setText('Закрыть');
      tg.MainButton.onClick(() => tg.close());
    }
  }, [tg]);

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('ru-RU', { 
      hour: '2-digit', 
      minute: '2-digit',
      second: '2-digit',
      timeZone: 'Europe/Samara'
    });
  };

  const formatUptime = (seconds: number) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}ч ${minutes}м`;
  };

  // Если открыты настройки — показываем их
  if (showSettings) {
    return <SettingsPanel onClose={() => setShowSettings(false)} />;
  }

  // Иначе показываем дашборд
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900 p-4">
      <div className="max-w-md mx-auto space-y-4">
        
        {/* Шапка с индикацией свежести */}
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold bg-gradient-to-r from-blue-600 to-blue-400 bg-clip-text text-transparent">
            {data?.device_id || 'ESP Control'}
          </h1>
          <motion.div 
            initial={{ scale: 0.9 }}
            animate={{ scale: 1 }}
            className={`flex items-center gap-2 px-3 py-1 rounded-full ${
              loading ? 'bg-yellow-100 dark:bg-yellow-900/30' :
              isStale ? 'bg-red-100 dark:bg-red-900/30' :
              'bg-green-100 dark:bg-green-900/30'
            }`}
          >
            <span className={`w-2 h-2 rounded-full animate-pulse ${
              loading ? 'bg-yellow-500' :
              isStale ? 'bg-red-500' :
              'bg-green-500'
            }`}></span>
            <span className={`text-sm ${
              loading ? 'text-yellow-700 dark:text-yellow-400' :
              isStale ? 'text-red-700 dark:text-red-400' :
              'text-green-700 dark:text-green-400'
            }`}>
              {loading ? 'Загрузка' : 
               isStale ? 'Данные устарели' : 
               'Онлайн'}
            </span>
          </motion.div>
        </div>

        {/* Индикация старых данных */}
        <AnimatePresence>
          {isStale && !loading && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg p-3 flex items-start gap-3"
            >
              <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
              <div className="text-sm text-amber-800 dark:text-amber-300">
                <p className="font-medium">Данные устарели</p>
                <p className="text-xs opacity-90">
                  Последнее обновление: {lastUpdate ? formatTime(lastUpdate) : 'никогда'}
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Карточка климата */}
        <Card className="border-0 shadow-xl bg-gradient-to-br from-blue-500 to-blue-600 text-white overflow-hidden relative">
          <div className="absolute top-0 right-0 w-32 h-32 bg-white/10 rounded-full -mt-8 -mr-8" />
          <CardContent className="p-6 relative">
            {loading && !data ? (
              <div className="py-8 text-center text-white/80">
                <div className="animate-spin w-8 h-8 border-4 border-white/30 border-t-white rounded-full mx-auto mb-2" />
                <p className="text-sm">Загрузка данных...</p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-6">
                  <div className="space-y-1">
                    <p className="text-blue-100 text-sm flex items-center gap-1">
                      <Thermometer className="h-3 w-3" />
                      Температура
                    </p>
                    <div className="flex items-baseline gap-1">
                      <span className="text-4xl font-bold">
                        {data?.temperature.toFixed(1) || '--'}
                      </span>
                      <span className="text-xl">°C</span>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <p className="text-blue-100 text-sm flex items-center gap-1">
                      <Droplets className="h-3 w-3" />
                      Влажность
                    </p>
                    <div className="flex items-baseline gap-1">
                      <span className="text-4xl font-bold">
                        {data?.humidity.toFixed(1) || '--'}
                      </span>
                      <span className="text-xl">%</span>
                    </div>
                  </div>
                </div>
                <div className="mt-4 pt-4 border-t border-blue-400/30 grid grid-cols-3 gap-2 text-sm">
                  <div className="flex items-center gap-1.5">
                    <Clock className="h-3.5 w-3.5 text-blue-200" />
                    <span className="text-blue-100">{data ? formatUptime(data.uptime) : '--ч --м'}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Gauge className="h-3.5 w-3.5 text-blue-200" />
                    <span className="text-blue-100">{data ? `${(data.free_memory / 1024).toFixed(0)}Кб` : '--'}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Wind className="h-3.5 w-3.5 text-blue-200" />
                    <span className="text-blue-100">{data?.bluetooth_is_active ? 'BT вкл' : 'BT выкл'}</span>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Управление реле */}
        <Card className="border-0 shadow-lg">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <div className="w-1 h-6 bg-blue-500 rounded-full"></div>
              Потенциальное место для погоды
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <motion.div 
              whileHover={{ scale: 1.02 }}
              className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-900 rounded-xl"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-blue-100 dark:bg-blue-900/30 rounded-lg flex items-center justify-center">
                  <Fan className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                </div>
                <div>
                  <p className="font-medium">Вентиляция</p>
                  <p className="text-xs text-slate-500">Реле #1</p>
                </div>
              </div>
              <Switch 
                checked={relayState.fan}
                onCheckedChange={(checked) => setRelayState(prev => ({ ...prev, fan: checked }))}
                disabled={isStale}
              />
            </motion.div>

            <motion.div 
              whileHover={{ scale: 1.02 }}
              className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-900 rounded-xl"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-amber-100 dark:bg-amber-900/30 rounded-lg flex items-center justify-center">
                  <Lightbulb className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                </div>
                <div>
                  <p className="font-medium">Основной свет</p>
                  <p className="text-xs text-slate-500">Реле #2</p>
                </div>
              </div>
              <Switch 
                checked={relayState.light}
                onCheckedChange={(checked) => setRelayState(prev => ({ ...prev, light: checked }))}
                disabled={isStale}
              />
            </motion.div>
          </CardContent>
        </Card>

        {/* Кнопка обновления */}
        <Button 
          className="w-full bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-700 hover:to-blue-600 text-white shadow-lg shadow-blue-500/25"
          onClick={fetchData}
          disabled={loading}
        >
          {loading ? 'Загрузка...' : 'Обновить данные'}
        </Button>

        {/* Кнопка настроек */}
        <Button 
          onClick={() => setShowSettings(true)}
          className="w-full bg-gradient-to-r from-slate-600 to-slate-500 hover:from-slate-700 hover:to-slate-600 text-white"
        >
          Настройки
        </Button>

        {/* Таймстамп */}
        {lastUpdate && (
          <p className={`text-center text-xs transition-colors ${
            isStale ? 'text-red-400' : 'text-slate-400'
          }`}>
            Последнее обновление: {formatTime(lastUpdate)}
            {data && ` • ${new Date(data.timestamp).toLocaleTimeString('ru-RU', { timeZone: 'Europe/Samara' })} с ESP`}
          </p>
        )}
      </div>
    </div>
  );
}