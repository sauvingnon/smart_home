# app/api/endpoints/chat.py
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, WebSocket

from app.core.auth import get_current_user_id_dep
from app.core.worker import BackgroundWorker
from app.schemas.chat import (
    ChatMessageOut,
    ChatMessagesResponse,
    MarkReadResponse,
    PushSubscriptionIn,
    ReadReceiptsResponse,
    UnreadCountResponse,
    VapidPublicKeyResponse,
)
from config import VAPID_PUBLIC_KEY

router = APIRouter(prefix="/chat", tags=["chat"])


@router.websocket("/ws")
async def chat_websocket(websocket: WebSocket):
    """Реалтайм-канал чата (message/read/ping события). Авторизация внутри
    подключения — тот же паттерн, что у зрительского WS камеры."""
    worker = BackgroundWorker.get_instance()
    await worker.chat_service.handle_ws(websocket)


@router.post("/messages", response_model=ChatMessageOut)
async def send_message(
    type: str = Form(...),
    text: Optional[str] = Form(None),
    media_kind: Optional[str] = Form(None),
    file: Optional[UploadFile] = File(None),
    user_id: int = Depends(get_current_user_id_dep),
):
    """Отправить сообщение (текст и/или медиафайл). Кодирование медиа — на клиенте,
    сервер только сохраняет в Garage и рассылает по WS."""
    worker = BackgroundWorker.get_instance()

    media_bytes = await file.read() if file else None
    content_type = file.content_type if file else None

    try:
        message = await worker.chat_service.send_message(
            user_id=user_id,
            msg_type=type,
            text=text,
            media_bytes=media_bytes,
            content_type=content_type,
            media_kind=media_kind,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))

    return message


@router.get("/messages", response_model=ChatMessagesResponse)
async def list_messages(
    before_seq: Optional[int] = Query(None, description="Пагинация: сообщения до этого seq"),
    limit: int = Query(50, ge=1, le=200),
    user_id: int = Depends(get_current_user_id_dep),
):
    worker = BackgroundWorker.get_instance()
    messages = await worker.chat_service.get_messages(before_seq=before_seq, limit=limit)
    return {"messages": messages}


@router.post("/read", response_model=MarkReadResponse)
async def mark_read(user_id: int = Depends(get_current_user_id_dep)):
    """Отметить чат прочитанным по последнее на данный момент сообщение."""
    worker = BackgroundWorker.get_instance()
    return await worker.chat_service.mark_read(user_id)


@router.get("/read_states", response_model=ReadReceiptsResponse)
async def read_states(user_id: int = Depends(get_current_user_id_dep)):
    """Read-позиция каждого юзера — фронт сам вычисляет 'кем и когда прочитано'
    для любого сообщения сравнением его seq с last_read_seq."""
    worker = BackgroundWorker.get_instance()
    reads = await worker.chat_service.get_read_states()
    return {"reads": reads}


@router.get("/unread_count", response_model=UnreadCountResponse)
async def unread_count(user_id: int = Depends(get_current_user_id_dep)):
    worker = BackgroundWorker.get_instance()
    count = await worker.chat_service.get_unread_count(user_id)
    return {"unread_count": count}


@router.get("/media/{media_key:path}")
async def get_media_url(media_key: str, user_id: int = Depends(get_current_user_id_dep)):
    """Presigned URL на файл медиа чата (авторизация проверяется здесь, до выдачи URL)."""
    worker = BackgroundWorker.get_instance()
    url = await worker.chat_service.get_media_url(media_key)
    if not url:
        raise HTTPException(status_code=404, detail="Медиа не найдено")
    return {"url": url}


@router.get("/push/vapid_public_key", response_model=VapidPublicKeyResponse)
async def get_vapid_public_key():
    """Публичный VAPID-ключ для подписки через PushManager на клиенте."""
    if not VAPID_PUBLIC_KEY:
        raise HTTPException(status_code=503, detail="Push не настроен на сервере")
    return {"public_key": VAPID_PUBLIC_KEY}


@router.post("/push/subscribe")
async def subscribe_push(
    subscription: PushSubscriptionIn,
    user_id: int = Depends(get_current_user_id_dep),
):
    """Сохранить подписку браузера — одна подписка на юзера, новая перезаписывает старую."""
    worker = BackgroundWorker.get_instance()
    await worker.cache.save_push_subscription(user_id, subscription.model_dump())
    return {"status": "ok"}


@router.post("/push/unsubscribe")
async def unsubscribe_push(user_id: int = Depends(get_current_user_id_dep)):
    worker = BackgroundWorker.get_instance()
    await worker.cache.delete_push_subscription(user_id)
    return {"status": "ok"}
