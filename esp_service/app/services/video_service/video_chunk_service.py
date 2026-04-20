"""
Сервис для приёма и сборки видео по чанкам.
Не зависит от VideoService, только собирает байты и отдаёт готовый поток.
"""

import asyncio
import logging
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Optional, Dict, Tuple, BinaryIO
import io

logger = logging.getLogger(__name__)


class VideoChunkSession:
    """Сессия сборки одного видео из чанков."""
    
    def __init__(self, camera_id: str, filename: str, total_chunks: int, ttl_seconds: int = 300):
        self.camera_id = camera_id
        self.filename = filename
        self.total_chunks = total_chunks
        self.chunks: Dict[int, bytes] = {}
        self.created_at = datetime.now()
        self.expires_at = datetime.now() + timedelta(seconds=ttl_seconds)
        self.last_chunk_at = datetime.now()
    
    def add_chunk(self, chunk_number: int, data: bytes) -> bool:
        """Добавляет чанк. Возвращает True, если это был последний чанк."""
        self.chunks[chunk_number] = data
        self.last_chunk_at = datetime.now()
        return len(self.chunks) == self.total_chunks
    
    def is_expired(self) -> bool:
        """Проверяет, истекла ли сессия."""
        return datetime.now() > self.expires_at
    
    def is_complete(self) -> bool:
        """Проверяет, все ли чанки получены."""
        return len(self.chunks) == self.total_chunks
    
    def get_missing_chunks(self) -> list:
        """Возвращает список номеров отсутствующих чанков."""
        return [i for i in range(1, self.total_chunks + 1) if i not in self.chunks]
    
    def assemble(self) -> BinaryIO:
        """Собирает все чанки в BytesIO поток."""
        if not self.is_complete():
            missing = self.get_missing_chunks()
            raise ValueError(f"Cannot assemble incomplete video. Missing chunks: {missing}")
        
        data = b""
        for i in range(1, self.total_chunks + 1):
            data += self.chunks[i]
        
        logger.info(f"📼 Собрано видео {self.filename}: {len(data)} байт из {self.total_chunks} чанков")
        return io.BytesIO(data)


