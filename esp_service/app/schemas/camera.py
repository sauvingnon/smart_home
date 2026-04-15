from pydantic import BaseModel, Field
from datetime import datetime
from typing import Optional
from enum import Enum

class CameraMode(str, Enum):
    NEVER_CONNECTED = "never_connected"   # ни разу не подключалась
    CONNECTED = "connected"               # WS есть, стрим выключен
    STREAMING = "streaming"               # стрим активен

class CameraMetrics(BaseModel):
    """Текущие метрики камеры (обновляются из fps: сообщений)"""
    fps: int = 0
    quality_mode: int = 1   # 0=QVGA, 1=VGA, 2=HD
    temperature: float = 0.0
    is_streaming: bool = False   # флаг из прошивки
    is_recording: bool = False
    fan: bool = False
    last_metrics_time: datetime = Field(default_factory=datetime.now)

class CameraState(BaseModel):
    """Полное состояние камеры на сервере"""
    camera_id: str
    mode: CameraMode = CameraMode.NEVER_CONNECTED
    connected_at: Optional[datetime] = None
    last_seen: datetime = Field(default_factory=datetime.now)  # время последнего ANY сообщения
    metrics: CameraMetrics = Field(default_factory=CameraMetrics)