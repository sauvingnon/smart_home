# app/core/auth.py
from fastapi import Request, HTTPException
from fastapi import status
from starlette.websockets import WebSocket
from logger import logger

COOKIE_NAME = "esp_session"

class AuthManager:
    def __init__(self, cache):
        self.cache = cache

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
