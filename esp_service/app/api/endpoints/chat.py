# app/api/endpoints/chat.py
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile, WebSocket
from fastapi.responses import StreamingResponse

from app.core.auth import get_current_user_id_dep
from app.core.worker import BackgroundWorker
from app.schemas.chat import (
    ChatMessageOut,
    ChatMessagesResponse,
    EditMessageIn,
    MarkReadResponse,
    PinMessageIn,
    PinnedMessageResponse,
    PresenceResponse,
    PushStatusResponse,
    PushSubscriptionIn,
    ReadReceiptsResponse,
    ShareVideoIn,
    UnreadCountResponse,
    VapidPublicKeyResponse,
)
from app.utils.time import format_ru_datetime, parse_video_key_datetime
from config import VAPID_PUBLIC_KEY

router = APIRouter(prefix="/chat", tags=["chat"])


@router.websocket("/ws")
async def chat_websocket(websocket: WebSocket):
    """Реалтайм-канал чата (message/read/pinned/presence/typing/ping события).
    Авторизация внутри подключения — тот же паттерн, что у зрительского WS камеры."""
    worker = BackgroundWorker.get_instance()
    await worker.chat_service.handle_ws(websocket)


@router.get("/presence", response_model=PresenceResponse)
async def get_presence(user_id: int = Depends(get_current_user_id_dep)):
    """Онлайн/офлайн + last_seen каждого юзера — для начальной отрисовки шапки
    чата, до того как WS доставит первый presence_snapshot."""
    worker = BackgroundWorker.get_instance()
    entries = await worker.chat_service.get_presence_snapshot()
    return {"entries": entries}


@router.post("/messages", response_model=ChatMessageOut)
async def send_message(
    type: str = Form(...),
    text: Optional[str] = Form(None),
    media_kind: Optional[str] = Form(None),
    reply_to: Optional[int] = Form(None),
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
            reply_to=reply_to,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))

    return message


@router.post("/share_video", response_model=ChatMessageOut)
async def share_video(
    payload: ShareVideoIn,
    user_id: int = Depends(get_current_user_id_dep),
):
    """Переслать видео с камеры в чат — без повторной загрузки, только ссылка
    на существующий объект в S3. Ключ резолвим сами на сервере (не доверяем
    строке от клиента), чтобы через чат нельзя было подсунуть произвольный
    S3-путь."""
    worker = BackgroundWorker.get_instance()

    video_key = await worker.video_service.resolve_video_key(payload.camera_id, payload.video_id)
    if not video_key:
        raise HTTPException(status_code=404, detail="Видео не найдено")

    thumbnail_key = f"thumbnails/{payload.camera_id}/{payload.video_id}.jpg"

    names = await worker.video_service.get_recognized_names(payload.camera_id, payload.video_id)
    text = ""
    if names:
        users = await worker.cache.list_users()
        display_by_username = {u["username"]: u["display_name"] for u in users}
        video_dt = parse_video_key_datetime(video_key)
        date_line = f"Видео от {format_ru_datetime(video_dt)}\n" if video_dt else ""
        text = date_line + "Распознаны лица: " + ", ".join(display_by_username.get(name, name) for name in names)

    message = await worker.chat_service.share_video(
        user_id=user_id, video_key=video_key, thumbnail_key=thumbnail_key, text=text,
    )
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


@router.post("/pin", response_model=ChatMessageOut)
async def pin_message(
    payload: PinMessageIn,
    user_id: int = Depends(get_current_user_id_dep),
):
    """Закрепить сообщение — один слот на чат, новое закрепление заменяет старое."""
    worker = BackgroundWorker.get_instance()
    try:
        message = await worker.chat_service.pin_message(user_id, payload.seq)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return message


@router.post("/unpin")
async def unpin_message(user_id: int = Depends(get_current_user_id_dep)):
    worker = BackgroundWorker.get_instance()
    await worker.chat_service.unpin_message(user_id)
    return {"status": "ok"}


