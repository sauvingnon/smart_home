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


class NotifyPrefs(BaseModel):
    """По каким темам юзер хочет пуш. Push-подписка на устройство одна общая
    (см. /chat/push/*) — она и есть мастер-выключатель; здесь только темы под
    ним. Раньше звалось VideoNotifyPrefs, но чат сюда тоже приехал: в UI это
    один экран, и разделение на "видео-темы" и "чат-темы" было выдумкой.

    chat_messages по умолчанию True: у тех, кто подписался до появления поля,
    в Redis его нет, и опт-аут по умолчанию молча выключил бы им чат.

    chat_reactions переключателя в UI пока не имеет намеренно — поле заведено
    заранее, чтобы включение настройки свелось к дописыванию строки-тумблера в
    ProfilePage, а не к заведению поля с нуля и миграции уже сохранённых prefs.
    Живёт под chat_messages, а не рядом: реакция — это событие в чате, и
    выключивший чат целиком не должен получать пуши о нём с другой стороны
    (см. ChatService._push_reaction)."""
    visit_people: Dict[str, bool] = {}  # label -> уведомлять о его посещении
    board_offline: bool = False  # центральная плата (камера) недоступна
    chat_messages: bool = True  # новые сообщения в чате
    chat_reactions: bool = True  # реакции на твои сообщения (пока без UI)


class NotifyRecognizedIn(BaseModel):
    """Кто узнан на только что обработанном видео — присылает recognition_worker
    сразу после распознавания (см. POST /esp_service/internal/notify_recognized)."""
    present: List[str] = []