class VideoChunkService:
    """
    Сервис для управления сессиями загрузки видео по чанкам.
    
    Использование:
        chunk_service = VideoChunkService(ttl_seconds=300)
        
        # При получении чанка
        session, is_complete = chunk_service.add_chunk(
            session_key="cam1_123456_video.mjpeg",
            camera_id="cam1",
            filename="video.mjpeg",
            chunk_number=1,
            total_chunks=5,
            data=b"..."
        )
        
        if is_complete:
            video_stream = session.assemble()
            # Передаём video_stream в VideoService
    """
    
    def __init__(self, ttl_seconds: int = 300):
        """
        Args:
            ttl_seconds: Время жизни сессии в секундах (по умолчанию 5 минут).
        """
        self.ttl_seconds = ttl_seconds
        self._sessions: Dict[str, VideoChunkSession] = {}
        self._cleanup_task: Optional[asyncio.Task] = None
        logger.info(f"🎬 VideoChunkService инициализирован (TTL={ttl_seconds}с)")
    
    def _make_session_key(self, camera_id: str, start_time: int, filename: str) -> str:
        """Создаёт уникальный ключ сессии."""
        return f"{camera_id}_{start_time}_{filename}"
    
    def add_chunk(
        self,
        session_key: str,
        camera_id: str,
        filename: str,
        chunk_number: int,
        total_chunks: int,
        data: bytes
    ) -> Tuple[VideoChunkSession, bool]:
        """
        Добавляет чанк в сессию.
        
        Args:
            session_key: Уникальный ключ сессии
            camera_id: ID камеры
            filename: Имя файла
            chunk_number: Номер чанка (начиная с 1)
            total_chunks: Общее количество чанков
            data: Данные чанка
        
        Returns:
            Tuple[VideoChunkSession, bool]: (сессия, True если сессия завершена)
        
        Raises:
            ValueError: Если чанк пришёл не по порядку или сессия истекла
        """
        # Очищаем устаревшие сессии перед добавлением
        self._cleanup_expired()
        
        # Получаем или создаём сессию
        if session_key not in self._sessions:
            self._sessions[session_key] = VideoChunkSession(
                camera_id=camera_id,
                filename=filename,
                total_chunks=total_chunks,
                ttl_seconds=self.ttl_seconds
            )
            logger.info(f"🆕 Новая сессия: {session_key} ({total_chunks} чанков)")
        
        session = self._sessions[session_key]
        
        # Проверяем, не истекла ли сессия
        if session.is_expired():
            del self._sessions[session_key]
            raise ValueError(f"Session {session_key} expired")
        
        # Проверяем порядок чанков
        expected_chunk = len(session.chunks) + 1
        if chunk_number != expected_chunk:
            # Чанк не по порядку — сбрасываем сессию
            del self._sessions[session_key]
            raise ValueError(f"Expected chunk {expected_chunk}, got {chunk_number}")
        
        # Проверяем, что total_chunks совпадает
        if session.total_chunks != total_chunks:
            del self._sessions[session_key]
            raise ValueError(f"Total chunks mismatch: expected {session.total_chunks}, got {total_chunks}")
        
        # Добавляем чанк
        is_complete = session.add_chunk(chunk_number, data)
        
        received = len(session.chunks)
        logger.info(f"📦 [{camera_id}] Чанк {chunk_number}/{total_chunks} ({len(data)} байт) | {received}/{total_chunks}")
        
        # Если сессия завершена — удаляем из хранилища
        if is_complete:
            del self._sessions[session_key]
            logger.info(f"✅ [{camera_id}] Сессия {session_key} завершена")
        
        return session, is_complete
    
    def get_session(self, session_key: str) -> Optional[VideoChunkSession]:
        """Возвращает сессию по ключу (если не истекла)."""
        self._cleanup_expired()
        session = self._sessions.get(session_key)
        if session and session.is_expired():
            del self._sessions[session_key]
            return None
        return session
    
    def cancel_session(self, session_key: str) -> bool:
        """Отменяет сессию (например, при ошибке)."""
        if session_key in self._sessions:
            del self._sessions[session_key]
            logger.info(f"❌ Сессия {session_key} отменена")
            return True
        return False
    
    def _cleanup_expired(self):
        """Удаляет истекшие сессии."""
        expired_keys = [
            key for key, session in self._sessions.items()
            if session.is_expired()
        ]
        for key in expired_keys:
            del self._sessions[key]
        if expired_keys:
            logger.info(f"🧹 Очищено {len(expired_keys)} устаревших сессий")
    
    async def start_cleanup_task(self, interval_seconds: int = 60):
        """Запускает фоновую задачу очистки (вызывать при старте приложения)."""
        async def _cleanup_loop():
            while True:
                await asyncio.sleep(interval_seconds)
                self._cleanup_expired()
        
        self._cleanup_task = asyncio.create_task(_cleanup_loop())
        logger.info(f"🔄 Фоновая очистка чанков запущена (интервал {interval_seconds}с)")
    
    async def stop_cleanup_task(self):
        """Останавливает фоновую очистку."""
        if self._cleanup_task:
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass
            logger.info("🛑 Фоновая очистка чанков остановлена")
    
    @property
    def active_sessions_count(self) -> int:
        """Количество активных сессий."""
        self._cleanup_expired()
        return len(self._sessions)
    
    def get_stats(self) -> dict:
        """Возвращает статистику сервиса."""
        self._cleanup_expired()
        total_chunks = sum(len(s.chunks) for s in self._sessions.values())
        return {
            "active_sessions": len(self._sessions),
            "total_pending_chunks": total_chunks,
            "ttl_seconds": self.ttl_seconds
        }