# app/services/video_service.py
import asyncio
import json
import time
from datetime import datetime
from typing import Dict, Optional
from fastapi import WebSocket
from logger import logger
from app.schemas.camera import CameraState, CameraMode, CameraMetrics
from app.core.auth import get_auth_manager
from app.utils.time import _get_izhevsk_time
from app.services.s3_service.s3_manager import S3Manager
from app.services.redis.cache_manager import CacheManager

class VideoService:
    """Сервис управления камерами — базовая версия (только подключение и метрики)"""
    
    def __init__(self, s3_manager: S3Manager, cache_manager: CacheManager):

        self.s3_manager = s3_manager
        self.cache_manager = cache_manager

        # Состояние всех камер
        self.cameras: Dict[str, CameraState] = {}
        # WebSocket соединения
        self.connections: Dict[str, WebSocket] = {}
        # Простая авторизация (потом вынесите в базу)
        self.valid_keys = {"cam1": "12345678"}
    
    async def start(self):
        """Запустить фоновый ping-pong watcher"""
        logger.info("✅ VideoService (базовый) запущен")
    
    async def handle_camera(self, websocket: WebSocket):
        """Обработка WebSocket соединения от камеры"""
        await websocket.accept()
        camera_id = None
        
        try:
            # ---- Аутентификация ----
            auth_msg = await asyncio.wait_for(websocket.receive_text(), timeout=10.0)
            if not auth_msg.startswith("AUTH:"):
                await websocket.close(code=1008, reason="Invalid auth format")
                return
            
            parts = auth_msg.split(":")
            if len(parts) < 3:
                await websocket.close(code=1008, reason="Invalid auth data")
                return
            
            access_key = parts[1]
            camera_id = parts[2]
            
            if self.valid_keys.get(camera_id) != access_key:
                await websocket.close(code=1008, reason="Invalid key")
                return
            
            # ---- Старое соединение? закрываем ----
            if camera_id in self.connections:
                try:
                    await self.connections[camera_id].close()
                except:
                    pass
            
            # ---- Сохраняем новое соединение ----
            self.connections[camera_id] = websocket
            
            # ---- Инициализируем или обновляем состояние ----
            if camera_id not in self.cameras:
                self.cameras[camera_id] = CameraState(camera_id=camera_id)
            
            self.cameras[camera_id].mode = CameraMode.CONNECTED
            self.cameras[camera_id].connected_at = datetime.now()
            self.cameras[camera_id].last_seen = datetime.now()
            
            logger.info(f"✅ Камера {camera_id} подключена")
            await websocket.send_text("AUTH_OK")
            
            # ---- Цикл приёма сообщений ----
            while True:
                try:
                    message = await asyncio.wait_for(websocket.receive(), timeout=60.0)
                    
                    # Проверяем наличие текстового поля
                    if 'text' in message:
                        await self._handle_text(camera_id, message['text'])
                        
                    elif 'bytes' in message:
                        # Обработка бинарных данных (видеокадры)
                        self.cameras[camera_id].last_seen = datetime.now()
                        # self.cameras[camera_id].total_frames += 1
                        
                except asyncio.TimeoutError:
                    logger.warning(f"⏱️ Таймаут {camera_id}, закрываем")
                    break
                    
        except Exception as e:
            logger.error(f"❌ Ошибка при обработке {camera_id}: {e}", exc_info=True)
        finally:
            await self._disconnect_camera(camera_id)
    
    async def _handle_text(self, camera_id: str, text: str):
        """Обработка текстовых сообщений от камеры (метрики, pong, команды)"""
        state = self.cameras.get(camera_id)
        if not state:
            logger.warning(f"⚠️ Нет состояния для {camera_id}")
            return
        
        # Обновляем время последней активности
        state.last_seen = datetime.now()
        
        # ---- Метрики (fps:30;quality_mode:2;tmp:45.5;isStreamActive:1) ----
        if text.startswith("fps:"):
            try:
                metrics = state.metrics
                for part in text.split(';'):
                    if ':' not in part:
                        continue
                    key, val = part.split(':', 1)
                    if key == 'fps':
                        metrics.fps = int(val)
                    elif key == 'quality_mode':
                        metrics.quality_mode = int(val)
                    elif key == 'tmp':
                        metrics.temperature = float(val)
                    elif key == 'isStreamActive':
                        metrics.is_streaming = bool(int(val))
                    elif key == 'fan':
                        metrics.fan = bool(int(val))
                    elif key == 'isRecordActive':
                        metrics.is_recording = bool(int(val))
                
                metrics.last_metrics_time = datetime.now()
                
                # Обновляем режим камеры на основе isStreamActive
                if metrics.is_streaming:
                    state.mode = CameraMode.STREAMING
                else:
                    state.mode = CameraMode.CONNECTED
                
                # logger.debug(
                #     f"📊 [{camera_id}] FPS={metrics.fps}, T={metrics.temperature:.1f}°C, "
                #     f"Stream={metrics.is_streaming}, Fan={metrics.fan}"  # ← добавили fan в лог
                # )
                
            except Exception as e:
                logger.error(f"❌ Ошибка парсинга метрик {camera_id}: {e}")
            return
                
        # ---- Другие команды (можно расширять) ----
        if text == "stream_state:ok":
            logger.info(f"✅ [{camera_id}] Камера подтвердила изменение стрима")
            return
        
        logger.warning(f"⚠️ [{camera_id}] Неизвестное текстовое сообщение: {text[:100]}")
    
    async def _disconnect_camera(self, camera_id: str):
        """Закрыть соединение и обновить состояние"""
        if camera_id in self.connections:
            ws = self.connections.pop(camera_id)
            try:
                await ws.close()
            except:
                pass
        
        if camera_id in self.cameras:
            self.cameras[camera_id].mode = CameraMode.NEVER_CONNECTED
            self.cameras[camera_id].metrics.is_streaming = False
            logger.info(f"🔌 Камера {camera_id} отключена")
    
    # ---- Команды камере ----
    async def send_command(self, camera_id: str, command: str) -> bool:
        """Отправить текстовую команду камере"""
        ws = self.connections.get(camera_id)
        if not ws:
            logger.warning(f"⚠️ Камера {camera_id} не подключена")
            return False
        try:
            await ws.send_text(command)
            logger.info(f"📨 [{camera_id}] Отправлено: {command}")
            return True
        except Exception as e:
            logger.error(f"❌ Ошибка отправки {camera_id}: {e}")
            await self._disconnect_camera(camera_id)
            return False
    
    async def start_stream(self, camera_id: str) -> bool:
        """Включить стрим (камера начнёт слать видеокадры)"""
        return await self.send_command(camera_id, "stream_state:on")
    
    async def stop_stream(self, camera_id: str) -> bool:
        """Выключить стрим"""
        return await self.send_command(camera_id, "stream_state:off")
    
    async def set_resolution(self, camera_id: str, resolution: str) -> bool:
        """Изменить разрешение (QVGA, VGA, HD)"""
        if resolution not in ["QVGA", "VGA", "HD"]:
            return False
        return await self.send_command(camera_id, f"size:{resolution}")
    
    async def start_recording(self, camera_id: str) -> bool:
        """Отправить record:start[:timestamp]"""
        dt = _get_izhevsk_time()
        timestampStr = dt.timestamp()
        cmd = f"record:start:{str(timestampStr)}"
        return await self.send_command(camera_id, cmd)

    async def stop_recording(self, camera_id: str) -> bool:
        return await self.send_command(camera_id, "record:stop")

    async def get_queue_status(self, camera_id: str) -> Optional[int]:
        """Запросить очередь (ответ обработается асинхронно)"""
        # Нужно хранить pending запросов или использовать await с Future
        # Пока можно просто отправить и игнорировать ответ
        await self.send_command(camera_id, "queue:status")
        return None  # Временно

    async def set_fan(self, camera_id: str, enable: bool) -> bool:
        """
        Включить/выключить вентилятор на камере.
        Отправляет команду fan:on или fan:off
        """
        command = f"fan:{'on' if enable else 'off'}"
        success = await self.send_command(camera_id, command)
        
        if success:
            # Опционально: сразу обновить состояние в metrics (камера подтвердит своим fps)
            # Но лучше дождаться следующего fps сообщения от камеры
            logger.info(f"🌀 [{camera_id}] Отправлена команда: {'Вкл' if enable else 'Выкл'} вентилятора")
        
        return success

    # ---- Получение статуса ----
    async def get_camera_state(self, camera_id: str) -> Optional[CameraState]:
        return self.cameras.get(camera_id)
    
    async def get_all_cameras(self) -> Dict[str, CameraState]:
        return self.cameras

    # ---- Работа с s3 ----
    async def save_video_from_camera(
    self,
    camera_id: str,
    file_stream,
    start_timestamp: int,
    duration_seconds: int,
) -> Optional[str]:
        """
        Сохранить видео, загруженное камерой.
        
        Args:
            camera_id: ID камеры
            file_stream: поток видеофайла
            start_timestamp: Unix timestamp начала записи
            duration_seconds: длительность в секундах
            access_key: ключ доступа для аутентификации
        
        Returns:
            video_id: UUID сохранённого видео или None
        """
        
        # 2. Проверяем, что камера известна системе (опционально)
        if camera_id not in self.cameras:
            logger.warning(f"⚠️ Камера {camera_id} не в состоянии, но сохраняем видео")
        
        # 3. Конвертируем timestamp в datetime
        try:
            start_datetime = datetime.fromtimestamp(start_timestamp)
        except Exception as e:
            logger.error(f"❌ Неверный timestamp {start_timestamp}: {e}")
            return None
        
        # 4. Сохраняем в S3 через S3Manager
        if not self.s3_manager:
            logger.error("❌ S3 manager не настроен")
            return None
        
        video_id = await self.s3_manager.save_video_from_stream(
            camera_id=camera_id,
            file_stream=file_stream,
            start_time=start_datetime,
            duration_seconds=duration_seconds,
            metadata={
                "upload_method": "esp32_push",
                "camera_id": camera_id
            }
        )
        
        if video_id:
            # 5. Обновляем статистику камеры
    
            logger.info(f"✅ [{camera_id}] Видео сохранено: {video_id}, длительность={duration_seconds}с")
            
            # 6. TODO: Запустить фоновую задачу для извлечения thumbnail
            # asyncio.create_task(self._extract_and_save_thumbnail(camera_id, video_id, file_stream))
        
        return video_id


    async def get_video_list(
        self,
        camera_id: Optional[str] = None
    ) -> list:
        """
        Получить список видео (с учётом прав доступа).
        
        Args:
            user_id: ID пользователя (из JWT или access_key)
            camera_id: опционально фильтр по камере
        
        Returns:
            list: список видео с метаданными
        """
        if not self.s3_manager:
            raise ValueError("S3 manager не доступен")
        
        videos = await self.s3_manager.list_videos(camera_id=camera_id)
        
        # Добавляем presigned URLs для просмотра (опционально)
        for video in videos:
            if video.get('key'):
                video['url'] = await self.s3_manager.get_video_presigned_url(video['key'])
        
        return videos


    async def get_video_by_id(
        self,
        camera_id: str,
        video_id: str,
    ) -> Optional[bytes]:
        """
        Получить видео по ID (с проверкой прав).
        """
        if not self.s3_manager:
            raise ValueError("S3 manager не доступен")
        
        # Формируем ключ по известной структуре
        # videos/{camera_id}/{year}/{month}/{day}/{video_id}.mp4
        # Нужно найти файл, т.к. мы не знаем дату
        all_videos = await self.s3_manager.list_videos(camera_id=camera_id)
        
        for video in all_videos:
            if video.get('video_id') == video_id:
                return await self.s3_manager.get_video(video['key'])
        
        logger.warning(f"❌ Видео не найдено: {camera_id}/{video_id}")
        return None

    async def get_thumbnail(self, camera_id: str, video_id: str) -> Optional[bytes]:
        """Получить thumbnail из S3"""
        if not self._s3_manager:
            return None
        return await self._s3_manager.get_thumbnail(camera_id, video_id)

    async def get_video_presigned_url(
        self,
        camera_id: str,
        video_id: str,
        user_id: int,
        expires_in: int = 3600
    ) -> Optional[str]:
        """
        Получить подписанную ссылку на видео.
        """
        if not self._s3_manager:
            raise ValueError("S3 manager не доступен")
        
        # TODO: Проверка прав
        
        all_videos = await self._s3_manager.list_videos(camera_id=camera_id)
        
        for video in all_videos:
            if video.get('video_id') == video_id:
                return await self._s3_manager.get_video_presigned_url(video['key'], expires_in)
        
        return None


    async def delete_video(
        self,
        camera_id: str,
        video_id: str,
        user_id: int
    ) -> bool:
        """
        Удалить видео.
        """
        if not self._s3_manager:
            raise ValueError("S3 manager не доступен")
        
        # TODO: Проверка прав
        
        all_videos = await self._s3_manager.list_videos(camera_id=camera_id)
        
        for video in all_videos:
            if video.get('video_id') == video_id:
                # Удаляем видео
                success = await self._s3_manager.delete_video(video['key'])
                
                # Удаляем thumbnail (если есть)
                thumb_key = f"thumbnails/{camera_id}/{video_id}.jpg"
                await self._s3_manager.delete_video(thumb_key)  # delete_video работает с любым ключом
                
                if success:
                    logger.info(f"🗑️ [{camera_id}] Видео {video_id} удалено")
                    return True
        
        return False