// types/settings.ts
interface SettingsData {
  displayMode: 0 | 1 | 2;  // 0-постоянный, 1-авто, 2-умный
  dayOnHour: number;
  dayOnMinute: number;
  dayOffHour: number;
  dayOffMinute: number;
  nightOnHour: number;
  nightOnMinute: number;
  nightOffHour: number;
  nightOffMinute: number;
  toiletOnHour: number;
  toiletOnMinute: number;
  toiletOffHour: number;
  toiletOffMinute: number;
  relayMode: boolean;
  manualDayState: boolean;
  manualNightState: boolean;
  displayTimeout: number;
  displayChangeModeTimeout: number;
  fanDelay: number;
  fanDuration: number;
  offlineModeActive: boolean;
  showForecastScreen: boolean;
  showTempScreen: boolean;
}