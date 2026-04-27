# api/endpoints/auth.py
from fastapi import APIRouter, HTTPException, Request, Response, Header
from app.core.worker import BackgroundWorker
from app.core.auth import get_auth_manager, COOKIE_NAME
from app.schemas.auth import KeyResponse
from config import BOT_SECRET, COOKIE_SECURE

router = APIRouter(
    prefix="/auth",
    tags=["auth"],
)

COOKIE_MAX_AGE = 180 * 24 * 3600  # 180 дней


@router.post("/login")
async def login(request: Request, response: Response):
    """Обменять ключ доступа на httpOnly session cookie."""
    body = await request.json()
    key = body.get("key", "").strip()
    if not key:
        raise HTTPException(status_code=400, detail="Key required")

    worker = BackgroundWorker.get_instance()
    user_id = await worker.cache.validate_key(key)
    if not user_id:
        raise HTTPException(status_code=403, detail="Invalid or expired key")

    response.set_cookie(
        key=COOKIE_NAME,
        value=key,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="strict",
        max_age=COOKIE_MAX_AGE,
    )
    return {"status": "ok"}


@router.post("/logout")
async def logout(response: Response):
    """Сбросить сессию."""
    response.delete_cookie(key=COOKIE_NAME, httponly=True, secure=True, samesite="strict")
    return {"status": "ok"}


@router.get("/me")
async def me(request: Request):
    """Проверить текущую сессию."""
    auth = get_auth_manager()
    user_id = await auth.verify_access_key(request)
    return {"user_id": user_id}


@router.post("/generate_key", response_model=KeyResponse)
async def generate_key_endpoint(
    user_id: int,
    request: Request,
    x_bot_secret: str = Header(...),
):
    """Генерация ключа доступа. Вызывать вручную через curl с BOT_SECRET."""
    if x_bot_secret != BOT_SECRET:
        raise HTTPException(status_code=403, detail="Invalid bot secret")

    worker = BackgroundWorker.get_instance()
    key = await worker.cache.generate_key(user_id)
    return KeyResponse(key=key, expires_in_days=180)
