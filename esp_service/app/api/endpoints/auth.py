# api/endpoints/auth.py
from fastapi import APIRouter, HTTPException, Request, Response
from app.core.worker import BackgroundWorker
from app.core.auth import get_auth_manager, get_client_ip, COOKIE_NAME
from config import COOKIE_SECURE

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

    ip = get_client_ip(request)
    allowed = await worker.cache.check_login_rate_limit(ip)
    if not allowed:
        raise HTTPException(status_code=429, detail="Слишком много попыток входа, попробуйте позже")

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
    # secure обязан совпадать с тем, что выставил /login: под http (dev) браузер
    # отклоняет Set-Cookie с флагом Secure, и удаление молча не доезжает —
    # cookie переживает "выход", а перезагрузка страницы возвращает сессию.
    response.delete_cookie(key=COOKIE_NAME, httponly=True, secure=COOKIE_SECURE, samesite="strict")
    return {"status": "ok"}


@router.get("/me")
async def me(request: Request):
    """Проверить текущую сессию."""
    auth = get_auth_manager()
    user_id = await auth.verify_access_key(request)

    worker = BackgroundWorker.get_instance()
    user = await worker.cache.get_user(user_id)

    return {
        "user_id": user_id,
        "username": user["username"] if user else None,
        "display_name": user["display_name"] if user else None,
        "role": user["role"] if user else "user",
        "is_admin": user is not None and user["role"] == "admin",
    }
