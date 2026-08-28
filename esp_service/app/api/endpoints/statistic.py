# api/routes/esp_service.py
import asyncio
from typing import Optional
from fastapi import APIRouter, HTTPException, Depends, Query
from app.core.worker import BackgroundWorker
from app.schemas.telemetry_history import (
    HistoryResponse,
    StatsResponse,
    TelemetryRecord
)
from app.core.auth import get_current_user_id_dep, get_auth_manager
from app.utils.time import _get_izhevsk_time
from config import CAMERA_ID

router = APIRouter(
    prefix="/esp_service",
    tags=["esp_service"],
)

@router.get("/history", response_model=HistoryResponse)
async def get_history_endpoint(
    hours: int = Query(24, ge=1, le=168),
    max_points: int = Query(100, ge=10, le=250),
    user_id: int = Depends(get_current_user_id_dep)
):
    """
    Получить историю телеметрии за последние N часо
    """
    worker = BackgroundWorker.get_instance()
    records = await worker.storage.get_history(
        end_time=_get_izhevsk_time(),
        hours=hours,
        device_id=worker.device_id,
        max_points=max_points
    )
    
    if not records:  # records — это список, проверяем через if not
        raise HTTPException(
            status_code=503, 
            detail="История не получена"
        )
    
    return HistoryResponse(
        period_hours=hours,
        records_count=len(records),  # records уже список TelemetryRecord
        records=records  # ← просто records, без распаковки!
    )

@router.get("/login_stats")
async def get_login_stats_endpoint(
    user_id: int = Depends(get_current_user_id_dep)
):
    """Статистика входов пользователей. Только для администратора."""
    auth = get_auth_manager()
    if not await auth.is_admin(user_id):
        raise HTTPException(status_code=403, detail="Forbidden")

    worker = BackgroundWorker.get_instance()
    return await worker.cache.get_visit_stats(exclude_user_id=user_id, days=7)


@router.get("/stats", response_model=StatsResponse)
async def get_stats_endpoint(
    hours: int = Query(24, ge=1, le=168, description="Количество часов для статистики"),
    user_id: int = Depends(get_current_user_id_dep)
):
    """Получить статистику за период"""
    worker = BackgroundWorker.get_instance()
    stats = await worker.storage.get_stats(hours, worker.device_id)
    return stats


async def _none():
    return None


@router.get("/home_bootstrap")
async def get_home_bootstrap_endpoint(
    user_id: int = Depends(get_current_user_id_dep)
):
    """
    Telemetry + погода + даунтайм + (для админа) статистика входов — одним
    запросом вместо четырёх. HomePage раньше стреляла ими по отдельности на
    каждом маунте, и вместе с чатом это давало залп новых соединений на
    холодном старте PWA, что хостер с его anti-DDoS воспринимал как флуд.
    """
    worker = BackgroundWorker.get_instance()
    auth = get_auth_manager()
    is_admin = await auth.is_admin(user_id)

    device_ids = [
        worker.device_id,
        worker.sensor_id,
        worker.toilet_id,
        CAMERA_ID,
        "server",
    ]

    results = await asyncio.gather(
        worker.get_current_general_status(),
        worker.get_weather(),
        worker.cache.get_downtime_stats(device_ids, 7),
        worker.cache.get_visit_stats(exclude_user_id=user_id, days=7) if is_admin else _none(),
        return_exceptions=True,
    )
    status, weather, downtime, login_stats = (
        None if isinstance(r, Exception) else r for r in results
    )

    if downtime and CAMERA_ID in downtime:
        downtime[CAMERA_ID]["name"] = "Камера"

    return {
        "status": status,
        "weather": weather,
        "downtime": downtime,
        "login_stats": login_stats,
    }


@router.get("/downtime")
async def get_downtime_endpoint(
    days: int = Query(7, ge=1, le=7),
    user_id: int = Depends(get_current_user_id_dep)
):
    """Даунтайм всех устройств за последние N дней."""
    worker = BackgroundWorker.get_instance()
    device_ids = [
        worker.device_id,
        worker.sensor_id,
        worker.toilet_id,
        CAMERA_ID,
        "server",
    ]
    stats = await worker.cache.get_downtime_stats(device_ids, days)
    # Подставляем имя камеры отдельно (ID берётся из ENV)
    if CAMERA_ID in stats:
        stats[CAMERA_ID]["name"] = "Камера"
    return stats