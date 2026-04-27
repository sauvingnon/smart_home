# api/routes/esp_service.py
from fastapi import APIRouter, HTTPException, Depends
from app.core.worker import BackgroundWorker
from app.schemas.settings import SettingsData
from app.core.auth import get_current_user_id_dep

router = APIRouter(
    prefix="/esp_service",
    tags=["esp_service"],
)

@router.get("/settings", response_model=SettingsData)
async def get_current_setttings_endpoint(
    user_id: int = Depends(get_current_user_id_dep)
):
    """
    Получить текущие настройки устройства.
    
    Возвращает настройки ESP устройства.
    """
    worker = BackgroundWorker.get_instance()
    settings = await worker.get_current_config()
    
    if settings is None:
        raise HTTPException(
            status_code=504, 
            detail="Настройки не получены от устройства"
        )
    
    return settings


@router.post("/settings")
async def update_settings_endpoint(
    settings: SettingsData,
    user_id: int = Depends(get_current_user_id_dep)
    ):
    """
    Обновить настройки устройства.
    
    Принимает новые настройки и:
    1. Сохраняет на сервере
    2. Отправляет на ESP устройство
    3. Возвращает статус операции
    """
    worker = BackgroundWorker.get_instance()
    await worker.send_to_board_settings(settings)