from typing import List, Optional

from pydantic import BaseModel


class ChatMessageOut(BaseModel):
    """Одно сообщение в общем чате."""
    seq: int
    user_id: int
    username: str
    type: str  # "text" | "image" | "audio" | "video" | "system"
    text: str
    media_key: str
    media_kind: str  # "" | "circle" (видео-кружок)
    # Превью для ленты: у video — первый кадр (свой аплоад или шаринг с камеры),
    # у image — уменьшенная копия, которую кодирует клиент. Оригинал в ленту не
    # тянем, он нужен только в лайтбоксе.
    thumbnail_key: str = ""
    # Геометрия кадра (только image) — чтобы пузырь встал в правильных
    # пропорциях ещё до того, как приедут байты. 0 у сообщений, записанных до
    # появления полей: для них рамка остаётся прежнего фиксированного размера.
    media_w: int = 0
    media_h: int = 0
    # Крошка-заглушка: 16px кадр data-URI'ем в самом сообщении. Приезжает по WS
    # вместе с сообщением и рисуется размытым пятном, пока из S3 едет превью.
    media_preview: str = ""
    ts: str
    # Ответ на сообщение. Автор и текст цитаты лежат снимком прямо здесь —
    # исходник может быть уже удалён или вне подгруженной страницы истории.
    # Дефолты нужны и для сообщений, записанных до появления ответов/правок.
    reply_to: Optional[int] = None
    reply_to_username: str = ""
    reply_to_preview: str = ""
    edited_at: Optional[str] = None
    # Только у type=="system": "pinned" | "unpinned". user_id/username — кто
    # закрепил/открепил, reply_to/reply_to_preview (снимок, тот же механизм,
    # что у ответов) — какое сообщение.
    system_kind: str = ""


class ChatMessagesResponse(BaseModel):
    messages: List[ChatMessageOut]


class ReadReceiptOut(BaseModel):
    user_id: int
    display_name: str
    last_read_seq: int
    read_at: Optional[str] = None


class ReadReceiptsResponse(BaseModel):
    reads: List[ReadReceiptOut]


class MarkReadResponse(BaseModel):
    user_id: int
    seq: int
    at: str


class UnreadCountResponse(BaseModel):
    unread_count: int


class PushSubscriptionKeys(BaseModel):
    p256dh: str
    auth: str


class PushSubscriptionIn(BaseModel):
    """Ровно то, что отдаёт PushSubscription.toJSON() в браузере."""
    endpoint: str
    keys: PushSubscriptionKeys


class VapidPublicKeyResponse(BaseModel):
    public_key: str


class ShareVideoIn(BaseModel):
    camera_id: str
    video_id: str


class PinMessageIn(BaseModel):
    seq: int


class EditMessageIn(BaseModel):
    text: str


class PinnedMessageResponse(BaseModel):
    message: Optional[ChatMessageOut] = None


class PushStatusEntry(BaseModel):
    user_id: int
    display_name: str
    subscribed: bool


class PushStatusResponse(BaseModel):
    statuses: List[PushStatusEntry]


class PresenceEntry(BaseModel):
    user_id: int
    display_name: str
    online: bool
    last_seen: Optional[str] = None


class PresenceResponse(BaseModel):
    entries: List[PresenceEntry]
