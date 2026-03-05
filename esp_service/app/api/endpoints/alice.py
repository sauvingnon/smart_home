from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from logger import logger
from app.core.command_triagram_matcher import matcher
from app.core.command_executor import CommandExecutor
from app.core.worker import WeatherBackgroundWorker

router = APIRouter(
    prefix="/esp_service",
    tags=["esp_service"],
)

@router.post("/alice")
async def alice_webhook(request: Request):
    """
    Эндпоинт для Яндекса. Принимает текст, отдаёт в парсер.
    """
    body = await request.json()
    logger.info(f"🔥 Запрос от Алисы: {body}")
    
    # Достаём текст и сессию
    user_text = body.get("request", {}).get("command", "").lower().strip()
    session = body.get("session", {})
    version = body.get("version", "1.0")
    
    # Если пустая команда — быстрый ответ
    if not user_text:
        return await _alice_response(session, version, "Слушаю", end_session=False)
    
    # Обрабатываем команду
    result = await _handle_command(user_text)
    
    # Возвращаем Алисе
    return await _alice_response(
        session=session,
        version=version,
        text=result["message"],
        end_session=False  # Сессию не закрываем
    )

async def _handle_command(text: str) -> dict:
    """
    Тут вся твоя логика живёт.
    """
    try:
        # 1. Ищем команду по триграммам
        command = matcher.match(text, threshold=0.65)  # Чуть повысил порог
        
        # Если ничего не нашли
        if command is None:
            logger.warning(f"❌ Неизвестная команда: {text}")
            return {
                "success": False,
                "message": "Не знаю такой команды"
            }
        
        logger.info(f"✅ Распознал команду: {command}")
        
        # 2. Выполняем
        worker = WeatherBackgroundWorker.get_instance()
        executor = CommandExecutor(worker=worker)
        message = await executor.execute(command)
        
        return {
            "success": True,
            "message": message or "Готово"
        }
        
    except Exception as e:
        logger.error(f"💥 Ошибка: {e}", exc_info=True)
        return {
            "success": False,
            "message": "Ошибка, попробуй ещё"
        }

async def _alice_response(session: dict, version: str, text: str, end_session: bool = False):
    """
    Формирует стандартный ответ для Алисы.
    """
    return JSONResponse(content={
        "session": session,
        "version": version,
        "response": {
            "end_session": end_session,
            "text": text,
            "tts": text  # Можно кастомизировать, если хочешь с паузами/акцентами
        }
    })