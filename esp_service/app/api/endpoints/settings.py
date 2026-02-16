# api/routes/esp_service.py
from fastapi import APIRouter, HTTPException, Depends
from app.core.worker import WeatherBackgroundWorker
from app.schemas.settings import SettingsData
from typing import List
from app.api.endpoints.auth import get_current_user_id

router = APIRouter(
    prefix="/esp_service",
    tags=["esp_service"],
)

@router.get("/settings", response_model=SettingsData)
async def get_current_setttings(
    user_id: int = Depends(get_current_user_id)
):
    """
    Получить текущие настройки устройства.
    
    Возвращает настройки ESP устройства.
    """
    worker = WeatherBackgroundWorker.get_instance()
    settings = await worker.get_current_config()
    
    if settings is None:
        raise HTTPException(
            status_code=404, 
            detail="Настройки не получены от устройства"
        )
    
    return settings


@router.post("/settings")
async def update_settings(
    settings: SettingsData,
    user_id: int = Depends(get_current_user_id)
    ):
    """
    Обновить настройки устройства.
    
    Принимает новые настройки и:
    1. Сохраняет на сервере
    2. Отправляет на ESP устройство
    3. Возвращает статус операции
    """
    worker = WeatherBackgroundWorker.get_instance()
    await worker.send_to_board_settings(settings)