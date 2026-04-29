from pydantic import BaseModel, Field
from datetime import datetime
from typing import Optional
from enum import Enum

class CameraMode(str, Enum):
    NEVER_CONNECTED = "never_connected"   # ни разу не подключалась
    OFFLINE = "offline"                   # нет WS
    CONNECTED = "connected"               # WS есть, стрим выключен, запись выключеа
    STREAMING = "streaming"               # стрим активен
    RECORDING = "recording"               # запись активна

class CameraMetrics(BaseModel):
    """Текущие метрики камеры (обновляются из fps: сообщений)"""
    fps: int = 0
    quality_mode: int = 1   # 0=QVGA, 1=VGA, 2=HD
    temperature: float = 0.0
    is_streaming: bool = False
    is_recording: bool = False
    is_fan_active: bool = False
    free_heap: int = 0
    last_metrics_time: datetime = Field(default_factory=datetime.now)

class CameraState(BaseModel):
    """Полное состояние камеры на сервере"""
    camera_id: str
    mode: CameraMode = CameraMode.NEVER_CONNECTED
    connected_at: Optional[datetime] = None
    viewers: int = 0
    last_seen: datetime = Field(default_factory=datetime.now)  # время последнего ANY сообщения
    metrics: CameraMetrics = Field(default_factory=CameraMetrics)