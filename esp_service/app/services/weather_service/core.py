from app.services.weather_service.yandex_weather import WeatherService
from app.services.weather_service.adapter import WeatherAdapter
from config import YANDEX_WEATHER_API_KEY

service = WeatherService(api_key=YANDEX_WEATHER_API_KEY)


def get_forecast() -> WeatherAdapter:
    return service.get_mock_forecast()