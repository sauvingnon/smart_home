# api/routes/esp_service.py
from fastapi import APIRouter, HTTPException, Depends
from app.core.worker import BackgroundWorker
from app.schemas.telemetry import TelemetryData
from typing import List
from app.core.auth import get_current_user_id_dep

router = APIRouter(
    prefix="/esp_service",
    tags=["esp_service"],
)

@router.get("/telemetry", response_model=TelemetryData)
async def get_current_telemetry_endpoint(
    user_id: int = Depends(get_current_user_id_dep)
):
    """
    Получить текущую телеметрию устройства.
    
    Возвращает последние полученные данные от ESP устройства.
    """
    worker = BackgroundWorker.get_instance()
    telemetry = worker.get_current_telemetry()
    
    if telemetry is None:
        raise HTTPException(
            status_code=404, 
            detail="Телеметрия еще не получена от устройства"
        )
    
    return telemetry