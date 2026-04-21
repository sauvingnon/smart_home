# app/core/auth.py
from typing import Optional
from fastapi import Request, HTTPException
from fastapi import status
from starlette.websockets import WebSocket
from logger import logger

class AuthManager:
    """Менеджер авторизации для HTTP и WebSocket"""
    
    def __init__(self, cache):
        self.cache = cache
    
    async def verify_access_key(self, request: Request | str) -> int:
        """Проверяет ключ доступа.
        
        Поддерживает:
        - Request: берет ключ из заголовка X-Access-Key
        - str: использует строку как ключ напрямую
        """
        # Определяем access_key в зависимости от типа
        if isinstance(request, Request):
            access_key = request.headers.get("X-Access-Key")
            source = "header"
        else:
            access_key = request  # Это уже сам ключ
            source = "direct"
        
        if not access_key:
            if isinstance(request, Request):
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Missing X-Access-Key header"
                )
            else:
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Access key is empty"
                )
        
        user_id = await self.cache.validate_key(access_key)
        
        if not user_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Invalid or expired key"
            )
        
        logger.debug(f"✅ Access key validated from {source} for user {user_id}")
        return user_id
    
    # Dependency для FastAPI
    async def get_current_user_id(self, request: Request) -> int:
        """Dependency для получения user_id из заголовка"""
        return await self.verify_access_key(request)

# Создаем глобальный экземпляр (будет установлен при старте)
_auth_manager = None

def init_auth_manager(cache):
    """Инициализация менеджера авторизации"""
    global _auth_manager
    _auth_manager = AuthManager(cache)
    return _auth_manager

def get_auth_manager():
    """Получить экземпляр менеджера авторизации"""
    if _auth_manager is None:
        raise RuntimeError("AuthManager not initialized")
    return _auth_manager

async def get_current_user_id_dep(request: Request) -> int:
    """Dependency для FastAPI, лениво получает user_id"""
    auth = get_auth_manager()
    user_id = await auth.verify_access_key(request)
    if user_id is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")