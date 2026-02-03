from datetime import datetime
from typing import Optional
from pydantic import BaseModel


class WeatherData(BaseModel):
    """Модель для хранения в Redis"""
    current_temp: int
    current_feels_like: int
    current_condition: str
    humidity: int
    wind_speed: float\
    
    evening_temp: Optional[int]
    night_temp: Optional[int]
    morning_temp: Optional[int]
    day_temp: Optional[int]

    timestamp: datetime

    expires_at: datetime  # Время устаревания данных
    api_calls_today: int = 0  # Счетчик вызовов API

class BoardData(BaseModel):
    """Данные для отправки на плату (без timestamp)"""
    temp: int
    feels_like: int
    condition: str
    humidity: int
    wind_speed: float
    
    # Прогноз на сегодня
    morning_temp: int
    day_temp: int
    evening_temp: int
    night_temp: int

    update_at: str