@router.patch("/messages/{seq}", response_model=ChatMessageOut)
async def edit_message(
    seq: int,
    payload: EditMessageIn,
    user_id: int = Depends(get_current_user_id_dep),
):
    """Поправить текст своего сообщения. Автора, тип и срок проверяет сервис —
    403, если чужое, не текстовое или просрочено. ValueError тут отдаём как 400,
    а не 404 как у удаления: и пустой текст, и мёртвый seq (сообщение успели
    удалить) — это несостоятельный запрос клиента, а не отсутствующий ресурс."""
    worker = BackgroundWorker.get_instance()
    try:
        return await worker.chat_service.edit_message(user_id, seq, payload.text)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/messages/{seq}")
async def delete_message(
    seq: int,
    user_id: int = Depends(get_current_user_id_dep),
):
    """Удалить своё сообщение, если ему меньше часа. Автора и срок проверяет
    сервис — 403, если чужое или просрочено."""
    worker = BackgroundWorker.get_instance()
    try:
        await worker.chat_service.delete_message(user_id, seq)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {"status": "ok"}


@router.get("/pinned", response_model=PinnedMessageResponse)
async def get_pinned(user_id: int = Depends(get_current_user_id_dep)):
    """Текущее закреплённое сообщение (или null) — для начальной загрузки,
    до того как WS доставит событие pinned/unpinned."""
    worker = BackgroundWorker.get_instance()
    message = await worker.chat_service.get_pinned_message()
    return {"message": message}


@router.get("/push/status", response_model=PushStatusResponse)
async def push_status(user_id: int = Depends(get_current_user_id_dep)):
    """Кто из юзеров сейчас подписан на Web Push.
    НАДО ПЕРЕИСПОЛЬЗОВАТЬ — баннер "Уведомления получат" убрали из ChatPage,
    но эндпоинт не мёртвый: понадобится в другом месте, не удалять."""
    worker = BackgroundWorker.get_instance()
    statuses = await worker.chat_service.get_push_status()
    return {"statuses": statuses}


@router.get("/media/{media_key:path}")
async def get_media(
    media_key: str,
    request: Request,
    user_id: int = Depends(get_current_user_id_dep),
):
    """Стримит медиафайл чата байтами через бэкенд — тот же паттерн, что у
    /esp_service/videos/stream. Garage/S3 никогда не выставляется наружу."""
    worker = BackgroundWorker.get_instance()
    s3 = worker.chat_service.s3

    content_type = await s3.get_object_content_type(media_key)
    if not content_type:
        raise HTTPException(status_code=404, detail="Медиа не найдено")

    range_header = request.headers.get("range")
    start, end = 0, None
    if range_header:
        try:
            range_start, _, range_end = range_header.replace("bytes=", "").partition("-")
            if range_start == "":
                # Suffix-range ("bytes=-500" — последние 500 байт файла), а не
                # обычный "от X до Y": без размера объекта его не разрешить,
                # плоский int(parts[0] or 0) тут молча читал бы файл с начала.
                suffix_length = int(range_end)
                size = await s3.get_object_size(media_key)
                start = max(0, size - suffix_length) if size else 0
            else:
                start = int(range_start)
                end = int(range_end) if range_end else None
        except Exception:
            pass

    stream, file_size, actual_end = await s3.stream_range(media_key, start, end)
    if not stream:
        raise HTTPException(status_code=404, detail="Медиа не найдено")

    headers = {
        "Accept-Ranges": "bytes",
        "Content-Length": str(actual_end - start + 1),
        "Cache-Control": "private, max-age=3600",
    }
    status_code = 200
    if range_header:
        status_code = 206
        headers["Content-Range"] = f"bytes {start}-{actual_end}/{file_size}"

    return StreamingResponse(stream, status_code=status_code, media_type=content_type, headers=headers)


@router.post("/push/test")
async def test_push():
    """Тестовая отправка пуша самому себе через Swagger, без авторизации —
    временный ручной инструмент для проверки доставки перед раскаткой на всех.
    Всегда шлёт админу (see ChatService.send_test_push), убрать/закрыть
    авторизацией после того, как push подтверждён живьём."""
    worker = BackgroundWorker.get_instance()
    try:
        sent = await worker.chat_service.send_test_push()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    return {"sent": sent}


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
