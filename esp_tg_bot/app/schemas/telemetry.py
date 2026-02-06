from pydantic import BaseModel, Field, validator
from typing import Optional
from datetime import datetime

class TelemetryData(BaseModel):
    """Модель телеметрии от устройства"""
    device_id: str = Field(..., description="ID устройства")
    temperature: float = Field(..., description="Температура в °C")
    humidity: float = Field(..., description="Влажность в %")
    free_memory: Optional[int] = Field(None, description="Свободная память в байтах")
    uptime: Optional[int] = Field(None, description="Время работы в секундах")
    timestamp: datetime = Field(default_factory=datetime.now, description="Время отправки")
    bluetooth_is_active: Optional[bool] = Field(None, description="Статус Bluetooth соединения")
    
    def to_dict(self):
        """Конвертация в словарь для логирования"""
        return {
            'device_id': self.device_id,
            'temperature': f"{self.temperature}°C",
            'humidity': f"{self.humidity}%",
            'free_memory': f"{self.free_memory:,} bytes" if self.free_memory else None,
            'uptime': f"{self.uptime} sec" if self.uptime else None,
            'timestamp': self.timestamp.isoformat(),
            'bluetooth_is_active': self.bluetooth_is_active
        }