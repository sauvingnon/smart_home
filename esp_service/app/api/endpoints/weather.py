# api/routes/esp_service.py
from fastapi import APIRouter, HTTPException
from app.core.worker import WeatherBackgroundWorker
from app.schemas.weather_data import WeatherData
from typing import List

router = APIRouter(
    prefix="/esp_service",
    tags=["esp_service"],
)

@router.get("/weather", response_model=WeatherData)
async def get_current_weather():
    """
    Получить данные о погоде.
    """
    worker = WeatherBackgroundWorker.get_instance()
    weather = await worker.get_weather()
    
    if weather is None:
        raise HTTPException(
            status_code=404, 
            detail="Не удалось получить данные о погоде."
        )
    
    return weather