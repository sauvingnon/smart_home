# schemas/settings.py
from pydantic import BaseModel, Field
from typing import Optional

class SettingsData(BaseModel):
    """
    Точная копия структуры SettingsData с платы.
    """
    
    # Режим экрана (0-постоянный, 1-авто, 2-умный)
    displayMode: int = Field(default=1, ge=0, le=2, description="Режим экрана: 0-постоянный, 1-авто, 2-умный")
    
    # Дневное реле расписание
    dayOnHour: int = Field(default=8, ge=0, le=23, description="Час включения дневного реле")
    dayOnMinute: int = Field(default=0, ge=0, le=59, description="Минута включения дневного реле")
    dayOffHour: int = Field(default=22, ge=0, le=23, description="Час выключения дневного реле")
    dayOffMinute: int = Field(default=0, ge=0, le=59, description="Минута выключения дневного реле")
    
    # Ночное реле расписание  
    nightOnHour: int = Field(default=22, ge=0, le=23, description="Час включения ночного реле")
    nightOnMinute: int = Field(default=0, ge=0, le=59, description="Минута включения ночного реле")
    nightOffHour: int = Field(default=8, ge=0, le=23, description="Час выключения ночного реле")
    nightOffMinute: int = Field(default=0, ge=0, le=59, description="Минута выключения ночного реле")
    
    # Уборная расписание
    toiletOnHour: int = Field(default=8, ge=0, le=23, description="Час включения уборной")
    toiletOnMinute: int = Field(default=0, ge=0, le=59, description="Минута включения уборной")
    toiletOffHour: int = Field(default=20, ge=0, le=23, description="Час выключения уборной")
    toiletOffMinute: int = Field(default=0, ge=0, le=59, description="Минута выключения уборной")
    
    # Режим работы реле (false=авто, true=ручной)
    relayMode: bool = Field(default=False, description="Режим реле: False=авто, True=ручной")
    
    # Ручное состояние (только если relayMode=true)
    manualDayState: bool = Field(default=False, description="Ручное состояние дневного реле")
    manualNightState: bool = Field(default=False, description="Ручное состояние ночного реле")
    
    # Время горения дисплея (секунды)
    displayTimeout: int = Field(default=30, ge=0, le=3600, description="Таймаут дисплея в секундах")
    # Время отображения каждого режима (секунды)
    displayChangeModeTimeout: int = Field(default=30, ge=0, le=3600, description="Таймаут смены режимов в секундах")
    
    # Вентилятор
    fanDelay: int = Field(default=60, ge=0, description="Задержка вентилятора в секундах")
    fanDuration: int = Field(default=5, ge=0, description="Длительность работы вентилятора в минутах")
    
    # Интернет
    offlineModeActive: bool = Field(default=False, description="Оффлайн режим")

    # Показывать экран прогноза погоды
    showForecastScreen: bool = Field(default=False, description="Отображение прогноза погоды")

    # Показывать экран датчиков
    showTempScreen: bool = Field(default=False, description="Отображение данных с датчиков")