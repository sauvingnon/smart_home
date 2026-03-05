# Гибридная обработка команд

from app.core.worker import WeatherBackgroundWorker
from app.core.command_executor import CommandExecutor
from app.core.command_triagram_matcher import matcher
from logger import logger

async def handle_text_command(request: str) -> str:
    try:

        logger.info(f"Поступила команда: {request}")

        # parser = LLMCommandParser()
        # llm_result = await parser.parse(clean_text)

        command = matcher.match(request)

        logger.info(command)

        worker = WeatherBackgroundWorker.get_instance()
        executor = CommandExecutor(worker=worker)

        if command:
            logger.info(f"Ответ LLM удовлятворяет")
            # Тут уже выполняем команду
            command_result = await executor.execute(command)
            logger.info(command_result)
            return command_result
        
        logger.info("Низкая точность LLM.")

        return "Намерение не распознано. Повторите попытку."
    except:
        return "Внутренняя ошибка. Команда не выполнена."

    
    
