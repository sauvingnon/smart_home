# app/services/video_service.py
import asyncio
import time
import gc
from datetime import datetime, timedelta
from typing import Dict, Set, Optional
from fastapi import WebSocket
from logger import logger
from app.services.s3_service.s3_manager import S3Manager
from app.schemas.camera import (
    CameraState, VideoRecorder, RecordingInfo,
    CameraStatus, CameraControlResponse, CameraModeEnum
)
import cv2
import numpy as np
import subprocess
import shutil
import tempfile
import os
import uuid
from app.utils.time import _get_izhevsk_time

class VideoService:
    """Сервис управления видеопотоками"""
    
    def __init__(self, s3_manager: S3Manager = None):
        # Полное состояние всех камер (вместо camera_modes + cameras)
        # Dict[camera_id] -> CameraState содержит режим (active, mode) + статистику (fps, last_frame и т.д.)
        self.cameras: Dict[str, CameraState] = {}
        
        # WebSocket соединения камер (Dict[camera_id] -> WebSocket)
        self.esp_connections: Dict[str, WebSocket] = {}
        
        # WebSocket соединения зрителей (Dict[camera_id] -> Set[WebSocket])
        self.viewer_connections: Dict[str, Set[WebSocket]] = {}
        
        # Отслеживание времени подключения зрителей (Dict[camera_id] -> Dict[viewer_uuid -> time])
        # Нужно для таймаутов (15 минут)
        self._viewer_connected_at: Dict[str, Dict[str, float]] = {}
        
        # Настройки
        self.valid_access_keys = {"cam1": "12345678"}

        # Активные видеозаписи (Dict[camera_id] -> VideoRecorder)
        self._video_recorders: Dict[str, VideoRecorder] = {}
        
        # Отслеживание асинхронных задач для автостопа записи
        self._recording_tasks: Dict[str, asyncio.Task] = {}
        
        # S3 менеджер для сохранения видео (инициализируется позже)
        self._s3_manager: S3Manager = None
        
        # Наблюдатель проверяет состояние камер каждые 30 секунд
        self._observer_interval = 30
        
        # Флаг для управления observer loop
        self._observer_running = False
        
        # Флаг для управления cleanup loop (удаление видео старше 7 дней)
        self._cleanup_running = False
        self._cleanup_interval = 86400  # 24 часа в секундах
    
    # ========== УПРАВЛЕНИЕ КАМЕРОЙ ==========

    async def start(self):
        """Запуск наблюдателя за состоянием камер и cleanup воркера.
        Наблюдатель отвечает за:
        1. Отслеживание таймаутов зрителей (15 минут)
        2. Выключение камер когда нет активности (нет записи + нет зрителей)
        
        Cleanup воркер отвечает за:
        1. Удаление видео старше 7 дней (раз в сутки)
        """
        self._observer_running = True
        self._cleanup_running = True
        logger.info("✅ VideoService запущен, наблюдатель и cleanup воркер активированы")
        
        try:
            # Запускаем оба цикла параллельно
            await asyncio.gather(
                self._observer_camera_loop(),
                self._cleanup_old_videos_loop()
            )
        finally:
            self._observer_running = False
            self._cleanup_running = False
            logger.info("⏹️ VideoService остановлен")

    async def _observer_camera_loop(self):
        """
        Фоновый цикл управления состоянием камер (работает каждые 30 сек).
        
        Что делает:
        1. Проверяет таймауты зрителей (15 минут) и удаляет "зависших"
        2. Выключает камеру если нет записи И нет활 зрителей (экономия ресурсов)
        3. Логирует состояние
        
        Вызываться может несколько раз (например в тестах)
        """
        logger.info("▶️ Цикл наблюдателя запущен")
        
        while self._observer_running:
            try:
                current_time = time.time()
                
                # Получаем активные камеры
                active_cameras = list(self.esp_connections.keys())
                
                if not active_cameras:
                    logger.debug("ℹ️ Нет подключенных камер, пропускаем проверку")
                    await asyncio.sleep(self._observer_interval)
                    continue
                
                for camera_id in active_cameras:
                    # Пропускаем если камера отключилась
                    if camera_id not in self.esp_connections:
                        continue
                    
                    camera = self.cameras.get(camera_id)
                    if not camera:
                        logger.warning(f"⚠️ [{camera_id}] Нет состояния для камеры, пропускаем")
                        continue
                    
                    # ========== ТАЙМАУТЫ ЗРИТЕЛЕЙ ==========
                    viewers = self.viewer_connections.get(camera_id, set())
                    if viewers:
                        viewer_times = self._viewer_connected_at.get(camera_id, {})
                        timed_out = []
                        
                        for viewer in list(viewers):
                            viewer_id = id(viewer)
                            connected_at = viewer_times.get(viewer_id, current_time)
                            
                            # Таймаут 15 минут
                            if current_time - connected_at > 15 * 60:
                                timed_out.append((viewer, viewer_id))
                        
                        # Удаляем истекших зрителей
                        if timed_out:
                            for viewer, viewer_id in timed_out:
                                viewers.discard(viewer)
                                viewer_times.pop(viewer_id, None)
                                logger.info(
                                    f"⏱️ [{camera_id}] Зритель {viewer_id[:8]} истек таймаут (15 мин)"
                                )
                    
                    # ========== РЕШЕНИЕ О ВЫКЛЮЧЕНИИ КАМЕРЫ ==========
                    has_recording = (
                        camera_id in self._video_recorders and 
                        self._video_recorders[camera_id].is_recording
                    )
                    has_viewers = len(viewers) > 0 if viewers else False
                    
                    # Если нет причин держать камеру вкл → выключаем
                    if not has_recording and not has_viewers and camera.active:
                        logger.info(
                            f"⏹️ [{camera_id}] Нет записи и зрителей, выключаем камеру"
                        )
                        await self.control_camera(camera_id, "stop")
                    elif has_recording or has_viewers:
                        logger.debug(
                            f"🟢 [{camera_id}] Камера вкл "
                            f"(запись={'ON' if has_recording else 'OFF'}, "
                            f"зрители={len(viewers) if viewers else 0})"
                        )
                
                await asyncio.sleep(self._observer_interval)
                
            except Exception as e:
                logger.error(f"❌ Ошибка в цикле наблюдателя: {e}", exc_info=True)
                await asyncio.sleep(self._observer_interval)
    
    async def _cleanup_old_videos_loop(self):
        """
        Цикл очистки старых видео (раз в сутки).
        
        Удаляет видеофайлы старше 7 дней из S3.
        Запускается параллельно с observer loop.
        """
        logger.info("▶️ Цикл cleanup видео запущен (раз в сутки, удаляет видео старше 7 дней)")
        
        while self._cleanup_running:
            try:
                if not self._s3_manager:
                    logger.debug("⏭️ S3 manager не готов, пропускаем cleanup")
                    await asyncio.sleep(self._cleanup_interval)
                    continue
                
                cutoff_time = _get_izhevsk_time() - timedelta(days=7)
                logger.info(f"🗑️ Начинаю удаление видео старше {cutoff_time.date()}")
                
                # Получаем все видео
                all_videos = await self._s3_manager.list_videos()
                
                if not all_videos:
                    logger.debug("ℹ️ Видео не найдено для cleanup")
                    await asyncio.sleep(self._cleanup_interval)
                    continue
                
                deleted_count = 0
                deleted_size = 0
                
                for video_info in all_videos:
                    # video_info может быть dict с ключами: 'Key', 'LastModified', 'Size'
                    try:
                        key = video_info.get('Key') or video_info
                        last_modified = video_info.get('LastModified')
                        size = video_info.get('Size', 0)
                        
                        # Если нет даты - пропускаем
                        if not last_modified:
                            continue
                        
                        # Преобразуем в datetime если это строка
                        if isinstance(last_modified, str):
                            last_modified = datetime.fromisoformat(last_modified.replace('Z', '+00:00'))
                        
                        # Удаляем если старше 7 дней
                        if last_modified.replace(tzinfo=None) < cutoff_time:
                            success = await self._s3_manager.delete_video(key)
                            if success:
                                deleted_count += 1
                                deleted_size += size
                                logger.debug(f"🗑️ Удалено видео: {key} ({size} байт)")
                                
                                # 🔧 УДАЛЯЕМ THUMBNAIL ВМЕСТЕ С ВИДЕО
                                # Формат: videos/{camera_id}/{YYYY}/{MM}/{DD}/{timestamp}.mp4
                                # Thumbnail: videos/{camera_id}/{YYYY}/{MM}/{DD}/{timestamp}_thumb.jpg
                                try:
                                    parts = key.split('/')
                                    if len(parts) >= 5:
                                        # Получаем filename (например "1711533840.mp4")
                                        filename = parts[-1]
                                        timestamp_str = filename.split('.')[0]  # Убираем расширение
                                        
                                        # Формируем ключ thumbnail
                                        thumb_key = '/'.join(parts[:-1]) + f"/{timestamp_str}_thumb.jpg"
                                        
                                        # 🔧 Удаляем thumbnail БЕЗ AWAIT
                                        try:
                                            self._s3_manager.client.delete_object(
                                                Bucket=self._s3_manager.bucket_name,
                                                Key=thumb_key
                                            )
                                            logger.debug(f"🗑️ Удалено thumbnail: {thumb_key}")
                                        except Exception as thumb_err:
                                            logger.debug(f"⚠️ Не удалось удалить thumbnail {thumb_key}: {thumb_err}")
                                except Exception as e:
                                    logger.error(f"❌ Ошибка при удалении thumbnail: {e}")
                            else:
                                logger.warning(f"⚠️ Не удалось удалить: {key}")
                    except Exception as e:
                        logger.error(f"❌ Ошибка при удалении {video_info}: {e}")
                        continue
                
                if deleted_count > 0:
                    size_mb = deleted_size / (1024 * 1024)
                    logger.info(
                        f"💾 Cleanup завершен: удалено {deleted_count} видео ({size_mb:.1f} МБ)"
                    )
                else:
                    logger.debug("ℹ️ Нет видео для удаления")
                
                # Спим 24 часа
                await asyncio.sleep(self._cleanup_interval)
                
            except Exception as e:
                logger.error(f"❌ Ошибка в cleanup цикле: {e}", exc_info=True)
                await asyncio.sleep(self._cleanup_interval)
    
    async def control_camera(self, camera_id: str, action: str) -> dict:
        """
        Управление камерой: start/stop.
        
        Может вызваться в двух случаях:
        1. От зрителя подключился → включить стрим
        2. От детектора движения (MQTT) → включить запись
        3. Observer loop → выключить если нет активности
        
        Returns: словарь (для HTTP) или схема (для логики)
        """
        
        if camera_id not in self.esp_connections:
            logger.warning(f"⚠️ Камера {camera_id} не подключена")
            return {"error": "Camera not connected", "camera": camera_id}, 404
        
        # Инициализируем состояние если его нет
        if camera_id not in self.cameras:
            self.cameras[camera_id] = CameraState(active=False, mode=CameraModeEnum.IDLE)
        
        camera = self.cameras[camera_id]
        ws = self.esp_connections[camera_id]
        
        try:
            if action == "start":
                # Проверяем - может быть она уже вкл?
                if camera.active:
                    logger.info(f"ℹ️ [{camera_id}] Камера уже включена")
                    return {"status": "already_started", "camera": camera_id}
                
                # Включаем
                await ws.send_text("stream_state:on")
                camera.active = True
                camera.mode = CameraModeEnum.MANUAL
                camera.start_time = _get_izhevsk_time()
                
                logger.info(f"📹 [{camera_id}] Камера включена")
                
                return {
                    "status": "started", 
                    "camera": camera_id, 
                    "message": "Stream started",
                    "error": None
                }
                
            elif action == "stop":
                # Проверяем есть ли причины держать камеру вкл
                has_viewers = (
                    camera_id in self.viewer_connections and 
                    len(self.viewer_connections[camera_id]) > 0
                )
                has_recording = (
                    camera_id in self._video_recorders and 
                    self._video_recorders[camera_id].is_recording
                )
                
                # Если есть зрители или запись идет → не выключаем
                if has_viewers or has_recording:
                    reason = []
                    if has_viewers:
                        reason.append(f"viewers={len(self.viewer_connections[camera_id])}")
                    if has_recording:
                        reason.append("recording=active")
                    
                    logger.warning(
                        f"⚠️ [{camera_id}] Невозможно выключить: {', '.join(reason)}"
                    )
                    return {
                        "status": "failed",
                        "camera": camera_id,
                        "reason": "Camera in use (viewers or recording active)",
                        "error": None
                    }, 409
                
                # Выключаем
                if not camera.active:
                    logger.info(f"ℹ️ [{camera_id}] Камера уже выключена")
                    return {"status": "already_stopped", "camera": camera_id}
                
                await ws.send_text("stream_state:off")
                camera.active = False
                camera.mode = CameraModeEnum.IDLE
                
                logger.info(f"⏹️ [{camera_id}] Камера выключена")
                
                return {
                    "status": "stopped",
                    "camera": camera_id,
                    "message": "Stream stopped",
                    "error": None
                }
            
            else:
                return {
                    "error": "Invalid action. Use 'start' or 'stop'",
                    "camera": camera_id,
                    "status": None
                }, 400
                
        except Exception as e:
            logger.error(f"❌ Ошибка при управлении {camera_id}: {e}", exc_info=True)
            return {"error": str(e), "camera": camera_id}, 500
    
    # ========== ОБРАБОТКА ВЕБСОКЕТА КАМЕРЫ ==========
    
    async def handle_camera_websocket(self, websocket: WebSocket):
        """Обработка WebSocket соединения от ESP32 камеры"""
        await websocket.accept()
        
        camera_id = None
        last_frame_time = time.time()
        
        try:
            # Авторизация
            try:
                auth_msg = await asyncio.wait_for(websocket.receive_text(), timeout=10.0)
            except asyncio.TimeoutError:
                logger.warning("⏱️ Auth timeout")
                await websocket.close(code=1008, reason="Auth timeout")
                return
            
            if not auth_msg.startswith("AUTH:"):
                await websocket.close(code=1008, reason="Invalid auth")
                return
            
            parts = auth_msg.split(":")
            if len(parts) < 3:
                await websocket.close(code=1008, reason="Invalid data")
                return
            
            access_key = parts[1]
            camera_id = parts[2]
            
            # Проверка ключа (закомментирована для разработки)
            # if self.valid_access_keys.get(camera_id) != access_key:
            #     await websocket.close(code=1008, reason="Invalid key")
            #     return
            
            # Отключаем старую камеру если была
            if camera_id in self.esp_connections:
                try:
                    await self.esp_connections[camera_id].close()
                except:
                    pass
            
            self.esp_connections[camera_id] = websocket
            logger.info(f"✅ Camera {camera_id} connected")
            
            # **Инициализируем состояние со схемой CameraState
            # Это объединяет режим И статистику в одну сущность
            if camera_id not in self.cameras:
                self.cameras[camera_id] = CameraState(
                    mode=CameraModeEnum.IDLE,
                    active=False,
                    last_frame=None,
                    fps=0,
                    reported_fps=0,
                    quality_mode=None,
                    last_time=time.time(),
                    frame_count=0
                )
            
            # Подтверждаем авторизацию
            await websocket.send_text("AUTH_OK")
            
            last_ping = time.time()
            
            # Основной цикл приема кадров и команд
            while True:
                try:
                    message = await asyncio.wait_for(websocket.receive(), timeout=10.0)
                    
                    # 🔧 ПРОВЕРЯЕМ DISCONNECT
                    if 'disconnect' in message:
                        logger.info(f"📤 [{camera_id}] Получено disconnect сообщение")
                        break
                    
                    if 'text' in message:
                        await self._handle_camera_text(camera_id, message['text'])
                        
                    elif 'bytes' in message:
                        frame_data = message['bytes']
                        last_frame_time = time.time()
                        await self._handle_camera_frame(camera_id, frame_data)
                        
                except asyncio.TimeoutError:
                    
                    if time.time() - last_ping > 10:
                        try:
                            await websocket.send_text("ping")
                            last_ping = time.time()
                        except:
                            break
                    continue
        except Exception as e:
            logger.error(f"❌ Ошибка при обработке соединения от {camera_id}: {e}", exc_info=True)
        finally:
            if camera_id and self.esp_connections.get(camera_id) == websocket:
                del self.esp_connections[camera_id]
                logger.info(f"Камера {camera_id} отключена")
    
    async def _handle_camera_text(self, camera_id: str, text: str):
        """Обработка текстовых сообщений от камеры"""
        logger.debug(f"📨 Текст от {camera_id}: {text}")
        
        # Обработка FPS метрик
        if text.startswith("fps:"):
            try:
                # Разбираем fps:30;quality_mode:2;tmp:45.5
                data = {}
                for part in text.split(';'):
                    key, val = part.split(':', 1)
                    data[key] = val
                
                if camera_id in self.cameras:
                    cam = self.cameras[camera_id]
                    cam.reported_fps = int(data.get('fps', 0))
                    cam.quality_mode = int(data.get('quality_mode', 1))
                    cam.temperature = float(data.get('tmp', 0))
                    
                    logger.info(f"📊 [{camera_id}] {cam.reported_fps} fps | "
                            f"Качество: {cam.quality_mode} | "
                            f"Температура: {cam.temperature:.1f}°C")
            except Exception as e:
                logger.error(f"❌ [{camera_id}] Ошибка: {e}")
            return
        
        # Простые команды
        commands = {
            "size:ok": f"✅ Разрешение стрима изменено",
            "size:error": f"❌ Ошибка изменения разрешения стрима",
            "stream_state:ok": f"🎥 Стрим переключен успешно",
            "fan:ok": f"🌀 Вентилятор переключен успешно",
        }
        
        if text in commands:
            logger.info(f"[{camera_id}] {commands[text]}")
            return
        
        logger.warning(f"⚠️ [{camera_id}] Неизвестно: {text}")
    
    async def _handle_camera_frame(self, camera_id: str, frame_data: bytes):
        """Обработка видеокадра от камеры: обновляем статистику и рассылаем зрителям"""
        camera = self.cameras[camera_id]
        
        # Обновляем статистику
        camera.last_frame = frame_data
        camera.frame_count += 1
        
        # Пересчитываем FPS каждую секунду
        now = time.time()
        if now - camera.last_time >= 1.0:
            camera.fps = camera.frame_count
            camera.frame_count = 0
            camera.last_time = now
        
        # Добавляем кадр в активную запись (если она идет)
        if self._s3_manager and camera_id in self._video_recorders:
            recorder = self._video_recorders[camera_id]
            if recorder.is_recording:
                recorder.buffer.append(frame_data)
                recorder.buffer_size_bytes += len(frame_data)
        
        # Рассылаем кадр всем подключенным зрителям
        if camera_id in self.viewer_connections:
            viewers = self.viewer_connections[camera_id]
            dead = set()
            
            for viewer in viewers:
                try:
                    await viewer.send_bytes(frame_data)
                except Exception as e:
                    # Зритель отключился, удалим его
                    logger.debug(f"⚠️ Ошибка отправки кадра зрителю: {e}")
                    dead.add(viewer)
            
            # Удаляем мертвые подключения
            if dead:
                viewers -= dead
                logger.debug(f"🗑️ [{camera_id}] Удалено {len(dead)} мертвых подключений")
    
    # ========== РАБОТА СО ЗРИТЕЛЯМИ ==========
    
    async def handle_viewer_websocket(self, websocket: WebSocket, camera_id: str):
        """
        Обработка WebSocket зрителя.
        Когда зритель подключается → включаем стрим
        Когда отключается → observer loop решит выключить ли камеру
        """
        viewer_id = None
        try:
            await websocket.accept(subprotocol="access_key")
            
            # Проверка ключа доступа (здесь можно добавить логику)
            # Пока пропускаем для разработки
            
            # Инициализируем трекинг зрителей если нужно
            if camera_id not in self.viewer_connections:
                self.viewer_connections[camera_id] = set()
            
            if camera_id not in self._viewer_connected_at:
                self._viewer_connected_at[camera_id] = {}

            # Генерируем уникальный ID зрителя и отслеживаем время подключения
            viewer_id = str(uuid.uuid4())
            connected_at = time.time()
            
            self._viewer_connected_at[camera_id][viewer_id] = connected_at
            self.viewer_connections[camera_id].add(websocket)
            
            logger.info(
                f"👁 Зритель {viewer_id[:8]} подключился к {camera_id}. "
                f"Всего зрителей: {len(self.viewer_connections[camera_id])}"
            )

            # **Включаем камеру для стрима**
            await self.control_camera(camera_id=camera_id, action="start")
            
            # Отправляем последний кадр если он есть
            if camera_id in self.cameras and self.cameras[camera_id].last_frame:
                try:
                    await websocket.send_bytes(self.cameras[camera_id].last_frame)
                except Exception as e:
                    logger.error(f"⚠️ Ошибка отправки первого кадра: {e}")
            
            # Пинг-понг для отслеживания живых подключений
            last_ping = time.time()
            while True:
                try:
                    # Отправляем периодические пинги
                    if time.time() - last_ping > 10:
                        await websocket.send_text("ping")
                        last_ping = time.time()
                    
                    # Слушаем входящие сообщения с таймаутом
                    message = await asyncio.wait_for(websocket.receive_text(), timeout=1.0)
                    
                    if message == "ping":
                        await websocket.send_text("pong")
                    elif message.startswith("fps:") and camera_id in self.esp_connections:
                        # Пробрасываем команду смены FPS/качества на камеру
                        await self.esp_connections[camera_id].send_text(message)
                        
                except asyncio.TimeoutError:
                    # Таймаут на receive нормален, просто продолжаем пинг
                    continue
                except Exception:
                    # Соединение разорвано
                    break
                    
        except Exception as e:
            logger.error(f"❌ Ошибка зрителя для {camera_id}: {e}", exc_info=True)
        finally:
            # Отключаемся и даём observer loop решить выключать ли камеру
            if camera_id in self.viewer_connections:
                self.viewer_connections[camera_id].discard(websocket)
                
                if viewer_id and camera_id in self._viewer_connected_at:
                    self._viewer_connected_at[camera_id].pop(viewer_id, None)
                
                logger.info(
                    f"👁 Зритель {viewer_id[:8] if viewer_id else 'unknown'} отключился. "
                    f"Осталось: {len(self.viewer_connections[camera_id])}"
                )
    
    # ========== УПРАВЛЕНИЕ РАЗРЕШЕНИЕМ ==========
    
    async def set_resolution(self, camera_id: str, resolution: str, access_key: str = None) -> dict:
        """Изменить разрешение камеры"""
        valid_resolutions = ["QVGA", "VGA", "HD"]
        if resolution not in valid_resolutions:
            return {"error": f"Resolution must be one of {valid_resolutions}"}, 400
        
        if camera_id not in self.esp_connections:
            return {"error": "Camera not connected"}, 404
        
        try:
            ws = self.esp_connections[camera_id]
            await ws.send_text(f"size:{resolution}")
            logger.info(f"✅ Command sent to {camera_id}: {resolution}")
            return {"status": "command_sent", "camera": camera_id, "resolution": resolution}
        except Exception as e:
            return {"error": str(e)}, 500
    
    # ========== СТАТУС КАМЕРЫ ==========
    
    async def get_status(self, camera_id: str, access_key: str = None) -> dict:
        """Получить статус камеры с полной информацией"""
        if camera_id not in self.cameras:
            return {"error": "Camera not found"}, 404
        
        cam = self.cameras[camera_id]
        
        # Информация о текущей записи
        recording_info = None
        if camera_id in self._video_recorders:
            recorder = self._video_recorders[camera_id]
            if recorder.is_recording:
                recording_info = RecordingInfo(
                    is_recording=True,
                    duration_seconds=int((_get_izhevsk_time() - recorder.start_time).total_seconds()),
                    frames=len(recorder.buffer),
                    max_duration=recorder.max_duration
                )
        
        # Собираем статус в схему
        status = CameraStatus(
            fps=cam.fps,
            reported_fps=cam.reported_fps,
            quality_mode=cam.quality_mode,
            viewers=len(self.viewer_connections.get(camera_id, set())),
            last_frame_size=len(cam.last_frame) if cam.last_frame else 0,
            connected=camera_id in self.esp_connections,
            recording=recording_info,
            camera_is_active=cam.active,  # Теперь из одной схемы
            record_is_active=bool(self._video_recorders.get(camera_id))  # Проверяем есть ли запись
        )
        
        return status.dict()
    
    # ========== ЗАПИСЬ ВИДЕО ==========
    
    async def start_recording(self, camera_id: str, max_duration: int = 15):
        """
        Начать или продлить запись видео.
        
        Если запись уже идет - продляет процесс обновляя last_activity_time.
        Максимальная длительность одной записи - 5 минут (300 секунд).
        По истечении 30 секунд БЕЗ вызова start_recording - запись сохраняется автоматически.
        """
        if not self._s3_manager:
            logger.warning("⚠️ S3 manager not configured")
            return
        
        if camera_id not in self.esp_connections:
            logger.warning(f"⚠️ Camera {camera_id} not connected, recording cannot start.")
            return
        
        # ЕСЛИ УЖЕ ИДЕТ ЗАПИСЬ - ПРОДЛЯЕМ ЕЕ
        if camera_id in self._video_recorders and self._video_recorders[camera_id].is_recording:
            recorder = self._video_recorders[camera_id]
            current_duration = (_get_izhevsk_time() - recorder.start_time).total_seconds()
            
            # Если уже записываем 5 минут - не продляем дальше
            if current_duration >= 300:
                logger.warning(
                    f"⚠️ Recording for {camera_id} reached max duration (5 min). "
                    f"Will save automatically when timer expires."
                )
                return
            
            # 🔧 ПРОДЛЯЕМ ЗАПИСЬ - просто обновляем время последней активности
            recorder.last_activity_time = _get_izhevsk_time().timestamp()
            
            logger.info(
                f"⏱️ Extended recording for {camera_id}. "
                f"Current duration: {current_duration:.1f}s, will stop after {max_duration}s of silence"
            )
            return
        
        # НОВАЯ ЗАПИСЬ - ВКЛЮЧАЕМ КАМЕРУ
        new_recorder = VideoRecorder(
            camera_id=camera_id,
            buffer=[],
            buffer_size_bytes=0,
            start_time=_get_izhevsk_time(),
            is_recording=True,
            max_duration=max_duration,
            stop_task_id=None,
            last_activity_time=_get_izhevsk_time().timestamp()
        )
        
        # Запускаем таск автостопа - ОН БУДЕТ ПРОВЕРЯТЬ last_activity_time
        stop_task = asyncio.create_task(self._auto_stop_recording(camera_id, max_duration))
        self._recording_tasks[camera_id] = stop_task
        
        self._video_recorders[camera_id] = new_recorder
        
        # Убетьсяемся, что камера включена
        camera = self.cameras.get(camera_id)
        if camera and not camera.active:
            await self.control_camera(camera_id, "start")
        
        logger.info(
            f"🎥 [{camera_id}] Recording started, "
            f"will auto-save after {max_duration}s or 5min max"
        )
    
    async def stop_recording(self, camera_id: str) -> Optional[str]:
        """Остановить запись и сохранить видео в S3 с thumbnail"""
        recorder = self._video_recorders.get(camera_id)
        if not recorder or not recorder.is_recording:
            return None
        
        # Отменяем авто-остановку
        if camera_id in self._recording_tasks:
            task = self._recording_tasks[camera_id]
            if not task.done():
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
            del self._recording_tasks[camera_id]
        
        recorder.is_recording = False
        end_time = _get_izhevsk_time()
        duration = (end_time - recorder.start_time).total_seconds()
        
        if not recorder.buffer:
            logger.warning(f"⚠️ [{camera_id}] No frames, discarding")
            # 🔧 ОЧИСТКА ПАМЯТИ ДАЖЕ ПРИ ПУСТОМ БУФЕРЕ
            recorder.buffer.clear()
            recorder.buffer_size_bytes = 0
            del self._video_recorders[camera_id]
            gc.collect()
            return None
        
        logger.info(f"🔄 [{camera_id}] Converting {len(recorder.buffer)} frames ({recorder.buffer_size_bytes/1024/1024:.1f}MB)...")
        temp_dir = tempfile.mkdtemp()
        
        try:
            # Сохраняем JPEG кадры
            for i, jpeg_data in enumerate(recorder.buffer):
                with open(os.path.join(temp_dir, f"frame_{i:06d}.jpg"), "wb") as f:
                    f.write(jpeg_data)
            
            # Конвертируем в MP4
            fps = len(recorder.buffer) / duration if duration > 0 else 15.0
            fps = min(max(fps, 10), 30)
            output_path = os.path.join(temp_dir, "output.mp4")
            
            subprocess.run([
                "ffmpeg", "-framerate", str(fps),
                "-i", f"{temp_dir}/frame_%06d.jpg",
                "-c:v", "libx264", "-pix_fmt", "yuv420p",
                "-preset", "fast", "-crf", "23", "-y", output_path
            ], check=True, capture_output=True)
            
            # 🔧 СОХРАНЯЕМ THUMBNAIL (кадр после ~1 сек)
            thumbnail_frame_idx = int(fps) if fps > 0 else 0  # Примерно 1 сек
            if thumbnail_frame_idx >= len(recorder.buffer):
                thumbnail_frame_idx = len(recorder.buffer) // 2  # Середина если не хватает
            if thumbnail_frame_idx >= len(recorder.buffer):
                thumbnail_frame_idx = 0  # Первый кадр
            
            thumbnail_data = recorder.buffer[thumbnail_frame_idx]
            
            # Читаем и сохраняем видео в S3
            with open(output_path, "rb") as f:
                await self._s3_manager.save_video(
                    camera_id, f.read(), recorder.start_time,
                    int(duration),
                    {
                        "end_time": end_time.isoformat(),
                        "frames": len(recorder.buffer),
                        "fps": round(fps, 1)
                    }
                )
            
            # 🔧 ОЧИЩАЕМ БУФЕР СРАЗУ ПОСЛЕ СОХРАНЕНИЯ В S3
            buffer_size_mb = recorder.buffer_size_bytes / 1024 / 1024
            recorder.buffer.clear()
            recorder.buffer_size_bytes = 0
            logger.debug(f"🧹 [{camera_id}] Buffer cleared after S3 save ({buffer_size_mb:.1f}MB freed)")
            
            # Сохраняем thumbnail как отдельный файл
            # Формат: videos/{camera_id}/{YYYY}/{MM}/{DD}/{timestamp}_thumb.jpg
            await self._save_thumbnail(camera_id, recorder.start_time, thumbnail_data)
            
            logger.info(f"💾 [{camera_id}] Saved {duration:.1f}s, {len(recorder.buffer)} frames + thumbnail")
            
        except Exception as e:
            logger.error(f"❌ Failed to save: {e}", exc_info=True)
            return None
        finally:
            # 🔧 ЯВНАЯ ОЧИСТКА ПАМЯТИ
            if camera_id in self._video_recorders:
                recorder = self._video_recorders[camera_id]
                # Очищаем буфер кадров
                recorder.buffer.clear()
                recorder.buffer_size_bytes = 0
                logger.debug(f"🧹 [{camera_id}] Buffer cleared ({len(recorder.buffer)} frames)")
            
            shutil.rmtree(temp_dir, ignore_errors=True)
            del self._video_recorders[camera_id]
            
            # Принудительный сбор мусора для освобождения памяти
            gc.collect()
            logger.debug(f"🗑️ [{camera_id}] Memory cleanup completed")
        
        return "ok"
    
    async def force_stop_recording(self, camera_id: str) -> Optional[str]:
        """Принудительно остановить запись (даже если она активна)"""
        if camera_id not in self._video_recorders:
            logger.info(f"ℹ️ [{camera_id}] No active recording to stop")
            return None
        
        logger.info(f"🛑 [{camera_id}] Force stopping recording...")
        return await self.stop_recording(camera_id)
    
    async def _auto_stop_recording(self, camera_id: str, max_duration: int):
        """
        Auto-save recording after max_duration seconds of SILENCE (no activity).
        
        Проверяет last_activity_time каждую секунду.
        Если прошло max_duration сек БЕЗ обновления last_activity_time - сохраняет запись.
        Максимум 5 минут от начала записи.
        """
        try:
            while camera_id in self._video_recorders:
                recorder = self._video_recorders[camera_id]
                if not recorder.is_recording:
                    return
                
                current_time = time.time()
                silence_duration = current_time - recorder.last_activity_time
                recording_duration = (_get_izhevsk_time() - recorder.start_time).total_seconds()
                
                # Условие 1: Прошло max_duration сек молчания
                if silence_duration >= max_duration:
                    logger.info(f"⏱️ [{camera_id}] Auto-saving ({max_duration}s silence)")
                    await self.stop_recording(camera_id)
                    return
                
                # Условие 2: Прошло 5 минут от начала записи (максимум)
                if recording_duration >= 300:
                    logger.info(f"⏱️ [{camera_id}] Auto-saving (5min max reached)")
                    await self.stop_recording(camera_id)
                    return
                
                # Ждем 1 сек перед следующей проверкой
                await asyncio.sleep(1)
                
        except asyncio.CancelledError:
            logger.debug(f"🔄 [{camera_id}] Recording watcher cancelled")
    
    async def _save_thumbnail(self, camera_id: str, start_time: datetime, thumbnail_data: bytes):
        """Сохранить thumbnail (превью кадр) в S3"""
        if not self._s3_manager:
            logger.warning("⚠️ S3 manager не доступен для thumbnail")
            return
        
        try:
            # Формат файла: videos/{camera_id}/{YYYY}/{MM}/{DD}/{timestamp}_thumb.jpg
            # Пример: videos/cam1/2026/03/27/1711533840_thumb.jpg
            timestamp = int(start_time.timestamp())
            year = start_time.strftime("%Y")
            month = start_time.strftime("%m")
            day = start_time.strftime("%d")
            
            # Используем boto3 напрямую (S3Manager должен предоставить client)
            key = f"videos/{camera_id}/{year}/{month}/{day}/{timestamp}_thumb.jpg"
            
            # 🔧 БЕЗ AWAIT - это синхронная операция
            # Выполняем в executor чтобы не блокировать event loop
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, lambda: self._s3_manager.client.put_object(
                Bucket=self._s3_manager.bucket_name,
                Key=key,
                Body=thumbnail_data,
                ContentType="image/jpeg",
                Metadata={
                    "camera": camera_id,
                    "type": "thumbnail",
                    "timestamp": str(timestamp)
                }
            ))
            
            logger.debug(f"🖼️ [{camera_id}] Thumbnail saved: {key}")
            
        except Exception as e:
            logger.error(f"❌ Failed to save thumbnail: {e}")
    
    async def get_thumbnail(self, camera_id: str, timestamp: int) -> Optional[bytes]:
        """Получить thumbnail по camera_id и timestamp видео"""
        if not self._s3_manager:
            return None
        
        try:
            start_time = datetime.fromtimestamp(timestamp)
            year = start_time.strftime("%Y")
            month = start_time.strftime("%m")
            day = start_time.strftime("%d")
            
            key = f"videos/{camera_id}/{year}/{month}/{day}/{timestamp}_thumb.jpg"
            
            # 🔧 БЕЗ AWAIT - это синхронная операция
            loop = asyncio.get_event_loop()
            response = await loop.run_in_executor(None, lambda: self._s3_manager.client.get_object(
                Bucket=self._s3_manager.bucket_name,
                Key=key
            ))
            
            # Читаем Body синхронно
            thumbnail = response['Body'].read()
            logger.debug(f"🖼️ Retrieved thumbnail: {key}")
            return thumbnail
            
        except Exception as e:
            logger.debug(f"⚠️ Thumbnail not found for {camera_id}/{timestamp}: {e}")
            return None

    async def list_videos(
        self,
        camera_id: Optional[str] = None
    ) -> list:
        """Получить список видео из S3"""
        if not self._s3_manager:
            raise ValueError("S3 manager not configured")
        
        return await self._s3_manager.list_videos(
            camera_id=camera_id
        )

    async def get_video(self, key: str) -> Optional[bytes]:
        """Получить видео из S3 по ключу"""
        if not self._s3_manager:
            raise ValueError("S3 manager not configured")
        
        return await self._s3_manager.get_video(key)

    async def get_video_presigned_url(self, key: str, expires_in: int = 3600) -> Optional[str]:
        """Получить подписанную ссылку на видео"""
        if not self._s3_manager:
            raise ValueError("S3 manager not configured")
        
        return await self._s3_manager.get_video_presigned_url(key, expires_in)

    async def delete_video(self, key: str) -> bool:
        """Удалить видео по ключу"""
        if not self._s3_manager:
            raise ValueError("S3 manager not configured")
        
        return await self._s3_manager.delete_video(key)