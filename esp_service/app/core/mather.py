# Гибридная обработка команд

import re
from typing import Dict, Any, Tuple, Optional

class CommandMatcher:
    def __init__(self):
        # Команды и их ключевые слова (в нижнем регистре)
        self.commands = {
            # Расписание
            "set_day_on": {
                "keywords": ["дневной датчик", "дневной свет", "дневное", "день"],
                "action": "включи", "time": True
            },
            "set_day_off": {
                "keywords": ["дневной датчик", "дневной свет", "дневное", "день"],
                "action": "выключи", "time": True
            },
            "set_night_on": {
                "keywords": ["ночной датчик", "ночной свет", "ночное", "ночь"],
                "action": "включи", "time": True
            },
            "set_night_off": {
                "keywords": ["ночной датчик", "ночной свет", "ночное", "ночь"],
                "action": "выключи", "time": True
            },
            "set_toilet_on": {
                "keywords": ["уборная", "туалет", "сортир"],
                "action": "включи", "time": True
            },
            "set_toilet_off": {
                "keywords": ["уборная", "туалет", "сортир"],
                "action": "выключи", "time": True
            },
            
            # Режимы реле
            "set_relay_auto": {
                "keywords": ["автоматический режим", "авто"],
                "action": None
            },
            "set_relay_manual": {
                "keywords": ["ручной режим", "ручное управление"],
                "action": None
            },
            
            # Ручное управление
            "set_manual_day_on": {
                "keywords": ["дневной датчик", "дневной свет", "день"],
                "action": "включи", "manual": True
            },
            "set_manual_day_off": {
                "keywords": ["дневной датчик", "дневной свет", "день"],
                "action": "выключи", "manual": True
            },
            "set_manual_night_on": {
                "keywords": ["ночной датчик", "ночной свет", "ночь"],
                "action": "включи", "manual": True
            },
            "set_manual_night_off": {
                "keywords": ["ночной датчик", "ночной свет", "ночь"],
                "action": "выключи", "manual": True
            },
            
            # Экран
            "set_display_constant": {
                "keywords": ["постоянный режим", "постоянно"],
                "action": None
            },
            "set_display_auto": {
                "keywords": ["автоматический режим экрана", "авто"],
                "action": None
            },
            "set_display_smart": {
                "keywords": ["умный режим", "умный"],
                "action": None
            },
            "set_display_timeout": {
                "keywords": ["таймаут экрана", "время работы экрана"],
                "numeric": True, "unit": "секунд"
            },
            "set_display_change_timeout": {
                "keywords": ["таймаут смены режимов", "длительность режима"],
                "numeric": True, "unit": "секунд"
            },
            "toggle_show_temp": {
                "keywords": ["показывать датчики", "экран датчиков"],
                "action": None
            },
            "toggle_show_forecast": {
                "keywords": ["показывать прогноз", "экран прогноза"],
                "action": None
            },
            
            # Вентилятор
            "set_silent_mode_on": {
                "keywords": ["режим тишины", "тихий режим"],
                "action": "включи"
            },
            "set_silent_mode_off": {
                "keywords": ["режим тишины", "тихий режим"],
                "action": "выключи"
            },
            "start_fan": {
                "keywords": ["включи вентилятор", "запусти вентиляцию"],
                "timer": True, "unit": "минут"
            },
            "set_fan_delay": {
                "keywords": ["задержка вентилятора", "перед включением"],
                "numeric": True, "unit": "секунд"
            },
            "set_fan_duration": {
                "keywords": ["длительность вентилятора", "время работы"],
                "numeric": True, "unit": "минут"
            }
        }
    
    def extract_time(self, text: str) -> Optional[str]:
        """Извлекает время из текста"""
        # Паттерны: 7:00, 7.00, 7 часов, 7 утра, 19 вечера
        patterns = [
            r'(\d{1,2})[.:](\d{2})',  # 7:00, 7.00
            r'(\d{1,2})\s*(?:часов|час|ч)',  # 7 часов
            r'(\d{1,2})\s*(?:утра|вечера)',  # 7 утра
        ]
        
        for pattern in patterns:
            match = re.search(pattern, text, re.IGNORECASE)
            if match:
                if len(match.groups()) == 2:
                    return f"{int(match.group(1)):02d}:{match.group(2)}"
                else:
                    hour = int(match.group(1))
                    return f"{hour:02d}:00"
        return None
    
    def extract_number(self, text: str, unit: str) -> Optional[int]:
        """Извлекает число с единицей измерения"""
        pattern = rf'(\d+)\s*{unit}'
        match = re.search(pattern, text, re.IGNORECASE)
        return int(match.group(1)) if match else None
    
    def match(self, text: str) -> Optional[Dict[str, Any]]:
        """Основной метод матчинга"""
        text_lower = text.lower().strip()
        
        # Определяем общее действие (включи/выключи)
        action = None
        if any(word in text_lower for word in ["включи", "включить", "активируй", "зажги"]):
            action = "on"
        elif any(word in text_lower for word in ["выключи", "выключить", "отключи", "погаси"]):
            action = "off"
        
        # Определяем режим (ручной/авто)
        is_manual = "ручной" in text_lower or "ручное" in text_lower
        is_auto = "автоматический" in text_lower or "авто" in text_lower
        
        # Ищем по всем командам
        for cmd_name, cmd_config in self.commands.items():
            # Проверяем наличие ключевых слов
            if not any(kw in text_lower for kw in cmd_config["keywords"]):
                continue
            
            # Проверяем действие (если требуется)
            if cmd_config.get("action"):
                required_action = cmd_config["action"]
                if required_action == "включи" and action != "on":
                    continue
                if required_action == "выключи" and action != "off":
                    continue
            
            # Проверяем режим
            if cmd_config.get("manual") and not is_manual:
                continue
            
            # Извлекаем время (если нужно)
            time = None
            if cmd_config.get("time"):
                time = self.extract_time(text_lower)
                if not time:
                    continue
            
            # Извлекаем число (если нужно)
            number = None
            if cmd_config.get("numeric"):
                number = self.extract_number(text_lower, cmd_config["unit"])
                if not number:
                    continue
            
            # Извлекаем таймер (если нужно)
            timer = None
            if cmd_config.get("timer"):
                timer = self.extract_number(text_lower, cmd_config["unit"])
                if not timer:
                    continue
            
            # Формируем результат
            result = {"command": cmd_name}
            
            if time:
                result["time"] = time
            if number:
                result["value"] = number
            if timer:
                result["minutes"] = timer
            if is_manual:
                result["mode"] = "manual"
            if is_auto:
                result["mode"] = "auto"
            
            return result
        
        # Если ничего не нашли
        return None