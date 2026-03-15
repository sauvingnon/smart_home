from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Header
from pydantic import BaseModel
from logger import logger
from app.core.worker import WeatherBackgroundWorker
import time
from typing import Dict, Set
import asyncio

router = APIRouter(prefix="/esp_service", tags=["esp_service"])

# Хранилище последних кадров
cameras: Dict[str, dict] = {}

# Вебсокет соединения
esp_connections: Dict[str, WebSocket] = {}
viewer_connections: Dict[str, Set[WebSocket]] = {}

# Access keys
VALID_ACCESS_KEYS = {"cam1": "12345678"}

@router.websocket("/ws/camera")
async def websocket_camera(websocket: WebSocket):
    """WebSocket для ESP32 камеры"""
    await websocket.accept()
    
    camera_id = None
    last_frame_time = time.time()

    # Храним текущее качество для каждого подключения
    current_resolution = "VGA"  # по умолчанию
    
    try:
        # Авторизация с таймаутом
        try:
            auth_msg = await asyncio.wait_for(websocket.receive_text(), timeout=5.0)
        except asyncio.TimeoutError:
            logger.warning("Auth timeout")
            await websocket.close(code=1008, reason="Auth timeout")
            return
            
        logger.info(f"Auth: {auth_msg}")
        
        if not auth_msg.startswith("AUTH:"):
            await websocket.close(code=1008, reason="Invalid auth")
            return
        
        parts = auth_msg.split(":")
        if len(parts) < 3:
            await websocket.close(code=1008, reason="Invalid data")
            return
            
        access_key = parts[1]
        camera_id = parts[2]
        
        # Проверка ключа
        if VALID_ACCESS_KEYS.get(camera_id) != access_key:
            logger.warning(f"Invalid key for {camera_id}")
            await websocket.close(code=1008, reason="Invalid key")
            return
        
        # Отключаем старую камеру
        if camera_id in esp_connections:
            try:
                await esp_connections[camera_id].close()
            except:
                pass
        
        esp_connections[camera_id] = websocket
        logger.info(f"✅ Camera {camera_id} connected")
        
        # Инициализация
        if camera_id not in cameras:
            cameras[camera_id] = {
                "last_frame": None,
                "fps": 0,
                "last_time": time.time(),
                "frame_count": 0
            }
        
        # Подтверждение
        await websocket.send_text("AUTH_OK")
        
        last_ping = time.time()
        
        # Основной цикл
        while True:
            try:
                # Ждем сообщение с таймаутом
                message = await asyncio.wait_for(
                    websocket.receive(), 
                    timeout=5.0
                )
                
                # Проверяем тип сообщения
                if 'text' in message:
                    # Текстовое сообщение
                    text = message['text']
                    logger.info(f"📨 Received text from {camera_id}: {text}")
                    
                    # Обрабатываем FPS отчет
                    if text.startswith("fps:"):
                        try:
                            fps_value = int(text.split(":")[1])
                            logger.info(f"📊 Camera {camera_id} FPS: {fps_value}")
                            if camera_id in cameras:
                                cameras[camera_id]["reported_fps"] = fps_value
                        except:
                            pass
                    
                    # Обрабатываем ответ на команду size
                    elif text == "size:ok":
                        logger.info(f"✅ Camera {camera_id} confirmed resolution change")
                    elif text == "size:error":
                        logger.error(f"❌ Camera {camera_id} rejected resolution change")
                    
                elif 'bytes' in message:
                    # Бинарные данные (JPEG кадр)
                    frame_data = message['bytes']
                    last_frame_time = time.time()
                    
                    # ЛОГГИРОВАНИЕ ПРИЕМА КАДРА
                    # logger.info(f"📸 Received frame from {camera_id}: {len(frame_data)} bytes")
                    
                    # Обновляем статистику
                    cam = cameras[camera_id]
                    cam["last_frame"] = frame_data
                    cam["frame_count"] += 1
                    
                    now = time.time()
                    if now - cam["last_time"] >= 1.0:
                        cam["fps"] = cam["frame_count"]
                        cam["frame_count"] = 0
                        cam["last_time"] = now
                    
                    # Рассылка зрителям
                    if camera_id in viewer_connections:
                        dead = set()
                        for viewer in viewer_connections[camera_id]:
                            try:
                                await viewer.send_bytes(frame_data)
                                # logger.debug(f"   ✅ Sent to viewer")
                            except Exception as e:
                                # logger.error(f"   ❌ Failed to send: {e}")
                                dead.add(viewer)
                        
                        if dead:
                            viewer_connections[camera_id] -= dead
                            logger.info(f"   Removed {len(dead)} dead viewers")
                
            except asyncio.TimeoutError:
                # Проверка таймаута...
                if time.time() - last_frame_time > 60:
                    logger.warning(f"No frames from {camera_id} for 60s")
                    break
                
                if time.time() - last_ping > 10:
                    try:
                        await websocket.send_text("ping")
                        last_ping = time.time()
                    except:
                        break
                continue
                    
    except WebSocketDisconnect:
        logger.info(f"🔴 Camera {camera_id} disconnected")
    except Exception as e:
        logger.error(f"Camera error for {camera_id}: {e}")
    finally:
        if camera_id and camera_id in esp_connections:
            del esp_connections[camera_id]
            logger.info(f"Removed {camera_id} from connections")

