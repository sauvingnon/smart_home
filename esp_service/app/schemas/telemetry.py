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
    
    def to_dict(self):
        """Конвертация в словарь для логирования"""
        return {
            'device_id': self.device_id,
            'temperature': f"{self.temperature}°C",
            'humidity': f"{self.humidity}%",
            'free_memory': f"{self.free_memory:,} bytes" if self.free_memory else None,
            'uptime': f"{self.uptime} sec" if self.uptime else None,
            'timestamp': self.timestamp.isoformat(),
        }
    
    def to_str(self) -> str:
        """Повествовательное строковое представление телеметрии"""
        description = f"Получены текущие данные телеметрии платы умного дома: "
        description += f"температура {self.temperature:.1f}°C, влажность {self.humidity:.1f}%"
        
        
        if self.uptime is not None:
            hours = self.uptime // 3600
            minutes = (self.uptime % 3600) // 60
            if hours > 0 and minutes > 0:
                description += f", время работы {hours} ч {minutes} мин"
            elif hours > 0:
                description += f", время работы {hours} ч"
            else:
                description += f", время работы {minutes} мин"
        
        description += f" (данные от {self.timestamp.strftime('%d.%m.%Y %H:%M')})"
        
        return description