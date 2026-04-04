"""Схемы для управления камерами и видеозаписью"""
from pydantic import BaseModel, Field
from datetime import datetime
from typing import Optional, List
from enum import Enum


class CameraModeEnum(str, Enum):
    """Режимы работы камеры"""
    MANUAL = "manual"
    AUTO = "auto"
    IDLE = "idle"


class CameraState(BaseModel):
    """Полное состояние камеры (объединяет режим и статистику)"""
    # Режим работы
    mode: CameraModeEnum = CameraModeEnum.IDLE
    start_time: datetime = Field(default_factory=datetime.now)
    active: bool = False
    
    # Статистика потока
    last_frame: Optional[bytes] = None
    fps: int = 0
    reported_fps: int = 0
    quality_mode: Optional[int] = None
    last_time: float = 0.0  # Время последнего обновления FPS
    frame_count: int = 0     # Счетчик кадров за период

    class Config:
        arbitrary_types_allowed = True
        validate_assignment = True


# Алиасы для обратной совместимости
CameraMode = CameraState
CameraStats = CameraState


class ViewerConnectionInfo(BaseModel):
    """Информация о подключении зрителя"""
    websocket_id: str
    connected_at: float
    camera_id: str
    
    class Config:
        arbitrary_types_allowed = True
        validate_assignment = True


class RecordingMetadata(BaseModel):
    """Метаданные записи видео"""
    end_time: datetime
    frames: int
    fps: float

    class Config:
        validate_assignment = True


class VideoRecorder(BaseModel):
    """Состояние активной записи видео"""
    camera_id: str
    buffer: List[bytes] = Field(default_factory=list)
    buffer_size_bytes: int = 0  # Общий размер буфера в байтах
    start_time: datetime = Field(default_factory=datetime.now)
    is_recording: bool = False
    max_duration: int = 30
    stop_task_id: Optional[int] = None  # ID асинхронного таска (из id() функции)
    last_activity_time: float = Field(default_factory=lambda: datetime.now().timestamp())  # Время последнего события двери

    class Config:
        arbitrary_types_allowed = True
        validate_assignment = True


class RecordingInfo(BaseModel):
    """Информация о текущей записи (для статуса)"""
    is_recording: bool
    duration_seconds: int
    frames: int
    max_duration: int

    class Config:
        validate_assignment = True


class CameraStatus(BaseModel):
    """Полный статус камеры"""
    fps: int
    reported_fps: int
    quality_mode: Optional[int] = None
    viewers: int
    last_frame_size: int
    connected: bool
    recording: Optional[RecordingInfo] = None
    camera_is_active: bool = False
    record_is_active: bool = False

    class Config:
        validate_assignment = True


class CameraControlResponse(BaseModel):
    """Ответ на команду управления камерой"""
    status: str
    camera: str
    message: Optional[str] = None
    error: Optional[str] = None
    reason: Optional[str] = None

    class Config:
        validate_assignment = True


class ResolutionCommand(BaseModel):
    """Команда для изменения разрешения"""
    camera_id: str
    resolution: str  # QVGA, VGA, HD
    access_key: Optional[str] = None

    class Config:
        validate_assignment = True