@router.websocket("/ws/view/{camera_id}")
async def websocket_viewer(websocket: WebSocket, camera_id: str):
    """WebSocket для зрителей"""
    try:
        await websocket.accept(subprotocol="access_key")
        logger.debug(f"📡 Viewer WebSocket accepted for {camera_id}")
        
        # Проверка ключа
        worker = WeatherBackgroundWorker.get_instance()
        user_id = await worker.verify_websocket_key(websocket)
        
        if not user_id:
            logger.warning(f"❌ Invalid viewer access for {camera_id}")
            await websocket.close(code=1008, reason="Invalid key")
            return
        
        logger.info(f"✅ Viewer authenticated for {camera_id}, user_id: {user_id}")
        
        # Добавляем зрителя
        if camera_id not in viewer_connections:
            viewer_connections[camera_id] = set()
        
        viewer_connections[camera_id].add(websocket)
        logger.info(f"👁 Viewer for {camera_id}, total: {len(viewer_connections[camera_id])}")
        
        # Отправляем последний кадр
        if camera_id in cameras and cameras[camera_id]["last_frame"]:
            last_frame = cameras[camera_id]["last_frame"]
            logger.info(f"📤 Sending last frame to new viewer: {len(last_frame)} bytes")
            try:
                await websocket.send_bytes(last_frame)
                logger.debug(f"   Last frame sent successfully")
            except Exception as e:
                logger.error(f"   Failed to send last frame: {e}")
        
        # Пинг-понг
        last_ping = time.time()
        while True:
            try:
                if time.time() - last_ping > 10:
                    await websocket.send_text("ping")
                    logger.debug(f"📤 Sent ping to viewer {camera_id}")
                    last_ping = time.time()
                
                message = await asyncio.wait_for(websocket.receive_text(), timeout=1.0)
                logger.debug(f"📨 Received from viewer: {message}")
                
                if message == "ping":
                    await websocket.send_text("pong")
                    logger.debug(f"📤 Sent pong to viewer")
                elif message.startswith("fps:") and camera_id in esp_connections:
                    logger.info(f"🔄 Forwarding FPS command to camera: {message}")
                    await esp_connections[camera_id].send_text(message)
                        
            except asyncio.TimeoutError:
                continue
            except WebSocketDisconnect:
                logger.info(f"👋 Viewer disconnected from {camera_id}")
                break
            except Exception as e:
                logger.error(f"Error in viewer loop for {camera_id}: {e}")
                break
    
    except Exception as e:
        logger.error(f"Viewer error for {camera_id}: {e}")
    finally:
        if camera_id in viewer_connections:
            viewer_connections[camera_id].discard(websocket)
            remaining = len(viewer_connections.get(camera_id, set()))
            logger.info(f"Remaining viewers for {camera_id}: {remaining}")

# Модель для запроса смены разрешения
class ResolutionRequest(BaseModel):
    resolution: str

@router.post("/camera/{camera_id}/resolution")
async def set_camera_resolution(
    camera_id: str,
    request: ResolutionRequest,  # Pydantic модель
    access_key: str = Header(None, alias="X-Access-Key")  # Читаем из headers
):
    """Изменить разрешение камеры"""
    logger.info(f"📝 RESOLUTION CHANGE REQUEST: camera={camera_id}, resolution={request.resolution}")
    
    # Проверка ключа
    # if VALID_ACCESS_KEYS.get(camera_id) != access_key:
    #     logger.warning(f"❌ Invalid key for {camera_id}")
    #     return {"error": "Invalid key"}, 403
    
    if camera_id not in esp_connections:
        logger.error(f"❌ Camera {camera_id} not connected")
        return {"error": "Camera not connected"}, 404
    
    valid_resolutions = ["QVGA", "VGA", "HD"]
    if request.resolution not in valid_resolutions:
        return {"error": f"Resolution must be one of {valid_resolutions}"}, 400
    
    try:
        ws = esp_connections[camera_id]
        await ws.send_text(f"size:{request.resolution}")
        logger.info(f"✅ Command sent to {camera_id}")
        
        return {"status": "command_sent", "camera": camera_id, "resolution": request.resolution}
        
    except Exception as e:
        logger.error(f"❌ Failed to send: {e}")
        return {"error": str(e)}, 500

@router.get("/camera/{camera_id}/status")
async def get_camera_status(
    camera_id: str,
    access_key: str = Header(None, alias="X-Access-Key")  # Читаем из headers
):
    """Получить статус камеры"""
    logger.info(f"📊 STATUS REQUEST: camera={camera_id}")
    
    # if VALID_ACCESS_KEYS.get(camera_id) != access_key:
    #     logger.warning(f"❌ Invalid key for {camera_id}")
    #     return {"error": "Invalid key"}, 403
    
    if camera_id not in cameras:
        return {"error": "Camera not found"}, 404
    
    cam = cameras[camera_id]
    return {
        "fps": cam.get("fps", 0),
        "reported_fps": cam.get("reported_fps", 0),
        "viewers": len(viewer_connections.get(camera_id, set())),
        "last_frame_size": len(cam["last_frame"]) if cam["last_frame"] else 0,
        "connected": camera_id in esp_connections
    }