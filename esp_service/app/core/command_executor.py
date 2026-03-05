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

    async def get_current_telemetry(self) -> str:
        data = self.worker.get_current_telemetry()
        if data is None:
            return "Не удалось получить данные телеметрии."
        return data.to_str()
    
    async def get_ai_daily_report(self) -> str:
        data = await self.worker.get_daily_report()
        if data is None:
            return "Не удалось получить данные анализа за вчера."
        return data
    
    async def get_ai_weekly_report(self) -> str:
        data = await self.worker.get_weekly_report()
        if data is None:
            return "Не удалось получить данные анализа за неделю."
        return data

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
            logger.info(f"Настройки обновлены: {updates}")
        else:
            logger.error(f"Ошибка обновления настроек: {updates}")
        
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
                h, m = self._parse_time(command["params"]["time"])
                await self._save_settings({"dayOnHour": h, "dayOnMinute": m})
                return f"Дневной свет будет включаться в {command['params']['time']}"
            
            elif cmd == "set_day_off":
                h, m = self._parse_time(command["params"]["time"])
                await self._save_settings({"dayOffHour": h, "dayOffMinute": m})
                return f"Дневной свет будет выключаться в {command['params']['time']}"
            
            elif cmd == "set_night_on":
                h, m = self._parse_time(command["params"]["time"])
                await self._save_settings({"nightOnHour": h, "nightOnMinute": m})
                return f"Ночной свет будет включаться в {command['params']['time']}"
            
            elif cmd == "set_night_off":
                h, m = self._parse_time(command["params"]["time"])
                await self._save_settings({"nightOffHour": h, "nightOffMinute": m})
                return f"Ночной свет будет выключаться в {command['params']['time']}"
            
            elif cmd == "set_toilet_on":
                h, m = self._parse_time(command["params"]["time"])
                await self._save_settings({"toiletOnHour": h, "toiletOnMinute": m})
                return f"Свет в уборной будет включаться в {command['params']['time']}"
            
            elif cmd == "set_toilet_off":
                h, m = self._parse_time(command["params"]["time"])
                await self._save_settings({"toiletOffHour": h, "toiletOffMinute": m})
                return f"Свет в уборной будет выключаться в {command['params']['time']}"
            
            # Режимы реле
            elif cmd == "set_relay_auto":
                await self._save_settings({"relayMode": False})
                return "Реле переведены в автоматический режим"
            
            elif cmd == "set_relay_manual":
                await self._save_settings({"relayMode": True})
                return "Реле переведены в ручной режим"
            
            # Ручное управление
            elif cmd == "set_manual_day_on":
                await self._save_settings({"manualDayState": True, "relayMode": True})
                return "Дневной свет включен вручную"
            
            elif cmd == "set_manual_day_off":
                await self._save_settings({"manualDayState": False, "relayMode": True})
                return "Дневной свет выключен"
            
            elif cmd == "set_manual_night_on":
                await self._save_settings({"manualNightState": True, "relayMode": True})
                return "Ночной свет включен вручную"
            
            elif cmd == "set_manual_night_off":
                await self._save_settings({"manualNightState": False, "relayMode": True})
                return "Ночной свет выключен"
            
            # Вентилятор
            elif cmd == "set_silent_mode_on":
                await self._save_settings({"silentMode": True})
                return "Режим тишины активирован"
            
            elif cmd == "start_fan":
                minutes = int(command["params"]["minutes"])
                await self._save_settings({"forcedVentilationTimeout": minutes})
                return f"Вентилятор включен на {minutes} минут"
            
            elif cmd == "get_current_data":
                return await self.get_current_telemetry()
            
            elif cmd == "get_ai_yesterday":
                return await self.get_ai_daily_report()
            
            elif cmd == "get_ai_weekly":
                return await self.get_ai_weekly_report()
            
            else:
                return f"Неизвестная команда: {cmd}"
        
        except Exception as e:
            logger.exception(f"Ошибка выполнения команды: {e}")
            return f"Что-то пошло не так: {str(e)}"