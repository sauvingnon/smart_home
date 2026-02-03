# АДАПТЕР (вечный интерфейс)

from pydantic import BaseModel
from typing import Optional
from datetime import datetime
from app.services.weather_service.schemas import YandexResponse, ForecastDay, ForecastPart, FactData

class WeatherAdapter(BaseModel):
    """Адаптер для работы с погодными данными"""
    
    # Наш универсальный интерфейс (не зависит от провайдера)
    current_temp: int
    current_feels_like: int
    current_condition: str
    current_wind: float
    current_humidity: int
    
    evening_temp: Optional[int]
    evening_condition: str
    
    night_temp: Optional[int]
    night_condition: str
    
    tomorrow_temp: Optional[int]
    tomorrow_condition: str
    tomorrow_temp_range: str
    
    # Метаданные
    provider: str = "yandex"
    timestamp: datetime
    
    @classmethod
    def from_yandex(self, data: YandexResponse) -> "WeatherAdapter":
        """Фабричный метод для создания адаптера из данных Яндекса"""
        
        # Текущая погода
        fact = data.fact
        
        # Прогноз на сегодня
        today = data.forecasts[0]
        evening = ForecastPart(**today.parts['evening']) if 'evening' in today.parts else None
        night = ForecastPart(**today.parts['night']) if 'night' in today.parts else None
        
        # Прогноз на завтра
        tomorrow = None
        if len(data.forecasts) > 1:
            tomorrow_day = ForecastPart(**data.forecasts[1].parts['day']) if 'day' in data.forecasts[1].parts else None
            tomorrow = tomorrow_day
        
        return self(
            # Сейчас
            current_temp=fact.temp,
            current_feels_like=fact.feels_like,
            current_condition=fact.condition,
            current_wind=fact.wind_speed,

            current_humidity=fact.humidity,
            
            # Вечер
            evening_temp=evening.temp_avg if evening else None,
            evening_condition=evening.condition if evening else "нет данных",
            
            # Ночь
            night_temp=night.temp_avg if night else None,
            night_condition=night.condition if night else "нет данных",
            
            # Завтра
            tomorrow_temp=tomorrow.temp_avg if tomorrow else None,
            tomorrow_condition=tomorrow.condition if tomorrow else "нет данных",
            tomorrow_temp_range=f"{tomorrow.temp_min}-{tomorrow.temp_max}" if tomorrow and tomorrow.temp_min and tomorrow.temp_max else "",
            
            timestamp=data.now_dt
        )