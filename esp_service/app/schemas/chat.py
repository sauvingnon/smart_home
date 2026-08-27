from typing import List, Optional

from pydantic import BaseModel


class ChatMessageOut(BaseModel):
    """Одно сообщение в общем чате."""
    seq: int
    user_id: int
    username: str
    type: str  # "text" | "image" | "audio" | "video"
    text: str
    media_key: str
    media_kind: str  # "" | "circle" (видео-кружок)
    ts: str


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


class PinnedMessageResponse(BaseModel):
    message: Optional[ChatMessageOut] = None


class PushStatusEntry(BaseModel):
    user_id: int
    display_name: str
    subscribed: bool


class PushStatusResponse(BaseModel):
    statuses: List[PushStatusEntry]
