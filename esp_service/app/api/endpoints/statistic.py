# api/routes/esp_service.py
from typing import Optional
from fastapi import APIRouter, HTTPException, Depends, Query
from app.core.worker import WeatherBackgroundWorker
from app.schemas.telemetry_history import (
    HistoryResponse,
    StatsResponse,
    TelemetryRecord
)
from app.api.endpoints.auth import get_current_user_id

router = APIRouter(
    prefix="/esp_service",
    tags=["esp_service"],
)

@router.get("/history", response_model=HistoryResponse)
async def get_history(
    hours: int = Query(24, ge=1, le=168)
    # user_id: int = Depends(get_current_user_id)
):
    """
    Получить историю телеметрии за последние N часо
    """
    worker = WeatherBackgroundWorker.get_instance()
    records = await worker.storage.get_history(hours=hours, device_id=worker.device_id)
    
    if not records:  # records — это список, проверяем через if not
        raise HTTPException(
            status_code=404, 
            detail="История не получена"
        )
    
    return HistoryResponse(
        period_hours=hours,
        records_count=len(records),  # records уже список TelemetryRecord
        records=records  # ← просто records, без распаковки!
    )

@router.get("/stats", response_model=StatsResponse)
async def get_stats(
    hours: int = Query(24, ge=1, le=168, description="Количество часов для статистики")
    # user_id: int = Depends(get_current_user_id)
):
    """Получить статистику за период"""
    worker = WeatherBackgroundWorker.get_instance()
    stats = await worker.storage.get_stats(hours, worker.device_id)
    
    return stats