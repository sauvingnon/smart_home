# api/routes/esp_service.py
from fastapi import APIRouter, HTTPException, Depends, Query
from app.core.worker import WeatherBackgroundWorker
from app.api.endpoints.auth import get_current_user_id

router = APIRouter(
    prefix="/esp_service",
    tags=["esp_service"],
)

@router.get("/ai_report/daily", response_model=str)
async def ai_report_daily_endpoint(
    # user_id: int = Depends(get_current_user_id)
):
    """
    Получить аналитический обзор показателей с помощью истории и ИИ
    """
    worker = WeatherBackgroundWorker.get_instance()

    response = await worker.get_daily_report()

    if response is None:
        raise HTTPException(
            status_code=500, 
            detail="Отчет за вчера не получен."
        )
    
    return response

@router.get("/ai_report/weekly", response_model=str)
async def ai_report_weekly_endpoint(
    # user_id: int = Depends(get_current_user_id)
):
    """
    Получить аналитический обзор показателей с помощью истории и ИИ
    """
    worker = WeatherBackgroundWorker.get_instance()

    response = await worker.get_weekly_report()

    if response is None:
        raise HTTPException(
            status_code=500, 
            detail="Отчет за неделю не получен."
        )
    
    return response