# PYDANTIC СХЕМЫ (стабильный контракт)

from pydantic import BaseModel, Field
from typing import Optional, List
from datetime import datetime

class FactData(BaseModel):
    """Текущая погода"""
    temp: int = Field(..., alias='temp')
    feels_like: int = Field(..., alias='feels_like')
    condition: str = Field(..., alias='condition')
    wind_speed: float = Field(..., alias='wind_speed')
    # pressure_mm: int = Field(..., alias='pressure_mm')
    humidity: int = Field(..., alias='humidity')
    daytime: str = Field(..., alias='daytime')
    icon: str = Field(..., alias='icon')

class ForecastPart(BaseModel):
    """Часть прогноза (утро/день/вечер/ночь)"""
    temp_avg: Optional[int] = Field(None, alias='temp_avg')
    temp_min: Optional[int] = Field(None, alias='temp_min')
    temp_max: Optional[int] = Field(None, alias='temp_max')
    feels_like: int = Field(..., alias='feels_like')
    condition: str = Field(..., alias='condition')
    wind_speed: float = Field(..., alias='wind_speed')
    prec_strength: float = Field(..., alias='prec_strength')
    prec_type: int = Field(..., alias='prec_type')

class ForecastDay(BaseModel):
    """Прогноз на один день"""
    date: str = Field(..., alias='date')
    parts: dict = Field(..., alias='parts')  # Сохраняем как есть, парсим по требованию

class YandexResponse(BaseModel):
    """Полный ответ API Яндекс.Погоды"""
    now: int = Field(..., alias='now')
    now_dt: datetime = Field(..., alias='now_dt')
    fact: FactData = Field(..., alias='fact')
    forecasts: List[ForecastDay] = Field(..., alias='forecasts')
