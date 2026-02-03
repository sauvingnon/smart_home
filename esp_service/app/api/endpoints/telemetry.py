# api/routes/esp_service.py
from fastapi import APIRouter, HTTPException
from app.core.worker import WeatherBackgroundWorker
from app.schemas.telemetry import TelemetryData
from typing import List

router = APIRouter(
    prefix="/esp_service",
    tags=["esp_service"],
)

@router.get("/telemetry", response_model=TelemetryData)
async def get_current_telemetry():
    """
    Получить текущую телеметрию устройства.
    
    Возвращает последние полученные данные от ESP устройства.
    """
    worker = WeatherBackgroundWorker.get_instance()
    telemetry = worker.get_current_telemetry()
    
    if telemetry is None:
        raise HTTPException(
            status_code=404, 
            detail="Телеметрия еще не получена от устройства"
        )
    
    return telemetry