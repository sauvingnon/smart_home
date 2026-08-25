# app/core/auth.py
from fastapi import Request, HTTPException
from fastapi import status
from starlette.websockets import WebSocket
from logger import logger

COOKIE_NAME = "esp_session"


def get_client_ip(request: Request) -> str:
    """Реальный IP клиента из-за nginx-реверс-прокси. esp_service слушает
    только 127.0.0.1 (наружу не торчит), поэтому доверяем X-Forwarded-For —
    подделать его может только сам nginx, а не внешний клиент напрямую.
    Берём ПОСЛЕДНИЙ адрес в списке (тот, что дописал именно nginx), а не
    первый — первый в списке как раз может быть подделан клиентом."""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[-1].strip()
    return request.client.host if request.client else "unknown"

class AuthManager:
    def __init__(self, cache):
        self.cache = cache

    async def is_admin(self, user_id: int) -> bool:
        user = await self.cache.get_user(user_id)
        return user is not None and user.get("role") == "admin"

    async def verify_access_key(self, request: Request | str) -> int:
        if isinstance(request, Request):
            access_key = request.cookies.get(COOKIE_NAME)
            if not access_key:
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Not authenticated",
                )
        else:
            access_key = request

        user_id = await self.cache.validate_key(access_key)

        if not user_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Invalid or expired session",
            )

        logger.debug(f"✅ Session validated for user {user_id}")
        if isinstance(request, Request) and not await self.is_admin(user_id):
            # request.url.path — сырой путь С учётом root_path ("/api/esp_service/...");
            # ROUTE_LABELS сравнивается с путём БЕЗ root_path, иначе ни один
            # префикс никогда не совпадёт (root_path у FastAPI = "/api").
            root_path = request.scope.get("root_path", "")
            relative_path = request.url.path.removeprefix(root_path)
            await self.cache.record_activity(user_id, relative_path)
        return user_id

    async def get_current_user_id(self, request: Request) -> int:
        return await self.verify_access_key(request)


_auth_manager = None

def init_auth_manager(cache):
    global _auth_manager
    _auth_manager = AuthManager(cache)
    return _auth_manager

def get_auth_manager():
    if _auth_manager is None:
        raise RuntimeError("AuthManager not initialized")
    return _auth_manager

async def get_current_user_id_dep(request: Request) -> int:
    auth = get_auth_manager()
    return await auth.verify_access_key(request)
