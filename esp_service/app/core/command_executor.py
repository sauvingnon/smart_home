# app/services/command_executor.py
from typing import Dict, Any, Optional
from app.schemas.settings import SettingsData
from app.core.worker import WeatherBackgroundWorker
import logging

logger = logging.getLogger(__name__)

class CommandExecutor:
    def __init__(self, worker: WeatherBackgroundWorker):
        self.worker = worker
        self.current_settings: Optional[SettingsData] = None
    
    async def _get_settings(self) -> SettingsData:
        """Получить текущие настройки"""
        if not self.current_settings:
            self.current_settings = await self.worker.get_current_config()
        return self.current_settings
    
    async def _save_settings(self, updates: Dict[str, Any]) -> bool:
        """Сохранить обновленные настройки"""
        settings = await self._get_settings()
        
        # Обновляем только указанные поля
        updated = settings.model_copy(update=updates)
        
        # Отправляем на ESP
        success = await self.worker.send_to_board_settings(updated)
        
        if success:
            self.current_settings = updated
            logger.info(f"✅ Настройки обновлены: {updates}")
        else:
            logger.error(f"❌ Ошибка обновления настроек: {updates}")
        
        return success
    
    def _parse_time(self, time_str: str) -> tuple[int, int]:
        """Парсит время вида '07:30' в (час, минута)"""
        parts = time_str.split(':')
        return int(parts[0]), int(parts[1])
    
    async def execute(self, command: Dict[str, Any]) -> str:
        """Выполняет команду и возвращает ответ для пользователя"""
        cmd = command.get("command")
        
        try:
            # Расписание
            if cmd == "set_day_on":
                h, m = self._parse_time(command["time"])
                await self._save_settings({"dayOnHour": h, "dayOnMinute": m})
                return f"✅ Дневной свет будет включаться в {command['time']}"
            
            elif cmd == "set_day_off":
                h, m = self._parse_time(command["time"])
                await self._save_settings({"dayOffHour": h, "dayOffMinute": m})
                return f"✅ Дневной свет будет выключаться в {command['time']}"
            
            elif cmd == "set_night_on":
                h, m = self._parse_time(command["time"])
                await self._save_settings({"nightOnHour": h, "nightOnMinute": m})
                return f"✅ Ночной свет будет включаться в {command['time']}"
            
            elif cmd == "set_night_off":
                h, m = self._parse_time(command["time"])
                await self._save_settings({"nightOffHour": h, "nightOffMinute": m})
                return f"✅ Ночной свет будет выключаться в {command['time']}"
            
            elif cmd == "set_toilet_on":
                h, m = self._parse_time(command["time"])
                await self._save_settings({"toiletOnHour": h, "toiletOnMinute": m})
                return f"✅ Свет в уборной будет включаться в {command['time']}"
            
            elif cmd == "set_toilet_off":
                h, m = self._parse_time(command["time"])
                await self._save_settings({"toiletOffHour": h, "toiletOffMinute": m})
                return f"✅ Свет в уборной будет выключаться в {command['time']}"
            
            # Режимы реле
            elif cmd == "set_relay_auto":
                await self._save_settings({"relayMode": False})
                return "✅ Реле переведены в автоматический режим"
            
            elif cmd == "set_relay_manual":
                await self._save_settings({"relayMode": True})
                return "✅ Реле переведены в ручной режим"
            
            # Ручное управление
            elif cmd == "set_manual_day_on":
                await self._save_settings({"manualDayState": True, "relayMode": True})
                return "✅ Дневной свет включен вручную"
            
            elif cmd == "set_manual_day_off":
                await self._save_settings({"manualDayState": False})
                return "✅ Дневной свет выключен"
            
            elif cmd == "set_manual_night_on":
                await self._save_settings({"manualNightState": True, "relayMode": True})
                return "✅ Ночной свет включен вручную"
            
            elif cmd == "set_manual_night_off":
                await self._save_settings({"manualNightState": False})
                return "✅ Ночной свет выключен"
            
            # Экран
            elif cmd == "set_display_constant":
                await self._save_settings({"displayMode": 0})
                return "✅ Установлен постоянный режим экрана"
            
            elif cmd == "set_display_auto":
                await self._save_settings({"displayMode": 1})
                return "✅ Установлен автоматический режим экрана"
            
            elif cmd == "set_display_smart":
                await self._save_settings({"displayMode": 2})
                return "✅ Установлен умный режим экрана"
            
            elif cmd == "set_display_timeout":
                await self._save_settings({"displayTimeout": command["value"]})
                return f"✅ Таймаут экрана установлен на {command['value']} секунд"
            
            elif cmd == "set_display_change_timeout":
                await self._save_settings({"displayChangeModeTimeout": command["value"]})
                return f"✅ Таймаут смены режимов установлен на {command['value']} секунд"
            
            elif cmd == "toggle_show_temp":
                settings = await self._get_settings()
                await self._save_settings({"showTempScreen": not settings.showTempScreen})
                return "✅ Экран датчиков " + ("включен" if not settings.showTempScreen else "выключен")
            
            elif cmd == "toggle_show_forecast":
                settings = await self._get_settings()
                await self._save_settings({"showForecastScreen": not settings.showForecastScreen})
                return "✅ Экран прогноза " + ("включен" if not settings.showForecastScreen else "выключен")
            
            # Вентилятор
            elif cmd == "set_silent_mode_on":
                await self._save_settings({"silentMode": True})
                return "✅ Режим тишины активирован"
            
            elif cmd == "set_silent_mode_off":
                await self._save_settings({"silentMode": False})
                return "✅ Режим тишины отключен"
            
            elif cmd == "start_fan":
                minutes = command.get("minutes", 5)
                await self._save_settings({"forcedVentilationTimeout": minutes})
                return f"✅ Вентилятор включен на {minutes} минут"
            
            elif cmd == "set_fan_delay":
                await self._save_settings({"fanDelay": command["value"]})
                return f"✅ Задержка вентилятора установлена на {command['value']} секунд"
            
            elif cmd == "set_fan_duration":
                await self._save_settings({"fanDuration": command["value"]})
                return f"✅ Длительность работы вентилятора установлена на {command['value']} минут"
            
            else:
                return f"❌ Неизвестная команда: {cmd}"
        
        except Exception as e:
            logger.exception(f"Ошибка выполнения команды: {e}")
            return f"❌ Ошибка: {str(e)}"