import json
from typing import Optional, Dict, Any
from logger import logger
from app.services.ai_api.deepseek_client import ai_message_request
import asyncio

class LLMCommandParser:
    def __init__(self, model: str = "gpt-4o-mini"):
        self.model = model
        self.system_prompt = self._build_system_prompt()
        self.timeout = 3.0  # 3 секунды максимум
        
    def _build_system_prompt(self) -> str:
        """Собираем системный промпт"""
        return """Ты - парсер команд для умного дома. 
Твоя задача: из текста пользователя определить одну из 24 команд и извлечь параметры.

ПРАВИЛА:
1. Команда должна быть ТОЛЬКО из списка ниже
2. Если параметр не указан - не выдумывай
3. Если время - верни в формате HH:MM
4. Если число - верни как integer
5. Confidence ставь честно:
   1.0 - идеальное совпадение
   0.9 - все ключевые слова есть
   0.8 - основная суть понятна
   <0.7 - сомневаешься

СПИСОК КОМАНД:
РАСПИСАНИЕ (требуют время):
1. set_day_on - включить дневной датчик по расписанию - параметр: time
2. set_day_off - выключить дневной датчик по расписанию - параметр: time
3. set_night_on - включить ночной датчик по расписанию - параметр: time
4. set_night_off - выключить ночной датчик по расписанию - параметр: time
5. set_toilet_on - включить датчик в туалете по расписанию - параметр: time
6. set_toilet_off - выключить датчик в туалете по расписанию - параметр: time

РЕЖИМЫ РЕЛЕ (без параметров):
7. set_relay_auto - автоматический режим реле
8. set_relay_manual - ручной режим реле

РУЧНОЕ УПРАВЛЕНИЕ (без параметров):
9. set_manual_day_on - ручное включение дневного датчика
10. set_manual_day_off - ручное выключение дневного датчика
11. set_manual_night_on - ручное включение ночного датчика
12. set_manual_night_off - ручное выключение ночного датчика

ЭКРАН:
13. set_display_constant - постоянный режим экрана (без параметров)
14. set_display_auto - автоматический режим экрана (без параметров)
15. set_display_smart - умный режим экрана (без параметров)
16. set_display_timeout - таймаут экрана - параметр: seconds
17. set_display_change_timeout - таймаут смены режимов - параметр: seconds
18. toggle_show_temp - показать/скрыть датчики (без параметров)
19. toggle_show_forecast - показать/скрыть прогноз (без параметров)

ВЕНТИЛЯТОР:
20. set_silent_mode_on - включить тихий режим (без параметров)
21. set_silent_mode_off - выключить тихий режим (без параметров)
22. start_fan - включить вентилятор на N минут - параметр: minutes
23. set_fan_delay - задержка перед включением - параметр: seconds
24. set_fan_duration - длительность работы - параметр: minutes

ПРИМЕРЫ:
Пользователь: включи дневной свет в 7 утра
Ответ: {"command": "set_day_on", "confidence": 0.95, "params": {"time": "07:00"}}

Пользователь: выключи ночной в 23:30
Ответ: {"command": "set_night_off", "confidence": 0.98, "params": {"time": "23:30"}}

Пользователь: поставь автоматический режим
Ответ: {"command": "set_relay_auto", "confidence": 1.0, "params": {}}

Пользователь: в туалете чтобы в 22:00 выключалось
Ответ: {"command": "set_toilet_off", "confidence": 0.92, "params": {"time": "22:00"}}

Пользователь: вручную включи дневной
Ответ: {"command": "set_manual_day_on", "confidence": 0.99, "params": {}}

Пользователь: таймаут экрана 30 секунд
Ответ: {"command": "set_display_timeout", "confidence": 0.97, "params": {"seconds": 30}}

Пользователь: включи вентилятор на 15 минут
Ответ: {"command": "start_fan", "confidence": 1.0, "params": {"minutes": 15}}

ВАЖНО: Верни ТОЛЬКО JSON. Никаких пояснений, никакого текста до или после.
Твой ответ должен начинаться с { и заканчиваться }."""

    async def parse(self, text: str) -> Optional[Dict[str, Any]]:
        """Отправляем текст в LLM и получаем команду"""
        try:
            logger.info(f"Запрос в LLM:\n {text}")
            response = await ai_message_request(user_message=text, system_message=self.system_prompt)
            logger.info(f"Ответ LLM:\n {response}")
            
            return self._parse_response(response)
            
        except asyncio.TimeoutError:
            logger.error(f"LLM timeout after {self.timeout}s for text: {text}")
            return None
        except Exception as e:
            logger.error(f"LLM error: {e}")
            return None
    
    def _parse_response(self, response: str) -> Optional[Dict[str, Any]]:
        """Парсим JSON из ответа LLM"""
        try:
            # Ищем JSON в ответе
            import re
            json_match = re.search(r'\{.*\}', response, re.DOTALL)
            if not json_match:
                logger.error(f"No JSON found in response: {response}")
                return None
            
            data = json.loads(json_match.group())
            
            # Базовая валидация
            if not isinstance(data, dict):
                logger.error(f"Response is not a dict: {data}")
                return None
            
            if "command" not in data:
                logger.error(f"No command field in response: {data}")
                return None
            
            if "confidence" not in data:
                data["confidence"] = 0.8  # дефолт если нет
            
            if "params" not in data:
                data["params"] = {}
            
            return data
            
        except json.JSONDecodeError as e:
            logger.error(f"JSON decode error: {e}, response: {response}")
            return None