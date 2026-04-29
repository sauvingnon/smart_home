# app/services/video_service.py
import asyncio
from datetime import datetime, timezone, timedelta
from typing import Dict, Optional, Set
from fastapi import WebSocket
from app.services.video_service.video_chunk_service import VideoChunkService
from logger import logger
from config import API_BASE_URL
from app.schemas.camera import CameraState, CameraMode, CameraMetrics
from app.core.auth import get_auth_manager
from app.utils.time import _get_izhevsk_time
from app.services.s3_service.s3_manager import S3Manager
from app.services.redis.cache_manager import CacheManager
import tempfile
import os
from starlette.websockets import WebSocketDisconnect, WebSocketState
from config import CAMERA_ID, CAMERA_ACCESS_KEY

class VideoService:
    """Сервис управления камерами — базовая версия (только подключение и метрики)"""
    
    def __init__(self, s3_manager: S3Manager, cache_manager: CacheManager):
        self.s3_manager = s3_manager
        self.cache_manager = cache_manager

        # Состояние всех камер
        self.cameras: Dict[str, CameraState] = {}
        # WebSocket соединения камер
        self.connections: Dict[str, WebSocket] = {}
        # WebSoket соединения зрителей
        self.viewers: Dict[str, Set[WebSocket]] = {}
        # Простая авторизация (потом вынесите в базу)
        self.valid_keys = {CAMERA_ID: CAMERA_ACCESS_KEY}
        # Таймеры авто-остановки записи: camera_id -> asyncio.Task
        self._recording_timers: Dict[str, asyncio.Task] = {}
        # Сервис для управления сессиями загрузки видео по чанкам
        self.chunk_service = VideoChunkService(ttl_seconds=300)

        self._tasks: Dict[str, asyncio.Task] = {}
    
    async def start(self):
        """Запустить фоновый ping-pong watcher"""
        logger.info("✅ VideoService (базовый) запущен")
        asyncio.create_task(self._cleanup_loop())

    async def _cleanup_loop(self):
        """Раз в сутки удаляет видео старше 7 дней"""
        while True:
            try:
                await self._cleanup_old_videos()
            except Exception as e:
                logger.error(f"❌ Ошибка в cleanup loop: {e}")
            
            await asyncio.sleep(24 * 60 * 60)  # 24 часа

    async def _cleanup_old_videos(self):
        """Удаляет видео старше 7 дней из S3"""
        if not self.s3_manager:
            return

        logger.info("🧹 Запуск очистки старых видео...")

        IZHEVSK_TZ = timezone(timedelta(hours=4))
        cutoff = datetime.now(tz=IZHEVSK_TZ) - timedelta(days=7)
        deleted_count = 0
        deleted_bytes = 0

        try:
            all_videos = await self.s3_manager.list_videos(
                camera_id=None,
                token="internal",
                url=""
            )

            for video in all_videos:
                try:
                    video_date = None

                    if video.get('start_time'):
                        try:
                            dt = datetime.fromisoformat(video['start_time'])
                            # Если naive — считаем что это уже ижевское время
                            if dt.tzinfo is None:
                                video_date = dt.replace(tzinfo=IZHEVSK_TZ)
                            else:
                                video_date = dt.astimezone(IZHEVSK_TZ)
                        except (ValueError, TypeError):
                            pass

                    if video_date is None:
                        last_modified = video.get('last_modified')
                        if last_modified:
                            if isinstance(last_modified, datetime):
                                if last_modified.tzinfo is None:
                                    video_date = last_modified.replace(tzinfo=IZHEVSK_TZ)
                                else:
                                    video_date = last_modified.astimezone(IZHEVSK_TZ)
                            else:
                                try:
                                    dt = datetime.fromisoformat(str(last_modified))
                                    if dt.tzinfo is None:
                                        video_date = dt.replace(tzinfo=IZHEVSK_TZ)
                                    else:
                                        video_date = dt.astimezone(IZHEVSK_TZ)
                                except (ValueError, TypeError):
                                    pass

                    if video_date is None:
                        logger.warning(f"⚠️ Нет даты для видео {video.get('video_id')}, пропускаем")
                        continue

                    if video_date < cutoff:
                        camera_id = video.get('camera_id', 'unknown')
                        video_id = video.get('video_id')
                        key = video.get('key')
                        size = video.get('size_bytes', 0)

                        success = await self.s3_manager.delete_video(key)

                        if success:
                            deleted_bytes += size
                            deleted_count += 1

                            if video_id:
                                thumb_key = f"thumbnails/{camera_id}/{video_id}.jpg"
                                try:
                                    await self.s3_manager.delete_video(thumb_key)
                                except Exception:
                                    pass

                                try:
                                    if video.get('start_time'):
                                        ts = int(datetime.fromisoformat(video['start_time']).timestamp())
                                        dedup_key = f"video_dedup:{camera_id}:{ts}"
                                        await self.cache_manager.redis_client.delete(dedup_key)
                                except Exception:
                                    pass

                            logger.info(
                                f"🗑️ Удалено старое видео: {key} "
                                f"(дата: {video_date.strftime('%Y-%m-%d %H:%M')} UTC+4, "
                                f"размер: {size // 1024}КБ)"
                            )

                except Exception as e:
                    logger.error(f"❌ Ошибка при удалении видео {video.get('key')}: {e}")
                    continue

            logger.info(
                f"✅ Очистка завершена: удалено {deleted_count} видео, "
                f"освобождено {deleted_bytes // (1024 * 1024)}МБ"
            )

        except Exception as e:
            logger.error(f"❌ Ошибка очистки старых видео: {e}", exc_info=True)

    async def handle_viewer_websocket(self, websocket: WebSocket, camera_id: str):
        """Обработка WebSocket соединения от зрителя"""
        await websocket.accept()
        viewer_added = False
        
        try:
            # Auth через cookie из WS handshake headers
            from app.core.auth import COOKIE_NAME
            access_key = websocket.cookies.get(COOKIE_NAME)
            if not access_key:
                await websocket.send_text("ERROR: Not authenticated")
                return

            auth_manager = get_auth_manager()
            if not await auth_manager.verify_access_key(access_key):
                await websocket.send_text("ERROR: Invalid session")
                return

            # Проверяем что камера подключена
            if camera_id not in self.connections:
                await websocket.send_text("ERROR: Camera offline")
                return
            
            # Отправляем подтверждение
            await websocket.send_text("AUTH_OK")
            
            # Добавляем зрителя
            if camera_id not in self.viewers:
                self.viewers[camera_id] = set()
            self.viewers[camera_id].add(websocket)
            viewer_added = True
            
            logger.info(f"👁️ Зритель подключился к {camera_id}, всего: {len(self.viewers[camera_id])}")
            
            # Если это первый зритель - включаем стрим на камере
            if len(self.viewers[camera_id]) == 1:
                await self.send_command(camera_id, "stream_state:on")
                logger.info(f"📹 Включили стрим для {camera_id} (первый зритель)")
            
            # Держим соединение
            while True:
                try:
                    msg = await asyncio.wait_for(websocket.receive_text(), timeout=60.0)
                    if msg == "ping":
                        await websocket.send_text("pong")
                except asyncio.TimeoutError:
                    # Отправляем ping
                    try:
                        await websocket.send_text("ping")
                    except:
                        break  # Соединение закрыто
                        
        except Exception as e:
            logger.error(f"❌ Ошибка зрителя {camera_id}: {e}")
            
        finally:
            # Удаляем зрителя
            if viewer_added and camera_id in self.viewers:
                self.viewers[camera_id].discard(websocket)
                viewers_left = len(self.viewers[camera_id])
                
                # Если зрителей не осталось - выключаем стрим
                if viewers_left == 0:
                    try:
                        await self.send_command(camera_id, "stream_state:off")
                        logger.info(f"📹 Выключили стрим для {camera_id} (нет зрителей)")
                    except:
                        pass
                    del self.viewers[camera_id]
            
            # 🔧 Закрываем соединение только если оно еще открыто
            try:
                await websocket.close()
            except:
                pass  # Уже закрыто или ошибка - игнорируем
            
            logger.info(f"👁️ Зритель отключился от {camera_id}")

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

            self._tasks[camera_id] = asyncio.current_task()
            
            if self.valid_keys.get(camera_id) != access_key:
                await websocket.close(code=1008, reason="Invalid key")
                return
            
            # ---- Старое соединение? закрываем ----
            if camera_id in self.connections:
                old_ws = self.connections[camera_id]
                try:
                    # ВАЖНО: Сначала отменяем задачу, которая крутит receive
                    if camera_id in self._tasks:
                        self._tasks[camera_id].cancel()
                    await old_ws.close(code=1000, reason="New connection")
                except:
                    pass
            
            # ---- Сохраняем новое соединение ----
            self.connections[camera_id] = websocket
            
            # ---- Инициализируем или обновляем состояние ----
            if camera_id not in self.cameras:
                self.cameras[camera_id] = CameraState(camera_id=camera_id)
            
            self.cameras[camera_id].mode = CameraMode.CONNECTED
            self.cameras[camera_id].connected_at = _get_izhevsk_time()
            self.cameras[camera_id].last_seen = _get_izhevsk_time()

            # 👇 Если есть зрители - сразу включаем стрим
            if camera_id in self.viewers and len(self.viewers[camera_id]) > 0:
                await self.send_command(camera_id, "stream_state:on")
                logger.info(f"📹 [{camera_id}] Включаем стрим после реконнекта (есть {len(self.viewers[camera_id])} зрителей)")
            
            logger.info(f"✅ Камера {camera_id} подключена")
            await websocket.send_text("AUTH_OK")
            
            # ---- Цикл приёма сообщений ----
            while websocket.client_state == WebSocketState.CONNECTED:
                try:
                    message = await asyncio.wait_for(websocket.receive(), timeout=60.0)
                    
                    # Проверяем наличие текстового поля
                    if 'text' in message:
                        await self._handle_text(camera_id, message['text'])
                        
                    elif 'bytes' in message:
                        # Кадр от камеры
                        if camera_id in self.cameras:
                            self.cameras[camera_id].last_seen = _get_izhevsk_time()
                        
                        # 🔧 Рассылаем зрителям
                        await self._broadcast_frame(camera_id, message['bytes'])
                        
                except asyncio.TimeoutError:
                    # Отправляем пинг для поддержания соединения
                    try:
                        await websocket.send_text("ping")
                    except:
                        break
                except RuntimeError as e:
                    # Сокет уже закрыт — выходим тихо
                    if "disconnect message" in str(e):
                        logger.info(f"🔌 [{camera_id}] Соединение закрыто (нормально)")
                        break
                    raise
        except WebSocketDisconnect:
            logger.info(f"🔌 [{camera_id}] WebSocket disconnect")
        except Exception as e:
            logger.error(f"❌ Ошибка при обработке {camera_id}: {e}", exc_info=True)
        finally:
            self.cameras[camera_id].mode = CameraMode.OFFLINE
            await self._disconnect_camera(camera_id)
    
    async def _handle_text(self, camera_id: str, text: str):
        """Обработка текстовых сообщений от камеры (метрики, pong, команды)"""
        state = self.cameras.get(camera_id)
        if not state:
            logger.warning(f"⚠️ Нет состояния для {camera_id}")
            return
        
        # Обновляем время последней активности
        state.last_seen = _get_izhevsk_time()
        
        # ---- Метрики (fps:30;quality_mode:2;tmp:45.5;state:STREAMING;fan:1) ----
        if text.startswith("fps:"):
            try:
                metrics = state.metrics
                _STATE_MAP = {
                    "STREAMING": CameraMode.STREAMING,
                    "RECORDING": CameraMode.RECORDING,
                    "IDLE":      CameraMode.CONNECTED,
                    "OFFLINE":   CameraMode.OFFLINE,
                }
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
                    elif key == 'state':
                        state.mode = _STATE_MAP.get(val, CameraMode.CONNECTED)
                    elif key == 'fan':
                        metrics.is_fan_active = bool(int(val))

                metrics.last_metrics_time = _get_izhevsk_time()

            except Exception as e:
                logger.error(f"❌ Ошибка парсинга метрик {camera_id}: {e}")
            return
                
        # ---- Другие команды (можно расширять) ----
        if text == "stream_state:ok":
            logger.info(f"✅ [{camera_id}] Камера подтвердила изменение стрима")
            return
        elif text == "stream_state:off":
            logger.info(f"📹 [{camera_id}] Плата выключила стрим")
            if camera_id in self.cameras:
                if self.cameras[camera_id].mode == CameraMode.STREAMING:
                    self.cameras[camera_id].mode = CameraMode.CONNECTED
            return
        elif text == "stream_state:error:recording_active":
            logger.warning(f"⚠️ [{camera_id}] Нельзя управлять стримом во время записи")
            return
        elif text == "stream_state:error:camera_init_failed":
            logger.error(f"🔴 [{camera_id}] Камера не смогла инициализироваться")
            if camera_id in self.cameras:
                self.cameras[camera_id].mode = CameraMode.CONNECTED
            return
        elif text == "stream_state:error:camera_off":
            logger.error(f"🔴 [{camera_id}] КРИТИЧНО: стрим шёл но камера выключена")
            if camera_id in self.cameras:
                self.cameras[camera_id].mode = CameraMode.CONNECTED
            return
        elif text == "stream_state:error":
            logger.error(f"❌ [{camera_id}] Общая ошибка управления стримом")
            return

        # ---- record ----
        elif text.startswith("record:"):
            logger.info(f"📹 [{camera_id}] Record status: {text}")

            if text == "record:started":
                if camera_id in self.cameras:
                    self.cameras[camera_id].mode = CameraMode.RECORDING

            elif text in ("record:stopped", "record:stopped:timeout"):
                if text == "record:stopped:timeout":
                    logger.warning(f"⏱️ [{camera_id}] Запись остановлена по таймауту на плате")
                # Гасим серверный таймер — плата уже остановила сама
                old_task = self._recording_timers.pop(camera_id, None)
                if old_task and not old_task.done():
                    old_task.cancel()
                if camera_id in self.cameras:
                    self.cameras[camera_id].mode = CameraMode.CONNECTED
                if camera_id in self.viewers and len(self.viewers[camera_id]) > 0:
                    await self.send_command(camera_id, "stream_state:on")
                    logger.info(f"📹 [{camera_id}] Возобновляем стрим после записи (есть {len(self.viewers[camera_id])} зрителей)")

            elif text == "record:error:no_sd":
                logger.error(f"💾 [{camera_id}] SD карта недоступна, запись невозможна")
                old_task = self._recording_timers.pop(camera_id, None)
                if old_task and not old_task.done():
                    old_task.cancel()
                if camera_id in self.cameras:
                    self.cameras[camera_id].mode = CameraMode.CONNECTED

            elif text == "record:error:already":
                logger.warning(f"⚠️ [{camera_id}] Запись уже идёт, повторный старт проигнорирован")

            elif text == "record:error:camera_off":
                logger.error(f"🔴 [{camera_id}] КРИТИЧНО: запись шла но камера выключена")
                old_task = self._recording_timers.pop(camera_id, None)
                if old_task and not old_task.done():
                    old_task.cancel()
                if camera_id in self.cameras:
                    self.cameras[camera_id].mode = CameraMode.CONNECTED

            elif text == "record:error:write_failed":
                logger.error(f"💾 [{camera_id}] Ошибка записи на SD, запись прервана")
                old_task = self._recording_timers.pop(camera_id, None)
                if old_task and not old_task.done():
                    old_task.cancel()
                if camera_id in self.cameras:
                    self.cameras[camera_id].mode = CameraMode.CONNECTED

            elif text == "record:error":
                logger.error(f"❌ [{camera_id}] Общая ошибка записи (не удалось стартовать)")
                old_task = self._recording_timers.pop(camera_id, None)
                if old_task and not old_task.done():
                    old_task.cancel()
                if camera_id in self.cameras:
                    self.cameras[camera_id].mode = CameraMode.CONNECTED

            return

        # ---- size ----
        elif text == "size:ok":
            logger.info(f"✅ [{camera_id}] Разрешение изменено успешно")
            return
        elif text == "size:error":
            logger.error(f"❌ [{camera_id}] Не удалось изменить разрешение")
            return

        # ---- fan ----
        elif text == "fan:ok":
            logger.info(f"✅ [{camera_id}] Состояние вентилятора изменено")
            return

        # ---- queue ----
        elif text.startswith("queue:count:"):
            try:
                count = int(text.split(":")[2])
                logger.info(f"📤 [{camera_id}] Видео в очереди на отправку: {count}")
            except (IndexError, ValueError):
                logger.warning(f"⚠️ [{camera_id}] Не удалось распарсить queue:count: {text}")
            return

        logger.warning(f"⚠️ [{camera_id}] Неизвестное сообщение: {text[:100]}")
    
    async def _broadcast_frame(self, camera_id: str, frame_data: bytes):
        """Рассылка кадра всем зрителям камеры"""
        if camera_id not in self.viewers:
            return
        
        dead_viewers = []
        for viewer in self.viewers[camera_id]:
            try:
                await viewer.send_bytes(frame_data)
            except:
                dead_viewers.append(viewer)
        
        # Удаляем отвалившихся
        for viewer in dead_viewers:
            self.viewers[camera_id].discard(viewer)
        
        # Если все отвалились - выключаем стрим
        if len(self.viewers[camera_id]) == 0:
            await self.send_command(camera_id, "stream_state:off")
            del self.viewers[camera_id]

    async def _disconnect_camera(self, camera_id: str):
        """Закрыть соединение и обновить состояние"""
        if camera_id in self.connections:
            ws = self.connections.pop(camera_id)
            try:
                await ws.close()
            except:
                pass
        
        if camera_id in self.cameras:
            self.cameras[camera_id].mode = CameraMode.OFFLINE
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
        logger.debug(f"⏺️ [{camera_id}] Отправляем команду записи с timestamp: {timestampStr}")
        success = await self.send_command(camera_id, cmd)
        if success:
            await self._schedule_stop_recording(camera_id, delay=15)
        return success

    async def stop_recording(self, camera_id: str) -> bool:
        return await self.send_command(camera_id, "record:stop")

    async def get_queue_status(self, camera_id: str) -> Optional[int]:
        """Запросить очередь (ответ обработается асинхронно)"""
        await self.send_command(camera_id, "queue:status")
        return None

    async def set_fan(self, camera_id: str, enable: bool) -> bool:
        """Включить/выключить вентилятор на камере"""
        command = f"fan:{'on' if enable else 'off'}"
        success = await self.send_command(camera_id, command)
        
        if success:
            logger.info(f"🌀 [{camera_id}] Отправлена команда: {'Вкл' if enable else 'Выкл'} вентилятора")
        
        return success

    async def _schedule_stop_recording(self, camera_id: str, delay: int = 15):
        """Запустить (или перезапустить) таймер авто-остановки записи."""
        # Отменяем старый таймер, если был
        old_task = self._recording_timers.pop(camera_id, None)
        if old_task and not old_task.done():
            old_task.cancel()

        async def _do_stop():
            try:
                await asyncio.sleep(delay)
                logger.info(f"⏱️ [{camera_id}] Таймаут записи ({delay}с), отправляем stop")
                await self.stop_recording(camera_id)
            except asyncio.CancelledError:
                pass  # Таймер сброшен новым start_recording — это нормально
            finally:
                self._recording_timers.pop(camera_id, None)

        self._recording_timers[camera_id] = asyncio.create_task(_do_stop())
        logger.info(f"⏱️ [{camera_id}] Таймер записи запущен/сброшен ({delay}с)")

    # ---- Получение статуса ----
    async def get_camera_state(self, camera_id: str) -> Optional[CameraState]:
        status = self.cameras.get(camera_id)
        if not status:
            return None
        status.viewers = len(self.viewers)
        return status
    
    def verify_camera(self, camera_id: str, access_key: str) -> bool:
        return self.valid_keys.get(camera_id) == access_key

    # ---- Работа с s3 ----
    async def save_video_from_camera(
        self,
        camera_id: str,
        file_stream,
        start_timestamp: int,
        duration_seconds: int,
    ) -> Optional[str]:
        """
        Сохранить видео, загруженное камерой, и сгенерировать превью.
        
        Args:
            camera_id: ID камеры
            file_stream: поток видеофайла
            start_timestamp: Unix timestamp начала записи
            duration_seconds: длительность в секундах
        
        Returns:
            video_id: UUID сохранённого видео или None
        """
        
        # Проверяем, что камера известна системе
        if camera_id not in self.cameras:
            logger.warning(f"⚠️ Камера {camera_id} не в состоянии, но сохраняем видео")
        
        # Конвертируем timestamp в datetime
        try:
            izhevsk_tz = timezone(timedelta(hours=4))
            start_datetime = datetime.fromtimestamp(start_timestamp, tz=izhevsk_tz)
            logger.debug(f"📅 [{camera_id}] Полученный timestamp: {start_timestamp} -> {start_datetime.isoformat()}")
        except Exception as e:
            logger.error(f"❌ Неверный timestamp {start_timestamp}: {e}")
            return None
        
        # --- Проверка дубликата ---
        existing_id = await self.cache_manager.get_video_dedup(camera_id, start_timestamp)
        if existing_id:
            logger.warning(f"⚠️ [{camera_id}] Дубликат, возвращаем существующий ID: {existing_id}")
            return existing_id
        
        # Проверяем S3 manager
        if not self.s3_manager:
            logger.error("❌ S3 manager не настроен")
            return None
        
        temp_input_path = None
        temp_output_path = None
        temp_thumb_path = None
        
        try:
            # Сохраняем сырой MJPEG во временный файл
            with tempfile.NamedTemporaryFile(delete=False, suffix='.mjpeg') as temp_file:
                temp_input_path = temp_file.name
                if hasattr(file_stream, 'read'):
                    if hasattr(file_stream, 'seek'):
                        file_stream.seek(0)
                    file_content = file_stream.read()
                else:
                    file_content = file_stream
                temp_file.write(file_content)
                temp_file.flush()
            
            # 🔧 Определяем количество кадров в MJPEG файле
            # Считаем маркеры JPEG (FF D8 FF)
            frame_count = 0
            with open(temp_input_path, 'rb') as f:
                data = f.read()
                # Ищем JPEG заголовки
                i = 0
                while i < len(data) - 2:
                    if data[i] == 0xFF and data[i+1] == 0xD8 and data[i+2] == 0xFF:
                        frame_count += 1
                        i += 3
                    else:
                        i += 1
            
            # Вычисляем реальный fps
            if duration_seconds > 0 and frame_count > 0:
                fps = frame_count / duration_seconds
                logger.info(f"📊 [{camera_id}] Вычисленный fps: {fps:.2f} ({frame_count} кадров / {duration_seconds}с)")
            else:
                fps = 10  # fallback
                logger.warning(f"⚠️ [{camera_id}] Не удалось вычислить fps, используем {fps}")
            
            # Конвертируем MJPEG в MP4 с правильным fps
            temp_output_path = tempfile.NamedTemporaryFile(delete=False, suffix='.mp4').name
            
            cmd = [
                'ffmpeg',
                '-f', 'mjpeg',
                '-r', str(fps),          # 🔧 Явно указываем входной fps
                '-i', temp_input_path,
                '-c:v', 'libx264',
                '-preset', 'ultrafast',
                '-crf', '23',
                '-pix_fmt', 'yuv420p',
                '-movflags', '+faststart',
                '-y',
                temp_output_path
            ]
            
            logger.info(f"🎬 [{camera_id}] Конвертация видео с fps={fps:.2f}")
            
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            stdout, stderr = await process.communicate()
            
            if process.returncode != 0:
                logger.error(f"❌ FFmpeg conversion failed: {stderr.decode()}")
                return None
            
            # Сохраняем сконвертированный MP4 в S3
            with open(temp_output_path, 'rb') as video_file:
                video_id = await self.s3_manager.save_video_from_stream(
                    camera_id=camera_id,
                    file_stream=video_file,
                    start_time=start_datetime,
                    duration_seconds=duration_seconds,
                    metadata={
                        "upload_method": "esp32_push",
                        "camera_id": camera_id,
                        "format": "mp4",
                        "fps": fps,
                        "frame_count": frame_count
                    }
                )
            
            # Генерируем превью
            if video_id:
                try:
                    thumb_time = min(5, max(1, duration_seconds // 2))
                    temp_thumb_path = tempfile.NamedTemporaryFile(delete=False, suffix='.jpg').name
                    
                    cmd_thumb = [
                        'ffmpeg',
                        '-i', temp_output_path,
                        '-ss', str(thumb_time),
                        '-vframes', '1',
                        '-q:v', '2',
                        '-y',
                        temp_thumb_path
                    ]
                    
                    process = await asyncio.create_subprocess_exec(
                        *cmd_thumb,
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.PIPE
                    )
                    await process.communicate()
                    
                    if os.path.exists(temp_thumb_path) and os.path.getsize(temp_thumb_path) > 0:
                        with open(temp_thumb_path, 'rb') as thumb_file:
                            thumb_data = thumb_file.read()
                            await self.save_thumbnail(camera_id, video_id, thumb_data)
                            logger.info(f"🖼️ [{camera_id}] Превью сохранено для {video_id}")
                            
                except Exception as e:
                    logger.warning(f"⚠️ [{camera_id}] Ошибка создания превью: {e}")
            
            logger.info(f"✅ [{camera_id}] Видео сохранено: {video_id}, fps={fps:.2f}, кадров={frame_count}")

            await self.cache_manager.save_video_dedup(camera_id, start_timestamp, video_id)

            return video_id
            
        except Exception as e:
            logger.error(f"❌ Ошибка сохранения видео: {e}", exc_info=True)
            return None
            
        finally:
            for path in [temp_input_path, temp_output_path, temp_thumb_path]:
                if path and os.path.exists(path):
                    try:
                        os.unlink(path)
                    except:
                        pass

    async def get_video_list(
        self,
        camera_id: Optional[str] = None
    ) -> list:
        """
        Получить список видео.
        
        Args:
            camera_id: опционально фильтр по камере
        
        Returns:
            list: список видео с метаданными и presigned URLs
        """
        if not self.s3_manager:
            raise ValueError("S3 manager не доступен")
        
        token = await self.cache_manager.get_or_create_session_token(123)
        
        return await self.s3_manager.list_videos(camera_id=camera_id, token=token, url=API_BASE_URL)

    async def stream_video(
        self,
        camera_id: str,
        video_id: str,
        range_header: Optional[str] = None
    ) -> tuple[Optional[bytes], int, Optional[str], Optional[str]]:
        """
        Получить видео чанк для стриминга
        
        Args:
            camera_id: ID камеры
            video_id: ID видео
            range_header: Заголовок Range (например "bytes=0-1024")
        
        Returns:
            (data, file_size, content_range, error_message)
        """
        if not self.s3_manager:
            return None, 0, None, "S3 manager не доступен"
        
        # Находим ключ видео
        video_key = await self.s3_manager.get_video_key_by_id(camera_id, video_id)
        if not video_key:
            return None, 0, None, "Видео не найдено"
        
        # Парсим Range заголовок
        start = None
        end = None
        
        if range_header:
            try:
                range_match = range_header.replace('bytes=', '').split('-')
                start = int(range_match[0]) if range_match[0] else 0
                end = int(range_match[1]) if len(range_match) > 1 and range_match[1] else None
            except:
                return None, 0, None, "Неверный формат Range заголовка"
        
        # Получаем чанк
        data, file_size, content_range = await self.s3_manager.get_video_chunk(
            key=video_key,
            start=start,
            end=end
        )
        
        if data is None:
            return None, 0, None, "Ошибка загрузки видео"
        
        return data, file_size, content_range, None

    async def get_thumbnail(self, camera_id: str, video_id: str) -> Optional[bytes]:
        """Получить thumbnail из S3"""
        if not self.s3_manager:  # 🔧 ИСПРАВЛЕНИЕ: было self._s3_manager
            return None
        return await self.s3_manager.get_thumbnail(camera_id, video_id)

    async def get_video_presigned_url(
        self,
        camera_id: str,
        video_id: str,
        user_id: Optional[int] = None,  # 🔧 ИСПРАВЛЕНИЕ: сделали опциональным
        expires_in: int = 3600
    ) -> Optional[str]:
        """
        Получить подписанную ссылку на видео.
        """
        if not self.s3_manager:  # 🔧 ИСПРАВЛЕНИЕ: было self._s3_manager
            raise ValueError("S3 manager не доступен")
        
        # TODO: Проверка прав если user_id передан
        
        all_videos = await self.s3_manager.list_videos(camera_id=camera_id)
        
        for video in all_videos:
            if video.get('video_id') == video_id:
                return await self.s3_manager.get_video_presigned_url(video['key'], expires_in)
        
        return None

    async def get_video_by_id(self, camera_id: str, video_id: str) -> Optional[bytes]:
        """Скачать полное видео по video_id"""
        if not self.s3_manager:
            logger.error("❌ S3 manager не доступен")
            return None
        
        return await self.s3_manager.get_video_by_id(camera_id, video_id)

    async def delete_video(
        self,
        camera_id: str,
        video_id: str,
        user_id: Optional[int] = None  # 🔧 ИСПРАВЛЕНИЕ: сделали опциональным
    ) -> bool:
        """
        Удалить видео.
        """
        if not self.s3_manager:  # 🔧 ИСПРАВЛЕНИЕ: было self._s3_manager
            raise ValueError("S3 manager не доступен")
        
        # TODO: Проверка прав если user_id передан
        
        all_videos = await self.s3_manager.list_videos(camera_id=camera_id)
        
        for video in all_videos:
            if video.get('video_id') == video_id:
                # Удаляем видео
                success = await self.s3_manager.delete_video(video['key'])
                
                # Удаляем thumbnail (если есть)
                thumb_key = f"thumbnails/{camera_id}/{video_id}.jpg"
                try:
                    await self.s3_manager.delete_video(thumb_key)
                except:
                    pass  # Игнорируем ошибку если thumbnail нет
                
                if success:
                    logger.info(f"🗑️ [{camera_id}] Видео {video_id} удалено")
                    return True
        
        return False
    
    async def save_thumbnail(
        self,
        camera_id: str,
        video_id: str,
        thumbnail_data: bytes
    ) -> bool:
        """
        Сохранить thumbnail для видео.
        """
        if not self.s3_manager:
            logger.error("❌ S3 manager не доступен")
            return False
        
        return await self.s3_manager.save_thumbnail(camera_id, video_id, thumbnail_data)