// types/settings.ts

/**
 * Точная копия структуры SettingsData с платы.
 */
interface SettingsData {
  /** Режим экрана: 0-постоянный, 1-авто, 2-умный */
  displayMode: number;  // 0 | 1 | 2, ge=0, le=2
  
  /** Час включения дневного реле */
  dayOnHour: number;    // ge=0, le=23
  /** Минута включения дневного реле */
  dayOnMinute: number;  // ge=0, le=59
  /** Час выключения дневного реле */
  dayOffHour: number;   // ge=0, le=23
  /** Минута выключения дневного реле */
  dayOffMinute: number; // ge=0, le=59
  
  /** Час включения ночного реле */
  nightOnHour: number;   // ge=0, le=23
  /** Минута включения ночного реле */
  nightOnMinute: number; // ge=0, le=59
  /** Час выключения ночного реле */
  nightOffHour: number;  // ge=0, le=23
  /** Минута выключения ночного реле */
  nightOffMinute: number;// ge=0, le=59
  
  /** Час включения уборной */
  toiletOnHour: number;   // ge=0, le=23
  /** Минута включения уборной */
  toiletOnMinute: number; // ge=0, le=59
  /** Час выключения уборной */
  toiletOffHour: number;  // ge=0, le=23
  /** Минута выключения уборной */
  toiletOffMinute: number;// ge=0, le=59
  
  /** Режим реле: False=авто, True=ручной */
  relayMode: boolean;
  
  /** Ручное состояние дневного реле (только если relayMode=true) */
  manualDayState: boolean;
  /** Ручное состояние ночного реле (только если relayMode=true) */
  manualNightState: boolean;
  
  /** Таймаут дисплея в секундах */
  displayTimeout: number;           // ge=0, le=255
  /** Таймаут смены режимов в секундах */
  displayChangeModeTimeout: number; // ge=0, le=255
  
  /** Задержка вентилятора в секундах */
  fanDelay: number;     // ge=0, le=255
  /** Длительность работы вентилятора в минутах */
  fanDuration: number;  // ge=0, le=255
  
  /** Оффлайн режим */
  offlineModeActive: boolean;
  
  /** Отображение прогноза погоды */
  showForecastScreen: boolean;
  
  /** Отображение данных с датчиков */
  showTempScreen: boolean;
  
  /** Режим тишины */
  silentMode: boolean;
  
  /** Длительность принудительной работы вентилятора в минутах */
  forcedVentilationTimeout: number; // ge=0, le=255
}