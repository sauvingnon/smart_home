# Гибридная обработка команд

from typing import Dict, Any, Tuple, Optional
from app.core.worker import WeatherBackgroundWorker
from app.core.command_executor import CommandExecutor
from app.core.preprocess import CommandPreprocessor
from app.core.llm_parser import LLMCommandParser
from app.core.mather import CommandMatcher
from logger import logger

async def handle_text_command(request: str) -> str:
    try:

        logger.info(f"Поступила команда: {request}")

        # Препроцессинг
        preprocessor = CommandPreprocessor()
        clean_text = preprocessor.process(request)

        logger.info(f"Команда предобработана: {clean_text}")

        if preprocessor.is_greeting_only(clean_text):
            return "Привет! Чем могу помочь?"

        parser = LLMCommandParser()
        llm_result = await parser.parse(clean_text)

        worker = WeatherBackgroundWorker.get_instance()
        executor = CommandExecutor(worker=worker)

        if llm_result and llm_result.get("confidence", 0) >= 0.7:
            logger.info(f"Ответ LLM удовлятворяет")
            # Тут уже выполняем команду
            command_result = await executor.execute(llm_result)
            logger.info(command_result)
            return command_result
        
        logger.info("Низкая точность LLM.")
        # matcher = CommandMatcher()
        # mather_result = await matcher.match(clean_text)

        # if mather_result is not None:
        #     return await executor.execute(mather_result)

        return "Намерение не распознано. Повторите попытку."
    except:
        return "Произошла ошибка. Команда не отправлена."

    
    
