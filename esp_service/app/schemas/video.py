from typing import Dict, List, Optional

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
    recognition_error: Optional[bool] = None  # True = не смогли проверить статус (Redis/S3 упали) — не путать с "ещё не обработано"
    direction: Optional[str] = None  # "entering" | "exiting" | "nothing"; None = ещё не обработано
    direction_low_confidence: Optional[bool] = None  # True = вердикт вблизи порога, не доверять слепо


class VideoNotifyPrefs(BaseModel):
    """Какие видео-события юзер хочет получать пушем. Один и тот же push-канал,
    что и у чата (см. /chat/push/*) — тут только предпочтения по темам."""
    visit_people: Dict[str, bool] = {}  # label -> уведомлять о его посещении
    board_offline: bool = True  # центральная плата (камера) недоступна


class NotifyRecognizedIn(BaseModel):
    """Кто узнан на только что обработанном видео — присылает recognition_worker
    сразу после распознавания (см. POST /esp_service/internal/notify_recognized)."""
    present: List[str] = []
