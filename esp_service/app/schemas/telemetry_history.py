from pydantic import BaseModel, Field, validator
from datetime import datetime
from typing import Optional, List

class TelemetryRecord(BaseModel):
    """Одна запись телеметрии"""
    timestamp: datetime = Field(..., description="Время замера")
    temp_in: Optional[float] = Field(None, description="Температура внутри, °C")
    hum_in: Optional[float] = Field(None, description="Влажность внутри, %")
    temp_out: Optional[float] = Field(None, description="Температура снаружи, °C")
    hum_out: Optional[float] = Field(None, description="Влажность снаружи, %")
    device_id: str = Field(..., description="ID устройства")

class HistoryResponse(BaseModel):
    """Ответ с историей телеметрии"""
    period_hours: int = Field(..., description="Запрошенный период в часах")
    records_count: int = Field(..., description="Количество записей")
    records: List[TelemetryRecord] = Field(..., description="Записи телеметрии")

class StatsResponse(BaseModel):
    """Статистика за период"""
    period_hours: int = Field(..., description="Запрошенный период в часах")
    
    # Общая статистика
    total_records: int = Field(..., description="Всего записей")
    esp_records: int = Field(..., description="Записей с ESP")
    weather_records: int = Field(..., description="Записей с погодного API")
    
    # Внутренние датчики
    avg_temp_in: Optional[float] = Field(None, description="Средняя температура внутри")
    min_temp_in: Optional[float] = Field(None, description="Минимальная температура внутри")
    max_temp_in: Optional[float] = Field(None, description="Максимальная температура внутри")
    
    avg_hum_in: Optional[float] = Field(None, description="Средняя влажность внутри")
    min_hum_in: Optional[float] = Field(None, description="Минимальная влажность внутри")
    max_hum_in: Optional[float] = Field(None, description="Максимальная влажность внутри")
    
    # Уличные датчики
    avg_temp_out: Optional[float] = Field(None, description="Средняя температура снаружи")
    min_temp_out: Optional[float] = Field(None, description="Минимальная температура снаружи")
    max_temp_out: Optional[float] = Field(None, description="Максимальная температура снаружи")

# Модель для сырых данных из БД
class RawStats(BaseModel):
    total_records: int = 0
    esp_records: int = 0
    weather_records: int = 0
    
    avg_temp_in: Optional[float] = None
    min_temp_in: Optional[float] = None
    max_temp_in: Optional[float] = None
    
    avg_hum_in: Optional[float] = None
    min_hum_in: Optional[float] = None
    max_hum_in: Optional[float] = None
    
    avg_temp_out: Optional[float] = None
    min_temp_out: Optional[float] = None
    max_temp_out: Optional[float] = None
    
    @validator('*', pre=True)
    def handle_null(cls, v):
        """SQLite может вернуть None как 0 или пустую строку"""
        if v == 0 and cls.current_field in ['avg_', 'min_', 'max_']:
            # Проверяем, действительно ли это 0 или просто отсутствие данных
            return None
        return v