from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from fastapi.responses import Response
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
    """WebSocket для ESP32 камеры - только стрим, без обработки"""
    await websocket.accept()
    
    camera_id = None
    try:
        # Авторизация
        auth_msg = await websocket.receive_text()
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
        
        # Отключаем старую камеру если есть
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
        
        # Основной цикл - ТОЛЬКО прием и рассылка
        while True:
            frame_data = await websocket.receive_bytes()
            
            # Быстро обновляем статистику
            cam = cameras[camera_id]
            cam["last_frame"] = frame_data
            cam["frame_count"] += 1
            
            now = time.time()
            if now - cam["last_time"] >= 1.0:
                cam["fps"] = cam["frame_count"]
                cam["frame_count"] = 0
                cam["last_time"] = now
            
            # Мгновенная рассылка зрителям
            if camera_id in viewer_connections:
                dead = set()
                for viewer in viewer_connections[camera_id]:
                    try:
                        await viewer.send_bytes(frame_data)
                    except:
                        dead.add(viewer)
                
                if dead:
                    viewer_connections[camera_id] -= dead
    
    except WebSocketDisconnect:
        logger.info(f"🔴 Camera {camera_id} disconnected")
    except Exception as e:
        logger.error(f"Error: {e}")
    finally:
        if camera_id and camera_id in esp_connections:
            del esp_connections[camera_id]

@router.websocket("/ws/view/{camera_id}")
async def websocket_viewer(websocket: WebSocket, camera_id: str):
    """WebSocket для зрителей"""
    try:
        await websocket.accept(subprotocol="access_key")
        
        # Проверка ключа
        worker = WeatherBackgroundWorker.get_instance()
        user_id = await worker.verify_websocket_key(websocket)
        
        if not user_id:
            await websocket.close(code=1008, reason="Invalid key")
            return
        
        # Добавляем зрителя
        if camera_id not in viewer_connections:
            viewer_connections[camera_id] = set()
        
        viewer_connections[camera_id].add(websocket)
        logger.info(f"👁 Viewer for {camera_id}, total: {len(viewer_connections[camera_id])}")
        
        # Отправляем последний кадр
        if camera_id in cameras and cameras[camera_id]["last_frame"]:
            try:
                await websocket.send_bytes(cameras[camera_id]["last_frame"])
            except:
                pass
        
        # Пинг-понг
        last_ping = time.time()
        while True:
            try:
                if time.time() - last_ping > 10:
                    await websocket.send_text("ping")
                    last_ping = time.time()
                
                message = await asyncio.wait_for(websocket.receive_text(), timeout=1.0)
                
                if message == "ping":
                    await websocket.send_text("pong")
                elif message.startswith("fps:") and camera_id in esp_connections:
                    await esp_connections[camera_id].send_text(message)
                        
            except asyncio.TimeoutError:
                continue
            except WebSocketDisconnect:
                break
    
    finally:
        if camera_id in viewer_connections:
            viewer_connections[camera_id].discard(websocket)
            logger.info(f"Remaining viewers for {camera_id}: {len(viewer_connections.get(camera_id, set()))}")

# ===================== HTTP эндпоинты =====================

@router.get("/last_frame/{camera_id}")
async def get_last_frame(camera_id: str, access_key: str):
    """Последний кадр как JPEG"""
    if VALID_ACCESS_KEYS.get(camera_id) != access_key:
        return Response(status_code=403)
    
    if camera_id in cameras and cameras[camera_id]["last_frame"]:
        return Response(content=cameras[camera_id]["last_frame"], media_type="image/jpeg")
    return Response(status_code=404)

@router.get("/cameras")
async def list_cameras():
    """Список камер"""
    return {
        cam_id: {
            "fps": cam["fps"],
            "last_frame_size": len(cam["last_frame"]) if cam["last_frame"] else 0,
            "connected": cam_id in esp_connections,
            "viewers": len(viewer_connections.get(cam_id, set()))
        }
        for cam_id, cam in cameras.items()
    }