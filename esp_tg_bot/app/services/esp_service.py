# services/ai_service/ai_service.py

from app.services.client import client
from typing import Optional
from app.schemas.telemetry import TelemetryData
from app.schemas.settings import SettingsData
import httpx
from logger import logger

entity_schema = "esp_service"

async def get_telemetry() -> Optional[TelemetryData]:
    """
    Получить телеметрию устройства через API.
    
    Returns:
        TelemetryData или None, если данные отсутствуют
    """
    try:
        response = await client.get(f"/{entity_schema}/telemetry")
        
        if response.status_code == 404:
            # Данных еще нет
            return None
            
        response.raise_for_status()
        
        data = response.json()
        return TelemetryData(**data)
        
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404:
            return None
        raise
    except Exception as e:
        # Логируем ошибку, но не падаем
        logger.exception(f"Ошибка получения телеметрии: {e}")
        return None
    
async def get_settings() -> Optional[SettingsData]:
    """
    Получить настройки устройства через API.
    
    Returns:
        SettingsData или None, если данные отсутствуют
    """
    try:
        response = await client.get(f"/{entity_schema}/settings")
        
        if response.status_code == 404:
            # Данных еще нет
            return None
            
        response.raise_for_status()
        
        data = response.json()
        return SettingsData(**data)
        
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404:
            return None
        raise
    except Exception as e:
        # Логируем ошибку, но не падаем
        logger.exception(f"Ошибка получения настроек: {e}")
        return None

async def set_settings(settings: SettingsData) -> Optional[bool]:
    """
    Установить настройки устройства через API.
    
    Args:
        settings: объект SettingsData с настройками
    
    Returns:
        bool (успех/неудача) или None при критической ошибке
    """
    try:
        # Конвертируем настройки в словарь для отправки
        settings_dict = settings.model_dump()
        
        # Отправляем POST запрос с настройками в теле
        response = await client.post(
            f"/{entity_schema}/settings",
            json=settings_dict  # FastAPI автоматически сериализует
        )
        
        # Проверяем статус ответа
        if response.status_code == 200:
            logger.info(f"✅ Настройки успешно отправлены на сервер")
            return True
        elif response.status_code == 404:
            logger.warning("⚠️  Endpoint настроек не найден")
            return None
        else:
            logger.error(f"❌ Ошибка отправки настроек: {response.status_code}")
            response.raise_for_status()
            return False
            
    except httpx.HTTPStatusError as e:
        logger.error(f"❌ HTTP ошибка при отправке настроек: {e}")
        if e.response.status_code == 404:
            return None
        return False
    except Exception as e:
        logger.exception(f"❌ Неожиданная ошибка при отправке настроек: {e}")
        return None
