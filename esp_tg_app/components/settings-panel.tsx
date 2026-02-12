'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { 
  Clock, 
  Fan, 
  Sun, 
  Moon, 
  Bath, 
  Monitor,
  Wifi,
  Thermometer,
  Cloud,
  Settings2  
} from 'lucide-react';

interface SettingsPanelProps {
  onClose?: () => void;
}

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState('schedule');

  // Загрузка настроек
  const fetchSettings = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/proxy/esp_service/settings');
      const data = await response.json();
      setSettings(data);
    } catch (error) {
      console.error('Ошибка загрузки настроек:', error);
    } finally {
      setLoading(false);
    }
  };

  // Сохранение настроек
  const saveSettings = async () => {
    if (!settings) return;
    
    try {
      setSaving(true);
      const response = await fetch('/api/proxy/esp_service/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });
            
      if (response.ok) {
        // Показать уведомление об успехе
      }
    } catch (error) {
      console.error('Ошибка сохранения:', error);
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    fetchSettings();
  }, []);

  const updateSetting = <K extends keyof SettingsData>(
    key: K,
    value: SettingsData[K]
  ) => {
    setSettings(prev => prev ? { ...prev, [key]: value } : null);
  };

  if (loading) {
    return (
      <Card className="border-0 shadow-lg">
        <CardContent className="p-8">
          <div className="flex justify-center">
            <div className="animate-spin w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!settings) return null;

  return (
    <Card className="border-0 shadow-lg">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-xl flex items-center gap-2">
          <Clock className="h-5 w-5 text-blue-500" />
          Настройки системы
        </CardTitle>
        <div className="flex gap-2">
          <Button 
            variant="outline" 
            size="sm"
            onClick={onClose}
          >
            Закрыть
          </Button>
          <Button 
            size="sm"
            onClick={saveSettings}
            disabled={saving}
            className="bg-gradient-to-r from-blue-600 to-blue-500"
          >
            {saving ? 'Сохранение...' : 'Сохранить'}
          </Button>
        </div>
      </CardHeader>
      
      <CardContent>
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="grid grid-cols-4 mb-6 bg-slate-200 dark:bg-slate-800 p-1">
            <TabsTrigger 
                value="schedule" 
                className="data-[state=active]:bg-white dark:data-[state=active]:bg-slate-950 data-[state=active]:text-blue-600 dark:data-[state=active]:text-blue-400 data-[state=active]:shadow-sm">
                Расписание
            </TabsTrigger>
            <TabsTrigger 
                value="relay"
                className="data-[state=active]:bg-white dark:data-[state=active]:bg-slate-950 data-[state=active]:text-blue-600 dark:data-[state=active]:text-blue-400 data-[state=active]:shadow-sm">
                Реле
            </TabsTrigger>
            <TabsTrigger 
                value="display"
                className="data-[state=active]:bg-white dark:data-[state=active]:bg-slate-950 data-[state=active]:text-blue-600 dark:data-[state=active]:text-blue-400 data-[state=active]:shadow-sm">
                Экран
            </TabsTrigger>
            <TabsTrigger 
                value="fan"
                className="data-[state=active]:bg-white dark:data-[state=active]:bg-slate-950 data-[state=active]:text-blue-600 dark:data-[state=active]:text-blue-400 data-[state=active]:shadow-sm">
                Вентилятор
            </TabsTrigger>
            </TabsList>

          {/* ВКЛАДКА: РАСПИСАНИЕ */}
          <TabsContent value="schedule" className="space-y-6">
            {/* Дневной свет */}
            <div className="space-y-3">
              <h3 className="font-medium flex items-center gap-2 text-amber-600">
                <Sun className="h-4 w-4" />
                Дневной свет
              </h3>
              <div className="grid grid-cols-2 gap-4 bg-slate-50 dark:bg-slate-900 p-4 rounded-xl">
                <div>
                  <label className="text-xs text-slate-500">Включение</label>
                  <div className="flex items-center gap-2 mt-1">
                    <input 
                      type="number" 
                      min={0} max={23}
                      value={settings.dayOnHour}
                      onChange={(e) => updateSetting('dayOnHour', parseInt(e.target.value))}
                      className="w-16 px-2 py-1 border rounded-lg"
                    />
                    <span>:</span>
                    <input 
                      type="number" 
                      min={0} max={59}
                      value={settings.dayOnMinute}
                      onChange={(e) => updateSetting('dayOnMinute', parseInt(e.target.value))}
                      className="w-16 px-2 py-1 border rounded-lg"
                    />
                  </div>
                </div>
                <div>
                  <label className="text-xs text-slate-500">Выключение</label>
                  <div className="flex items-center gap-2 mt-1">
                    <input 
                      type="number" 
                      min={0} max={23}
                      value={settings.dayOffHour}
                      onChange={(e) => updateSetting('dayOffHour', parseInt(e.target.value))}
                      className="w-16 px-2 py-1 border rounded-lg"
                    />
                    <span>:</span>
                    <input 
                      type="number" 
                      min={0} max={59}
                      value={settings.dayOffMinute}
                      onChange={(e) => updateSetting('dayOffMinute', parseInt(e.target.value))}
                      className="w-16 px-2 py-1 border rounded-lg"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Ночной свет */}
            <div className="space-y-3">
              <h3 className="font-medium flex items-center gap-2 text-indigo-600">
                <Moon className="h-4 w-4" />
                Ночной свет
              </h3>
              <div className="grid grid-cols-2 gap-4 bg-slate-50 dark:bg-slate-900 p-4 rounded-xl">
                <div>
                  <label className="text-xs text-slate-500">Включение</label>
                  <div className="flex items-center gap-2 mt-1">
                    <input 
                      type="number" 
                      min={0} max={23}
                      value={settings.nightOnHour}
                      onChange={(e) => updateSetting('nightOnHour', parseInt(e.target.value))}
                      className="w-16 px-2 py-1 border rounded-lg"
                    />
                    <span>:</span>
                    <input 
                      type="number" 
                      min={0} max={59}
                      value={settings.nightOnMinute}
                      onChange={(e) => updateSetting('nightOnMinute', parseInt(e.target.value))}
                      className="w-16 px-2 py-1 border rounded-lg"
                    />
                  </div>
                </div>
                <div>
                  <label className="text-xs text-slate-500">Выключение</label>
                  <div className="flex items-center gap-2 mt-1">
                    <input 
                      type="number" 
                      min={0} max={23}
                      value={settings.nightOffHour}
                      onChange={(e) => updateSetting('nightOffHour', parseInt(e.target.value))}
                      className="w-16 px-2 py-1 border rounded-lg"
                    />
                    <span>:</span>
                    <input 
                      type="number" 
                      min={0} max={59}
                      value={settings.nightOffMinute}
                      onChange={(e) => updateSetting('nightOffMinute', parseInt(e.target.value))}
                      className="w-16 px-2 py-1 border rounded-lg"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Уборная */}
            <div className="space-y-3">
              <h3 className="font-medium flex items-center gap-2 text-emerald-600">
                <Bath className="h-4 w-4" />
                Уборная
              </h3>
              <div className="grid grid-cols-2 gap-4 bg-slate-50 dark:bg-slate-900 p-4 rounded-xl">
                <div>
                  <label className="text-xs text-slate-500">Включение</label>
                  <div className="flex items-center gap-2 mt-1">
                    <input 
                      type="number" 
                      min={0} max={23}
                      value={settings.toiletOnHour}
                      onChange={(e) => updateSetting('toiletOnHour', parseInt(e.target.value))}
                      className="w-16 px-2 py-1 border rounded-lg"
                    />
                    <span>:</span>
                    <input 
                      type="number" 
                      min={0} max={59}
                      value={settings.toiletOnMinute}
                      onChange={(e) => updateSetting('toiletOnMinute', parseInt(e.target.value))}
                      className="w-16 px-2 py-1 border rounded-lg"
                    />
                  </div>
                </div>
                <div>
                  <label className="text-xs text-slate-500">Выключение</label>
                  <div className="flex items-center gap-2 mt-1">
                    <input 
                      type="number" 
                      min={0} max={23}
                      value={settings.toiletOffHour}
                      onChange={(e) => updateSetting('toiletOffHour', parseInt(e.target.value))}
                      className="w-16 px-2 py-1 border rounded-lg"
                    />
                    <span>:</span>
                    <input 
                      type="number" 
                      min={0} max={59}
                      value={settings.toiletOffMinute}
                      onChange={(e) => updateSetting('toiletOffMinute', parseInt(e.target.value))}
                      className="w-16 px-2 py-1 border rounded-lg"
                    />
                  </div>
                </div>
              </div>
            </div>
          </TabsContent>

          {/* ВКЛАДКА: РЕЛЕ */}
            <TabsContent value="relay" className="space-y-6">
            
            {/* Режим управления — сегмент-контрол */}
            <div className="bg-slate-50 dark:bg-slate-900 p-4 rounded-xl space-y-4">
                <div className="flex items-center gap-2">
                <Settings2 className="h-4 w-4 text-slate-500" />
                <span className="text-sm font-medium">Режим управления</span>
                </div>
                
                <div className="grid grid-cols-2 gap-2 p-1 bg-slate-200 dark:bg-slate-800 rounded-lg">
                <button
                    onClick={() => updateSetting('relayMode', false)}
                    className={`
                    py-2 px-3 rounded-md text-sm font-medium transition-all
                    ${!settings.relayMode 
                        ? 'bg-white dark:bg-slate-950 shadow-sm text-blue-600 dark:text-blue-400' 
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                    }
                    `}
                >
                    ⚡ Автоматический
                </button>
                <button
                    onClick={() => updateSetting('relayMode', true)}
                    className={`
                    py-2 px-3 rounded-md text-sm font-medium transition-all
                    ${settings.relayMode 
                        ? 'bg-white dark:bg-slate-950 shadow-sm text-amber-600 dark:text-amber-400' 
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                    }
                    `}
                >
                    🖐️ Ручной
                </button>
                </div>

                <p className="text-xs text-slate-500">
                {!settings.relayMode 
                    ? 'Реле работают по расписанию, указанному во вкладке "Расписание"' 
                    : 'Расписание игнорируется. Управляйте реле вручную ниже'}
                </p>
            </div>

            {/* Ручное управление — показываем только в ручном режиме */}
            {settings.relayMode && (
                <div className="bg-slate-50 dark:bg-slate-900 p-4 rounded-xl space-y-4">
                <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">Ручное управление</span>
                </div>
                
                <div className="space-y-3">
                    <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-amber-100 dark:bg-amber-900/30 rounded-lg flex items-center justify-center">
                        <Sun className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                        </div>
                        <div>
                        <p className="font-medium">Дневной свет</p>
                        <p className="text-xs text-slate-500">Реле #2</p>
                        </div>
                    </div>
                    <Switch 
                        checked={settings.manualDayState}
                        onCheckedChange={(checked) => updateSetting('manualDayState', checked)}
                        className="data-[state=checked]:bg-amber-500"
                    />
                    </div>

                    <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-indigo-100 dark:bg-indigo-900/30 rounded-lg flex items-center justify-center">
                        <Moon className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
                        </div>
                        <div>
                        <p className="font-medium">Ночной свет</p>
                        <p className="text-xs text-slate-500">Реле #3</p>
                        </div>
                    </div>
                    <Switch 
                        checked={settings.manualNightState}
                        onCheckedChange={(checked) => updateSetting('manualNightState', checked)}
                        className="data-[state=checked]:bg-indigo-500"
                    />
                    </div>
                </div>
                </div>
            )}

            {/* Дополнительная информация */}
            <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg p-3">
                <p className="text-xs text-blue-700 dark:text-blue-400">
                <span className="font-medium">ℹ️ В автоматическом режиме</span> реле управляются по расписанию. 
                В ручном режиме вы можете включить/выключить их независимо.
                </p>
            </div>
            </TabsContent>

          {/* ВКЛАДКА: ЭКРАН */}
            <TabsContent value="display" className="space-y-6">
            <div className="bg-slate-50 dark:bg-slate-900 p-4 rounded-xl space-y-6">
                
                {/* Режим экрана — сегмент-контрол как в Реле */}
                <div className="space-y-3">
                <div className="flex items-center gap-2">
                    <Monitor className="h-4 w-4 text-blue-500" />
                    <span className="text-sm font-medium">Режим экрана</span>
                </div>
                
                <div className="grid grid-cols-3 gap-2 p-1 bg-slate-200 dark:bg-slate-800 rounded-lg">
                    <button
                    onClick={() => updateSetting('displayMode', 0)}
                    className={`
                        py-2 px-3 rounded-md text-sm font-medium transition-all
                        ${settings.displayMode === 0 
                        ? 'bg-white dark:bg-slate-950 shadow-sm text-blue-600 dark:text-blue-400' 
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                        }
                    `}
                    >
                    Постоянный
                    </button>
                    <button
                    onClick={() => updateSetting('displayMode', 1)}
                    className={`
                        py-2 px-3 rounded-md text-sm font-medium transition-all
                        ${settings.displayMode === 1 
                        ? 'bg-white dark:bg-slate-950 shadow-sm text-blue-600 dark:text-blue-400' 
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                        }
                    `}
                    >
                    Авто
                    </button>
                    <button
                    onClick={() => updateSetting('displayMode', 2)}
                    className={`
                        py-2 px-3 rounded-md text-sm font-medium transition-all
                        ${settings.displayMode === 2 
                        ? 'bg-white dark:bg-slate-950 shadow-sm text-blue-600 dark:text-blue-400' 
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                        }
                    `}
                    >
                    Умный
                    </button>
                </div>
                
                <p className="text-xs text-slate-500">
                    {settings.displayMode === 0 && 'Экран всегда включен'}
                    {settings.displayMode === 1 && 'Экран гаснет через таймаут'}
                    {settings.displayMode === 2 && 'Умное управление яркостью'}
                </p>
                </div>

                {/* Таймаут экрана — плюс/минус */}
                <div className="space-y-2">
                <div className="flex justify-between items-center">
                    <span className="text-sm">Таймаут экрана</span>
                    <div className="flex items-center gap-2">
                    <button
                        onClick={() => updateSetting('displayTimeout', Math.max(0, settings.displayTimeout - 5))}
                        className="w-8 h-8 rounded-lg bg-slate-200 dark:bg-slate-800 flex items-center justify-center text-lg font-medium hover:bg-slate-300 dark:hover:bg-slate-700 transition-colors"
                    >
                        −
                    </button>
                    <span className="w-16 text-center font-medium bg-slate-200 dark:bg-slate-800 px-2 py-1.5 rounded-lg">
                        {settings.displayTimeout}с
                    </span>
                    <button
                        onClick={() => updateSetting('displayTimeout', Math.min(255, settings.displayTimeout + 5))}
                        className="w-8 h-8 rounded-lg bg-slate-200 dark:bg-slate-800 flex items-center justify-center text-lg font-medium hover:bg-slate-300 dark:hover:bg-slate-700 transition-colors"
                    >
                        +
                    </button>
                    </div>
                </div>
                </div>

                {/* Смена режимов — плюс/минус */}
                <div className="space-y-2">
                <div className="flex justify-between items-center">
                    <span className="text-sm">Смена режимов</span>
                    <div className="flex items-center gap-2">
                    <button
                        onClick={() => updateSetting('displayChangeModeTimeout', Math.max(0, settings.displayChangeModeTimeout - 5))}
                        className="w-8 h-8 rounded-lg bg-slate-200 dark:bg-slate-800 flex items-center justify-center text-lg font-medium hover:bg-slate-300 dark:hover:bg-slate-700 transition-colors"
                    >
                        −
                    </button>
                    <span className="w-16 text-center font-medium bg-slate-200 dark:bg-slate-800 px-2 py-1.5 rounded-lg">
                        {settings.displayChangeModeTimeout}с
                    </span>
                    <button
                        onClick={() => updateSetting('displayChangeModeTimeout', Math.min(255, settings.displayChangeModeTimeout + 5))}
                        className="w-8 h-8 rounded-lg bg-slate-200 dark:bg-slate-800 flex items-center justify-center text-lg font-medium hover:bg-slate-300 dark:hover:bg-slate-700 transition-colors"
                    >
                        +
                    </button>
                    </div>
                </div>
                </div>

                {/* Разделитель */}
                <div className="border-t border-slate-200 dark:border-slate-700 my-2"></div>

                {/* Отображение экранов */}
                <div className="space-y-4">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                    <Thermometer className="h-4 w-4 text-slate-500" />
                    <span className="text-sm">Показывать датчики</span>
                    </div>
                    <Switch 
                    checked={settings.showTempScreen}
                    onCheckedChange={(checked) => updateSetting('showTempScreen', checked)}
                    className="data-[state=checked]:bg-blue-500"
                    />
                </div>

                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                    <Cloud className="h-4 w-4 text-slate-500" />
                    <span className="text-sm">Показывать прогноз</span>
                    </div>
                    <Switch 
                    checked={settings.showForecastScreen}
                    onCheckedChange={(checked) => updateSetting('showForecastScreen', checked)}
                    className="data-[state=checked]:bg-blue-500"
                    />
                </div>
                </div>
            </div>
            </TabsContent>

          {/* ВКЛАДКА: ВЕНТИЛЯТОР */}
            <TabsContent value="fan" className="space-y-6">
            <div className="bg-slate-50 dark:bg-slate-900 p-4 rounded-xl space-y-6">
                
                {/* Заголовок */}
                <div className="flex items-center gap-2">
                <Fan className="h-5 w-5 text-blue-500" />
                <h3 className="font-medium">Настройки вентиляции</h3>
                </div>

                {/* Задержка перед включением — макс 255 */}
                <div className="space-y-2">
                <div className="flex justify-between items-center">
                    <span className="text-sm">Задержка перед включением</span>
                    <div className="flex items-center gap-2">
                    <button
                        onClick={() => updateSetting('fanDelay', Math.max(0, settings.fanDelay - 5))}
                        className="w-8 h-8 rounded-lg bg-slate-200 dark:bg-slate-800 flex items-center justify-center text-lg font-medium hover:bg-slate-300 dark:hover:bg-slate-700 transition-colors"
                    >
                        −
                    </button>
                    <span className="w-20 text-center font-medium bg-slate-200 dark:bg-slate-800 px-2 py-1.5 rounded-lg">
                        {settings.fanDelay} сек
                    </span>
                    <button
                        onClick={() => updateSetting('fanDelay', Math.min(255, settings.fanDelay + 5))}
                        className="w-8 h-8 rounded-lg bg-slate-200 dark:bg-slate-800 flex items-center justify-center text-lg font-medium hover:bg-slate-300 dark:hover:bg-slate-700 transition-colors"
                    >
                        +
                    </button>
                    </div>
                </div>
                </div>

                {/* Длительность работы — макс 30 */}
                <div className="space-y-2">
                <div className="flex justify-between items-center">
                    <span className="text-sm">Длительность работы</span>
                    <div className="flex items-center gap-2">
                    <button
                        onClick={() => updateSetting('fanDuration', Math.max(1, settings.fanDuration - 1))}
                        className="w-8 h-8 rounded-lg bg-slate-200 dark:bg-slate-800 flex items-center justify-center text-lg font-medium hover:bg-slate-300 dark:hover:bg-slate-700 transition-colors"
                    >
                        −
                    </button>
                    <span className="w-20 text-center font-medium bg-slate-200 dark:bg-slate-800 px-2 py-1.5 rounded-lg">
                        {settings.fanDuration} мин
                    </span>
                    <button
                        onClick={() => updateSetting('fanDuration', Math.min(30, settings.fanDuration + 1))}
                        className="w-8 h-8 rounded-lg bg-slate-200 dark:bg-slate-800 flex items-center justify-center text-lg font-medium hover:bg-slate-300 dark:hover:bg-slate-700 transition-colors"
                    >
                        +
                    </button>
                    </div>
                </div>
                </div>
            </div>
            </TabsContent>

        </Tabs>
      </CardContent>
    </Card>
  );
}