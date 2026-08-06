from typing import List, Optional

from pydantic import BaseModel


class VideoItem(BaseModel):
    """Одно видео в ответе GET /esp_service/videos"""
    key: str
    video_id: Optional[str] = None
    video_url: str
    thumbnail_url: Optional[str] = None
    size_bytes: int
    last_modified: str
    camera_id: str
    duration_seconds: Optional[int] = None
    start_time: Optional[str] = None
    recognized: Optional[List[str]] = None  # кто распознан на видео; None = ещё не обработано
