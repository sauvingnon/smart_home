# app/core/command_triagram_matcher.py
from collections import defaultdict
from typing import Dict, List, Tuple, Optional, Set
import re
from logger import logger

class CommandTriGramMatcher:
    def __init__(self):
        # Команды с их ключевыми словами и весами
        self.commands = {
            # ============= ТЕКУЩИЕ ДАННЫЕ (телеметрия) =============
            "get_current_data": {
                "keywords": {
                    # Основные
                    "сейчас": 15, "текущ": 15, "теперь": 10,
                    # Синонимы
                    "данные": 8, "показания": 8, "значения": 5,
                    "телеметрия": 15, "метрики": 8, "параметры": 5,
                    # Что именно
                    "температур": 10, "влажност": 10, "погода": 8,
                    "климат": 8, "микроклимат": 10,
                    # Действия
                    "покажи": 5, "расскажи": 3, "доложи": 3,
                    "что": 2, "как": 2,
                    # Разговорные
                    "что там": 5, "как дела": 3, "обстановка": 5,
                },
                "category": "telemetry"
            },
            # ============= ИИ АНАЛИТИКА ЗА ВЧЕРА =============
            "get_ai_yesterday": {
                "keywords": {
                    # Период - только вчера
                    "вчера": 30, "вчерашн": 30, "прошл": 15, "минувш": 15,
                    "сутки": 20, "день": 10, "24 часа": 15,
                    
                    # Типы анализа
                    "история": 15, "статистика": 15, "аналитика": 20,
                    "отчет": 15, "отчёт": 15, "сводка": 12, "итоги": 12,
                    "анализ": 15, "дайджест": 15,
                    
                    # Контекст ИИ
                    "ии": 20, "искусствен": 15, "интеллект": 10,
                    "умный": 5, "проанализируй": 15, "расскажи": 5,
                    
                    # Что анализируем
                    "погода": 8, "температура": 8, "влажность": 8,
                    "данные": 5, "показатели": 5,
                    
                    # Разговорные
                    "что было": 15, "как прошла": 10, "что интересного": 8,
                },
                "category": "insight_yesterday"
            },

            # ============= ИИ АНАЛИТИКА ЗА НЕДЕЛЮ =============
            "get_ai_weekly": {
                "keywords": {
                    # Период - только неделя
                    "недел": 30, "7 дней": 30, "семь дней": 30,
                    "прошл": 20, "минувш": 20, "предыдущ": 15,
                    
                    # Типы анализа
                    "история": 15, "статистика": 15, "аналитика": 20,
                    "отчет": 15, "отчёт": 15, "сводка": 12, "итоги": 12,
                    "анализ": 15, "динамика": 15, "тренды": 15, "дайджест": 15,
                    
                    # Контекст ИИ
                    "ии": 20, "искусствен": 15, "интеллект": 10,
                    "умный": 5, "проанализируй": 15, "расскажи": 5,
                    
                    # Что анализируем
                    "погода": 8, "температура": 8, "влажность": 8,
                    "данные": 5, "показатели": 5,
                    
                    # Разговорные
                    "что было": 8, "как прошла": 10, "обзор": 12,
                },
                "category": "insight_weekly"
            },
            # ============= РАСПИСАНИЕ (могут иметь время) =============
            "set_day_on": {
                "keywords": {
                    # Основные объекты
                    "дневн": 10, "день": 10, "свет": 10,
                    "датчик": 8, "реле": 8,
                    # Синонимы
                    "освещен": 8, "ламп": 5,
                    # Действия
                    "включи": 5, "активируй": 5, "зажги": 5, "замкни": 5,
                    "установи": 3, "поставь": 3,
                    # Ключевые слова для расписания (повышенный вес)
                    "расписан": 15, "врем": 15, "в": 5, "на": 5,
                    "пол": 8, "половин": 8,
                },
                "can_have_time": True,
                "category": "schedule"
            },
            
            "set_day_off": {
                "keywords": {
                    # Основные объекты
                    "дневн": 10, "день": 10, "свет": 10,
                    "датчик": 8, "реле": 8,
                    # Синонимы
                    "освещен": 8, "ламп": 5,
                    # Действия
                    "выключи": 5, "отключи": 5, "потуши": 5, "погаси": 5,
                    "убери": 3, "отбой": 3,
                    # Ключевые слова для расписания
                    "расписан": 15, "врем": 15, "в": 5,
                },
                "can_have_time": True,
                "category": "schedule"
            },
            
            "set_night_on": {
                "keywords": {
                    # Основные объекты
                    "ночн": 10, "ночь": 10, "свет": 10,
                    "датчик": 8, "реле": 8,
                    # Синонимы
                    "вечерн": 8, "темн": 5, "сумеречн": 5,
                    "подсветк": 5, "дежурн": 3,
                    # Действия
                    "включи": 5, "активируй": 5, "зажги": 5,
                    # Время
                    "расписан": 15, "врем": 15,
                },
                "can_have_time": True,
                "category": "schedule"
            },
            
            "set_night_off": {
                "keywords": {
                    # Основные объекты
                    "ночн": 10, "ночь": 10, "свет": 10,
                    "датчик": 8, "реле": 8,
                    # Действия
                    "выключи": 5, "отключи": 5, "потуши": 5, "погаси": 5,
                    # Время
                    "расписан": 15, "врем": 15,
                },
                "can_have_time": True,
                "category": "schedule"
            },
            
            "set_toilet_on": {
                "keywords": {
                    # Основные объекты
                    "туалет": 10, "уборн": 10, "сортир": 10,
                    "датчик": 8, "свет": 8, "реле": 5,
                    # Синонимы
                    "wc": 8, "т": 5, "с/у": 5,
                    "санузел": 8, "клозет": 5,
                    # Действия
                    "включи": 5, "активируй": 5, "зажги": 5,
                    # Время
                    "расписан": 15, "врем": 15,
                },
                "can_have_time": True,
                "category": "schedule"
            },
            
            "set_toilet_off": {
                "keywords": {
                    # Основные объекты
                    "туалет": 10, "уборн": 10, "сортир": 10,
                    "датчик": 8, "свет": 8, "реле": 5,
                    # Синонимы
                    "wc": 8, "санузел": 8,
                    # Действия
                    "выключи": 5, "отключи": 5, "потуши": 5, "погаси": 5,
                    # Время
                    "расписан": 15, "врем": 15,
                },
                "can_have_time": True,
                "category": "schedule"
            },
            
            # ============= РЕЖИМЫ РЕЛЕ =============
            "set_relay_auto": {
                "keywords": {
                    # Основные
                    "автоматическ": 10, "авто": 10,
                    # Синонимы
                    "автомат": 10, "сам": 5, "автоматика": 8,
                    "по умолчанию": 5, "как обычно": 3,
                    # Действия
                    "режим": 8, "работ": 5, "переключи": 3,
                    "поставь": 2,
                    # Разговорные
                    "на автомате": 8, "в автомат": 5,
                },
                "category": "mode"
            },
            
            "set_relay_manual": {
                "keywords": {
                    # Основные
                    "ручн": 10, "ручное": 10, "вручн": 10,
                    # Синонимы
                    "руками": 8, "сам": 8, "самостоятельн": 5,
                    "без автомат": 8, "не авто": 8, "отключи автомат": 5,
                    # Действия
                    "режим": 8, "управлени": 8, "переключи": 3,
                    "переведи": 5, "поставь": 3,
                    # Разговорные
                    "ручка": 3, "ручной режим": 10,
                    "в ручную": 8, "на ручном": 8,
                },
                "category": "mode"
            },
            
            # ============= РУЧНОЕ УПРАВЛЕНИЕ =============
            "set_manual_day_on": {
                "keywords": {
                    # Режим - высокий вес для ручного
                    "ручн": 20, "вручн": 20, "руками": 15,
                    "сейчас": 10, "быстро": 5, "немедленно": 5,
                    # Объекты
                    "дневн": 10, "день": 8, "свет": 8,
                    "датчик": 5, "реле": 5,
                    # Действия
                    "включи": 5, "активируй": 5, "зажги": 5, "замкни": 5,
                    "подай": 3, "дай": 2,
                },
                "category": "manual"
            },
            
            "set_manual_day_off": {
                "keywords": {
                    # Режим
                    "ручн": 20, "вручн": 20, "руками": 15,
                    "сейчас": 10, "быстро": 5,
                    # Объекты
                    "дневн": 10, "день": 8, "свет": 8,
                    "датчик": 5, "реле": 5,
                    # Действия
                    "выключи": 5, "отключи": 5, "потуши": 5, "погаси": 5,
                    "разомкни": 5, "убери": 2,
                },
                "category": "manual"
            },
            
            "set_manual_night_on": {
                "keywords": {
                    # Режим
                    "ручн": 20, "вручн": 20,
                    "сейчас": 10,
                    # Объекты
                    "ночн": 10, "ночь": 8, "свет": 8,
                    "датчик": 5, "реле": 5,
                    # Действия
                    "включи": 5, "активируй": 5, "зажги": 5,
                },
                "category": "manual"
            },
            
            "set_manual_night_off": {
                "keywords": {
                    # Режим
                    "ручн": 20, "вручн": 20,
                    "сейчас": 10,
                    # Объекты
                    "ночн": 10, "ночь": 8, "свет": 8,
                    "датчик": 5, "реле": 5,
                    # Действия
                    "выключи": 5, "отключи": 5, "потуши": 5, "погаси": 5,
                },
                "category": "manual"
            },
            
            # ============= ВЕНТИЛЯТОР =============
            "set_silent_mode_on": {
                "keywords": {
                    # Режим - УНИКАЛЬНЫЕ слова с высоким весом
                    "тих": 25,           # тихий, тихого
                    "тишины": 30,        # режим тишины
                    "бесшумн": 25,       # бесшумный
                    "не шуми": 25,       # не шуми
                    "тихо": 20,          # тихо
                    "шум": 5,            # шум, не шуметь (но с минусом)
                    # Объекты (пониженный вес)
                    "режим": 3,          # общее слово
                    "вентилятор": 2,     # может быть, но не главное
                    # Действия
                    "включи": 5,
                    "активируй": 5,
                    "сделай": 2,
                },
                "category": "fan"
            },
            
            "start_fan": {
                "keywords": {
                    # Объекты
                    "вентилятор": 10, "вентиляци": 10, "проветр": 10,
                    "вытяжк": 8, "воздух": 5,
                    # Синонимы
                    "дуй": 5, "ветер": 3, "освежи": 3,
                    # Действия
                    "включи": 8, "запусти": 8, "активируй": 5,
                    "погоняй": 5, "поработай": 3,
                    # Таймер
                    "на": 5, "минут": 5, "мин": 5,
                    "врем": 3, "в течение": 3,
                },
                "timer": True,
                "unit": "minutes",
                "category": "fan"
            },
        }
        
        # Стоп-слова
        self.stop_words = {
            "пожалуйста", "будь", "добр", "сделай", "можно", 
            "хочу", "чтобы", "пусть", "как", "так", "этот",
            "это", "тут", "здесь", "сейчас", "скажи", "помоги",
            "нужно", "надо", "бы", "ли", "просто", "вообще"
        }
        
        # Строим триграммный индекс
        self.trigram_index = self._build_trigram_index()
        
        # Извлекатели параметров
        self.number_pattern = re.compile(r'(\d+)\s*(?:минут|мин|м|секунд|сек|с)')
    
    def _parse_pol(self, *args) -> Optional[str]:
        """Обработка 'пол девятого' -> 8:30, 'пол 9' -> 8:30"""
        if not args or not args[0]:
            return None
        
        word = str(args[0]).lower().strip()
        
        # Словарь: ключ -> час (пол Х-ого = Х-1:30)
        text_map = {
            'перв': 1,    # пол первого = 0:30
            'втор': 2,    # пол второго = 1:30
            'трет': 3,    # пол третьего = 2:30
            'четверт': 4, # пол четвертого = 3:30
            'пят': 5,     # пол пятого = 4:30
            'шест': 6,    # пол шестого = 5:30
            'седьм': 7,   # пол седьмого = 6:30
            'восьм': 8,   # пол восьмого = 7:30
            'девят': 9,   # пол девятого = 8:30
            'десят': 10,  # пол десятого = 9:30
            'одиннадцат': 11, # пол одиннадцатого = 10:30
        }
        
        # Если цифра (например "пол 9")
        if word.isdigit():
            hour = int(word)
            # пол 9 = 8:30
            if 1 <= hour <= 11:
                return f"{hour-1:02d}:30"
        
        # Если текст
        for key, hour in text_map.items():
            if word.startswith(key):
                # hour - это следующий час, а нам нужен предыдущий
                # пол девятого (9) = 8:30
                return f"{hour-1:02d}:30"
        
        return None
    
    def _get_trigrams(self, word: str) -> Set[str]:
        """Триграммы БЕЗ границ - только реальные сочетания"""
        trigrams = set()
        word = word.lower()
        if len(word) < 3:
            return trigrams
        for i in range(len(word) - 2):
            trigrams.add(word[i:i+3])
        return trigrams
    
    def _build_trigram_index(self) -> Dict[str, List[Tuple[str, float, str]]]:
        """Строим обратный индекс триграмм"""
        index = defaultdict(list)
        
        for cmd_name, cmd_data in self.commands.items():
            for keyword, weight in cmd_data["keywords"].items():
                for subword in keyword.lower().split():
                    trigrams = self._get_trigrams(subword)
                    for trigram in trigrams:
                        index[trigram].append((cmd_name, weight, keyword))
        
        return dict(index)
    
    def extract_time(self, text: str) -> Optional[str]:
        """Извлекает время из текста."""
        if not text:
            return None
        
        text = text.lower()
        
        # 1. Форматы с пробелами: "18 0 0", "9 30", "18 00"
        space_patterns = [
            (r'(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})', lambda h,m,s: f"{int(h):02d}:00"),  # 18 0 0
            (r'(\d{1,2})\s+(\d{1,2})', lambda h,m: f"{int(h):02d}:{int(m):02d}"),       # 9 30
        ]
        
        for pattern, formatter in space_patterns:
            match = re.search(pattern, text)
            if match:
                try:
                    return formatter(*match.groups())
                except:
                    continue
        
        # 2. Стандартные форматы
        patterns = [
            # 19:30, 19.30
            (r'(\d{1,2})[:.](\d{2})', lambda h,m: f"{int(h):02d}:{m}"),
            
            # 7 утра, 8 вечера
            (r'(\d{1,2})\s*(?:час)?\s*(утра|дня|вечера|ночи)', self._parse_12h),
            
            # в 7, в 19
            (r'[вв]\s*(\d{1,2})\b(?!\s*(?:утра|дня|вечера|ночи))', lambda h: f"{int(h):02d}:00"),
            
            # полдень, полночь
            (r'полдень', lambda: "12:00"),
            (r'полночь', lambda: "00:00"),
            
            # пол девятого, пол 9
            (r'пол[оу]?\s*(одиннадцат|десят|девят|восьм|седьм|шест|пят|четверт|трет|втор|перв|\d+)', 
             self._parse_pol),
        ]
        
        for pattern, handler in patterns:
            match = re.search(pattern, text)
            if match:
                try:
                    groups = [g for g in match.groups() if g is not None]
                    result = handler(*groups) if groups else handler()
                    if result:
                        return result
                except Exception as e:
                    logger.debug(f"Time parse error: {e}")
                    continue
        
        return None

    def _parse_12h(self, hour: str, period: str) -> Optional[str]:
        """Парсит 12-часовой формат"""
        try:
            h = int(hour)
            if period in ['утра', 'дня']:
                if h == 12:
                    return "12:00"
                return f"{h:02d}:00"
            elif period == 'вечера':
                if h == 12:
                    return "00:00"
                return f"{h+12 if h < 12 else h:02d}:00"
            elif period == 'ночи':
                if h == 12:
                    return "00:00"
                return f"{h if h > 4 else h+12:02d}:00"
        except:
            return None
        return None
    
    def extract_number(self, text: str, unit: str = None) -> Optional[int]:
        """Извлекает число"""
        if not text:
            return None
        
        text = text.lower()
        
        # Добавим обработку словесных чисел
        word_numbers = {
            'пару': 2, 'несколько': 3, 'пять': 5, 'десять': 10,
            'пятнадцать': 15, 'двадцать': 20, 'тридцать': 30
        }
        
        for word, value in word_numbers.items():
            if word in text:
                return value
        
        patterns = {
            'minutes': [
                r'(\d+)\s*(?:минут|мин|м|минуты|минуту)\b',
                r'на\s*(\d+)\s*(?:минут|мин|м)\b',
            ],
            'seconds': [
                r'(\d+)\s*(?:секунд|сек|с|секунды|секунду)\b',
            ],
        }
        
        pats = patterns.get(unit, []) if unit else []
        pats.extend([r'(\d+)'])
        
        for pattern in pats:
            match = re.search(pattern, text)
            if match:
                try:
                    return int(match.group(1))
                except:
                    continue
        
        return None
    
    def match(self, text: str, threshold: float = 0.3) -> Optional[Dict]:
        """Матчим команду по триграммам"""
        if not text:
            return None
        
        # Очищаем текст
        text = text.lower().strip()
        original_words = text.split()
        words = [w for w in original_words if w not in self.stop_words]
        
        if not words:
            return None
        
        # ============= УСИЛЕННОЕ ДЕТЕКТИРОВАНИЕ ДЕЙСТВИЯ =============
        wanted_action = None
        text_lower = text
        
        # Максимально широкие списки слов
        on_words = [
            "включи", "включить", "включения", "включение", "включай",
            "активируй", "зажги", "замкни", "запусти", "вруби",
            "свети", "гори", "on", "вкл", "включено", "включается",
            "включатся", "включится", "включаю", "включаем",
            "включу", "включит", "включат"
        ]
        
        off_words = [
            "выключи", "выключить", "выключения", "выключение", "выключай",
            "отключи", "отключить", "отключения", "отключение", "отключай",
            "потуши", "погаси", "погасить", "потушить", "разомкни",
            "погасни", "останови", "off", "выкл", "выключено",
            "выключается", "выключатся", "выключится", "выключаю",
            "выключаем", "выключу", "выключит", "выключат",
            "отключается", "отключатся", "отключится"
        ]
        
        # 1. Сначала ищем точные слова
        on_match = any(word in text_lower for word in on_words)
        off_match = any(word in text_lower for word in off_words)
        
        # 2. Если оба совпали (например "включения" и "отключения" в одном тексте)
        if on_match and off_match:
            # Смотрим чего больше
            on_count = sum(text_lower.count(word) for word in on_words)
            off_count = sum(text_lower.count(word) for word in off_words)
            wanted_action = "on" if on_count > off_count else "off"
            logger.info(f"⚖️ Both actions detected, counts: on={on_count}, off={off_count} -> {wanted_action}")
        
        # 3. Иначе берем то что нашли
        elif on_match:
            wanted_action = "on"
            logger.info(f"🔥 Detected ON action: {text_lower}")
        elif off_match:
            wanted_action = "off"
            logger.info(f"🔥 Detected OFF action: {text_lower}")
        
        # 4. Если не нашли точных слов, проверяем окончания и корни
        else:
            # Проверяем корни слов
            if "ключ" in text_lower:
                if "в" in text_lower and "от" not in text_lower:
                    wanted_action = "on"
                    logger.info(f"🔍 Detected ON by root 'включ'")
                elif "от" in text_lower:
                    wanted_action = "off"
                    logger.info(f"🔍 Detected OFF by root 'отключ'")
            
            # Проверяем контекст
            elif "свет" in text_lower or "датчик" in text_lower:
                # Если нет явного указания, смотрим на общий тон
                if any(w in text_lower for w in ["утра", "дня", "вечера", "ночи"]):
                    # Если есть время, скорее всего включение
                    wanted_action = "on"
                    logger.info(f"🔍 Detected ON by presence of time")
        
        # Проверяем наличие времени
        has_time = self.extract_time(text) is not None
        logger.info(f"⏰ Has time: {has_time}")
        
        # Считаем релевантность
        scores = defaultdict(float)
        matched_keywords = defaultdict(set)
        exact_matches = defaultdict(set)
        
        # Точные совпадения
        for word in words:
            for cmd_name, cmd_data in self.commands.items():
                for keyword, weight in cmd_data["keywords"].items():
                    if word == keyword.lower():
                        exact_matches[cmd_name].add(keyword)
                        scores[cmd_name] += weight * 3
        
        # Триграммы
        for word in words:
            if len(word) < 3:
                continue
            
            word_trigrams = self._get_trigrams(word)
            for trigram in word_trigrams:
                if trigram in self.trigram_index:
                    for cmd_name, weight, keyword in self.trigram_index[trigram]:
                        if cmd_name in exact_matches and keyword in exact_matches[cmd_name]:
                            continue
                        
                        word_bonus = min(1.0, len(word) / 10)
                        scores[cmd_name] += weight * (1 + word_bonus)
                        matched_keywords[cmd_name].add(word)
        
        if not scores:
            return None
        
        # Бонус за разнообразие
        for cmd_name in scores:
            uniqueness = len(matched_keywords[cmd_name]) / max(1, len(words))
            scores[cmd_name] *= (1 + uniqueness * 0.3)
        
        # ============= СПЕЦИАЛЬНЫЕ ПРАВИЛА ДЛЯ КОНКРЕТНЫХ КОМАНД =============
        
        # 1. Если есть слова про тишину - убиваем relay_manual и бустим silent_mode
        silence_words = ["тих", "тишины", "бесшум", "не шуми", "тихо", "шум"]
        if any(word in text_lower for word in silence_words):
            if "set_relay_manual" in scores:
                scores["set_relay_manual"] *= 0.01  # штраф 99%
                logger.debug(f"🔇 Silence detected, killing relay_manual")
            if "set_relay_auto" in scores:
                scores["set_relay_auto"] *= 0.1  # штраф 90%
                logger.debug(f"🔇 Silence detected, penalizing relay_auto")
            if "set_silent_mode_on" in scores:
                scores["set_silent_mode_on"] *= 3.0  # бонус x3
                logger.debug(f"🔇 Silence detected, boosting silent_mode")
        
        # 2. Если есть слова про ручное управление - бустим ручные команды
        manual_words = ["ручн", "вручн", "руками", "вручную"]
        if any(word in text_lower for word in manual_words):
            for cmd_name in scores:
                if cmd_name.startswith("set_manual_"):
                    scores[cmd_name] *= 2.5
                    logger.debug(f"🖐️ Manual detected, boosting {cmd_name}")
                elif cmd_name == "set_relay_manual":
                    scores[cmd_name] *= 2.0
                    logger.debug(f"🖐️ Manual detected, boosting relay_manual")

        # ============= СПЕЦИАЛЬНЫЕ ПРАВИЛА ДЛЯ НОВЫХ КОМАНД =============

        # 3. Текущие данные - добавим проверку что это не команда управления
        current_words = ["сейчас", "текущ", "телеметрия", "теперь", "данные", "показания"]
        if any(word in text_lower for word in current_words):
            if "get_current_data" in scores:
                # Проверяем что нет слов управления
                control_words = ["включи", "выключи", "установи", "поставь", "сделай"]
                if not any(word in text_lower for word in control_words):
                    scores["get_current_data"] *= 2.5
                    logger.debug(f"📊 Current data detected, boosting get_current_data")

        # 4. Если есть слова про вчера - бустим get_ai_yesterday
        yesterday_words = ["вчера", "вчерашн", "сутки", "прошл"]
        if any(word in text_lower for word in yesterday_words):
            if "get_ai_yesterday" in scores:
                scores["get_ai_yesterday"] *= 3.0
                logger.debug(f"📅 Yesterday detected, boosting get_ai_yesterday")
            
            # Штрафуем weekly если есть явное указание на вчера
            if "get_ai_weekly" in scores:
                scores["get_ai_weekly"] *= 0.2
                logger.debug(f"❌ Penalizing weekly for yesterday request")

        # 5. Если есть слова про неделю - бустим get_ai_weekly
        weekly_words = ["недел", "7 дней", "семь дней", "предыдущ"]
        if any(word in text_lower for word in weekly_words):
            if "get_ai_weekly" in scores:
                scores["get_ai_weekly"] *= 3.0
                logger.debug(f"📆 Weekly detected, boosting get_ai_weekly")
            
            # Штрафуем yesterday если есть явное указание на неделю
            if "get_ai_yesterday" in scores:
                scores["get_ai_yesterday"] *= 0.2
                logger.debug(f"❌ Penalizing yesterday for weekly request")
        
        # Применяем контекстные правила
        has_specific = any(w in original_words for w in ["дневн", "ночн", "туалет", "свет", "датчик"])
        
        # Сохраняем копию для логирования
        original_scores = scores.copy()
        
        for cmd_name in list(scores.keys()):
            cmd = self.commands[cmd_name]
            
            # ШТРАФУЕМ команды с НЕПРАВИЛЬНЫМ действием (МАКСИМАЛЬНО ЖЕСТКО)
            if wanted_action:
                if cmd_name.endswith("_on") and wanted_action == "off":
                    scores[cmd_name] *= 0.001  # штраф 99.9%
                    logger.debug(f"❌ DEAD {cmd_name} for wrong action (want off)")
                elif cmd_name.endswith("_off") and wanted_action == "on":
                    scores[cmd_name] *= 0.001  # штраф 99.9%
                    logger.debug(f"❌ DEAD {cmd_name} for wrong action (want on)")
            
            # КЛЮЧЕВОЕ: Если нет времени - убиваем команды расписания
            if not has_time:
                if cmd.get("can_have_time"):  # команда расписания
                    scores[cmd_name] *= 0.05  # штраф 95%
                    logger.debug(f"⏰ No time, killing schedule command: {cmd_name}")
                if cmd_name.startswith("set_manual_"):  # ручная команда
                    scores[cmd_name] *= 2.0  # бонус x2
                    logger.debug(f"👍 No time, boosting manual command: {cmd_name}")
            
            # Если есть время - бонус командам расписания
            if has_time:
                if cmd.get("can_have_time"):
                    scores[cmd_name] *= 3.0  # бонус x3
                    logger.debug(f"⏰ Has time, boosting schedule command: {cmd_name}")
                if cmd_name.startswith("set_manual_"):
                    scores[cmd_name] *= 0.1  # штраф 90%
                    logger.debug(f"👎 Has time, penalizing manual command: {cmd_name}")
            
            # Штраф общим командам если есть конкретный объект
            if has_specific and cmd_name in ["set_relay_auto", "set_relay_manual"]:
                scores[cmd_name] *= 0.1
                logger.debug(f"🎯 Specific object, penalizing general mode: {cmd_name}")
        
        # Логируем изменения
        logger.debug(f"Original scores: {dict(original_scores)}")
        logger.debug(f"Final scores: {dict(scores)}")
        
        # Выбираем лучшую команду
        if not scores:
            return None
            
        best_cmd = max(scores.items(), key=lambda x: x[1])
        
        # Нормализуем confidence
        max_possible = 200
        confidence = min(1.0, best_cmd[1] / max_possible)
        
        logger.info(f"🏆 Best: {best_cmd[0]} with confidence {confidence:.2f}, action wanted: {wanted_action}")
        
        if confidence < threshold:
            logger.info(f"Confidence {confidence} below threshold {threshold}")
            return None
        
        cmd_name = best_cmd[0]
        cmd_config = self.commands[cmd_name]
        
        # Извлекаем параметры
        params = {}
        
        if cmd_config.get("can_have_time"):
            time = self.extract_time(text)
            if time:
                params["time"] = time
                logger.info(f"⏰ Extracted time: {time}")
        
        if cmd_config.get("timer"):
            minutes = self.extract_number(text, "minutes")
            if minutes:
                params["minutes"] = minutes
                logger.info(f"⏱️ Extracted minutes: {minutes}")
        
        # Финальное определение действия (перестраховка)
        action = None
        if wanted_action:
            action = wanted_action
        else:
            if any(word in text_lower for word in on_words):
                action = "on"
            elif any(word in text_lower for word in off_words):
                action = "off"
        
        return {
            "command": cmd_name,
            "confidence": confidence,
            "params": params,
            "action": action
        }

# Глобальный экземпляр
matcher = CommandTriGramMatcher()