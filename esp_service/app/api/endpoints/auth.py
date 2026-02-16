# api/routes/esp_service.py
from fastapi import APIRouter, HTTPException, Request, Header
from app.core.worker import WeatherBackgroundWorker
from app.schemas.auth import KeyResponse
from typing import List
from config import BOT_SECRET

router = APIRouter(
    prefix="/auth",
    tags=["auth"],
)

@router.post("/generate_key", response_model=KeyResponse)
async def generate_key(
    user_id: int, 
    request: Request,
    x_bot_secret: str = Header(...)
):
    """Для бота - генерация ключа."""

    if x_bot_secret != BOT_SECRET:
        raise HTTPException(status_code=403, detail="Invalid bot secret")

    worker = WeatherBackgroundWorker.get_instance()
    key = await worker.cache.generate_key(user_id)
    result = KeyResponse(
        key=key,
        expires_in_days=180
    )
    return result

async def get_current_user_id(request: Request) -> int:
    """Зависимость для получения user_id из ключа"""
    worker = WeatherBackgroundWorker.get_instance()
    return await worker.verify_access_key(request)