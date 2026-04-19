# api/routes/esp_service.py
from fastapi import APIRouter, HTTPException, Depends
from app.core.worker import BackgroundWorker
from app.schemas.telemetry import GeneralResponse, TelemetryData
from typing import List
from app.core.auth import get_current_user_id_dep

router = APIRouter(
    prefix="/esp_service",
    tags=["esp_service"],
)

@router.get("/telemetry", response_model=GeneralResponse)
async def get_general_status_endpoint(
    user_id: int = Depends(get_current_user_id_dep)
):
    """
    Получить текущую телеметрию устройства.
    
    Возвращает последние полученные данные от ESP устройства.
    """
    worker = BackgroundWorker.get_instance()
    response = await worker.get_current_general_status()
    
    if response is None:
        raise HTTPException(
            status_code=500, 
            detail="Ошибка получения данных."
        )
    
    return response