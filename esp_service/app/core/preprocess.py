import re
from typing import List, Set
from logger import logger

class CommandPreprocessor:
    def __init__(self):
        # Стоп-слова которые можно безопасно выкинуть
        self.stop_words: Set[str] = {
            # Приветствия
            "алло", "привет", "здорово", "здрасте", "приветствую",
            # Обращения
            "бот", "слушай", "дорогой", "уважаемый", "пожалуйста", "будь добр",
            "будьте добры", "сделай одолжение", "прошу", "умоляю",
            # Вводные слова
            "типа", "значит", "короче", "блин", "же", "ну", "вот", "это",
            # Прощания
            "пока", "до свидания", "всего доброго", "спасибо", "благодарю"
        }
        
        # Паттерны для чистки
        self.clean_patterns = [
            # Знаки препинания (кроме полезных)
            (r'[^\w\s:.]', ' '),  # заменяем всё кроме букв, цифр, пробелов, : и .
            # Множественные пробелы
            (r'\s+', ' '),
            # Пробелы в начале/конце
            (r'^\s+|\s+$', '')
        ]
        
        # Словари для нормализации
        self.time_normalization = {
            r'(\d{1,2})\s*(?:час|часов|часа|ч)\s*(?:утра|дня)?\b': r'\1:00',
            r'(\d{1,2})\s*(?:утра|дня|вечера|ночи)': r'\1:00',
            r'полдень': '12:00',
            r'полночь': '00:00'
        }
        
        # Фразы которые нужно сохранять (не вырезать)
        self.protected_phrases = [
            "автоматический режим",
            "ручной режим",
            "тихий режим",
            "умный режим",
            "постоянный режим"
        ]
    
    def process(self, text: str) -> str:
        """Основной метод обработки"""
        if not text or not isinstance(text, str):
            return ""
        
        # Сохраняем оригинал для логов
        original = text
        
        # Защищаем важные фразы от разбиения
        protected_map = {}
        for i, phrase in enumerate(self.protected_phrases):
            placeholder = f"__PROTECTED_{i}__"
            if phrase in text.lower():
                text = text.replace(phrase, placeholder)
                protected_map[placeholder] = phrase
        
        # Приводим к нижнему регистру
        text = text.lower()
        
        # Убираем знаки препинания
        for pattern, repl in self.clean_patterns:
            text = re.sub(pattern, repl, text)
        
        # Убираем стоп-слова (но осторожно)
        words = text.split()
        filtered_words = []
        for word in words:
            # Проверяем не защищенная ли фраза
            if word in protected_map:
                filtered_words.append(protected_map[word])
            elif word not in self.stop_words:
                filtered_words.append(word)
        
        text = ' '.join(filtered_words)
        
        # Нормализуем время
        text = self._normalize_time(text)
        
        # Финальная чистка
        text = re.sub(r'\s+', ' ', text).strip()
        
        logger.debug(f"Preprocessed: '{original}' -> '{text}'")
        return text
    
    def _normalize_time(self, text: str) -> str:
        """Приводим время к единому формату"""
        for pattern, replacement in self.time_normalization.items():
            text = re.sub(pattern, replacement, text)
        
        # Ищем паттерны типа "в 7:00" или "на 7:00"
        time_pattern = r'(?:в|на|с|до)?\s*(\d{1,2}):(\d{2})'
        matches = re.finditer(time_pattern, text)
        
        for match in matches:
            hour = int(match.group(1))
            minute = match.group(2)
            # Нормализуем часы
            if 0 <= hour <= 23 and 0 <= int(minute) <= 59:
                normalized = f"{hour:02d}:{minute}"
                text = text.replace(match.group(0), normalized)
        
        return text
    
    def extract_entities(self, text: str) -> dict:
        """Извлекаем сущности (время, числа) до LLM"""
        entities = {}
        
        # Ищем время
        time_match = re.search(r'(\d{2}:\d{2})', text)
        if time_match:
            entities['time'] = time_match.group(1)
        
        # Ищем числа с единицами измерения
        number_patterns = [
            (r'(\d+)\s*(?:минут|мин|м)', 'minutes'),
            (r'(\d+)\s*(?:секунд|сек|с)', 'seconds'),
            (r'(\d+)\s*(?:раз|раза)', 'count')
        ]
        
        for pattern, key in number_patterns:
            match = re.search(pattern, text)
            if match:
                entities[key] = int(match.group(1))
        
        return entities
    
    def is_greeting_only(self, text: str) -> bool:
        """Проверяем не просто ли приветствие"""
        text = text.lower().strip()
        greetings = {"привет", "здравствуй", "здорово", "hello", "hi"}
        return text in greetings