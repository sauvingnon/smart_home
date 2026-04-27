# api/routes/esp_service.py
from fastapi import APIRouter, HTTPException, Depends
from app.core.worker import BackgroundWorker
from app.schemas.weather_data import WeatherData
from app.core.auth import get_current_user_id_dep

router = APIRouter(
    prefix="/esp_service",
    tags=["esp_service"],
)

@router.get("/weather", response_model=WeatherData)
async def get_current_weather_endpoint(
    user_id: int = Depends(get_current_user_id_dep)
):
    """
    Получить данные о погоде.
    """
    worker = BackgroundWorker.get_instance()
    weather = await worker.get_weather()
    
    if weather is None:
        raise HTTPException(
            status_code=503, 
            detail="Не удалось получить данные о погоде."
        )
    
    return weather