# СЕРВИС (тонкий слой)

import requests
from typing import Optional
from app.services.weather_service.schemas import YandexResponse
from app.services.weather_service.adapter import WeatherAdapter
from logger import logger
from datetime import datetime

class WeatherService:
    """Тонкий сервис для получения данных"""
    
    def __init__(self, api_key: str):
        self.api_key = api_key
        self.base_url = "https://api.weather.yandex.ru/v2/forecast"
    
    def _get_yandex_data(self, lat: float, lon: float) -> Optional[YandexResponse]:
        """Получаем сырые данные от Яндекса"""
        headers = {'X-Yandex-Weather-Key': self.api_key}
        params = {'lat': lat, 'lon': lon, 'lang': 'ru_RU', 'limit': 2}
        
        try:
            response = requests.get(self.base_url, headers=headers, params=params, timeout=10)
            response.raise_for_status()
            return YandexResponse(**response.json())
        except Exception as e:
            logger.exception(f"Ошибка API: {e}")
            return None
        
    def get_mock_forecast(self) -> WeatherAdapter:
        """Мок-метод для тестирования без API"""
        
        # Создаем адаптер напрямую с тестовыми данными
        return WeatherAdapter(
            # Сейчас
            current_temp=7,
            current_feels_like=4,
            current_condition="overcast",
            current_wind=3.0,
            
            # Вечер
            evening_temp=7,
            evening_condition="light-rain",
            
            # Ночь
            night_temp=2,
            night_condition="wet-snow",
            
            # Завтра
            tomorrow_temp=9,
            tomorrow_condition="light-rain",
            tomorrow_temp_range="8-10",
            
            # Метаданные
            provider="yandex",
            timestamp=datetime.now(),
            
            # Опциональные поля (можно добавить по необходимости)
            current_humidity=85,
            current_pressure=755,
            evening_wind=4.5,
            night_wind=8.0,
            tomorrow_wind=4.3
        )
    
    def get_forecast(self, lat: float, lon: float) -> Optional[WeatherAdapter]:
        """Основной метод: получаем данные и адаптируем"""
        raw_data = self._get_yandex_data(lat, lon)
        if not raw_data:
            return None
        
        return WeatherAdapter.from_yandex(raw_data)