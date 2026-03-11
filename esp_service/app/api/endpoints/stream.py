from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response
from logger import logger
from app.core.worker import WeatherBackgroundWorker
import os
import time
from typing import Dict, Set
import asyncio
import cv2
from datetime import datetime
import numpy as np

router = APIRouter(
    prefix="/esp_service",
    tags=["esp_service"],
)

# Хранилище последних кадров (для нескольких камер)
cameras: Dict[str, dict] = {}

# Вебсокет соединения
esp_connections: Dict[str, WebSocket] = {}  # camera_id -> ESP32 WebSocket
viewer_connections: Dict[str, Set[WebSocket]] = {}  # camera_id -> set of viewers

# Access keys (в реальности должно быть в БД)
VALID_ACCESS_KEYS = {"cam1": "12345678"}  # ключи для камер

# Папка для записей
os.makedirs("recordings", exist_ok=True)

@router.websocket("/ws/camera")
async def websocket_camera(websocket: WebSocket):
    """
    WebSocket для ESP32 камеры
    ESP32 подключается сюда и шлет кадры
    """
    await websocket.accept()
    
    camera_id = None
    try:
        # Ждем авторизацию (первое сообщение должно быть AUTH:key:cam_id)
        auth_msg = await websocket.receive_text()
        logger.info(f"Auth message: {auth_msg}")
        
        if not auth_msg.startswith("AUTH:"):
            await websocket.close(code=1008, reason="Invalid auth format")
            return
        
        parts = auth_msg.split(":")
        if len(parts) < 3:
            await websocket.close(code=1008, reason="Invalid auth data")
            return
        
        access_key = parts[1]
        camera_id = parts[2]
        
        # Проверяем ключ
        if VALID_ACCESS_KEYS.get(camera_id) != access_key:
            logger.warning(f"Invalid access key for camera {camera_id}")
            await websocket.close(code=1008, reason="Invalid key")
            return
        
        # Если камера уже была подключена - отключаем старую
        if camera_id in esp_connections:
            try:
                await esp_connections[camera_id].close()
            except:
                pass
        
        esp_connections[camera_id] = websocket
        logger.info(f"✅ Camera {camera_id} connected")
        
        # Инициализируем запись в словаре cameras если новая
        if camera_id not in cameras:
            cameras[camera_id] = {
                "last_frame": None,
                "fps": 0,
                "last_time": time.time(),
                "frame_count": 0,
                "recording": False,
                "video_writer": None,
                "motion_detected": False,
                "last_frame_gray": None
            }
        
        # Отправляем подтверждение
        await websocket.send_text("AUTH_OK")
        
        # Основной цикл приема кадров
        while True:
            # Получаем бинарные данные (JPEG кадр)
            frame_data = await websocket.receive_bytes()
            
            # Обрабатываем кадр
            await process_frame(camera_id, frame_data)
            
            # Рассылаем всем зрителям этой камеры
            if camera_id in viewer_connections:
                dead_viewers = set()
                for viewer in viewer_connections[camera_id]:
                    try:
                        await viewer.send_bytes(frame_data)
                    except:
                        dead_viewers.add(viewer)
                
                # Чистим отключившихся зрителей
                viewer_connections[camera_id] -= dead_viewers
    
    except WebSocketDisconnect:
        logger.info(f"🔴 Camera {camera_id} disconnected")
        if camera_id and camera_id in esp_connections:
            del esp_connections[camera_id]
    
    except Exception as e:
        logger.error(f"WebSocket error for camera {camera_id}: {e}")
        if camera_id and camera_id in esp_connections:
            del esp_connections[camera_id]

@router.websocket("/ws/view/{camera_id}")
async def websocket_viewer(websocket: WebSocket, camera_id: str):
    """
    WebSocket для фронтенда (зрители)
    """
    try:
        # 1. Принимаем соединение И подтверждаем выбранный субпротокол
        await websocket.accept(subprotocol="access_key")
        logger.info(f"✅ WebSocket accepted for {camera_id}")
        
        # 2. Проверяем ключ
        worker = WeatherBackgroundWorker.get_instance()
        user_id = await worker.verify_websocket_key(websocket)
        
        if not user_id:
            logger.warning(f"❌ Invalid viewer access for camera {camera_id}")
            await websocket.close(code=1008, reason="Invalid key")
            return
        
        logger.info(f"✅ Authentication successful for {camera_id}, user_id: {user_id}")
        
        # 3. Добавляем зрителя
        if camera_id not in viewer_connections:
            viewer_connections[camera_id] = set()
        
        viewer_connections[camera_id].add(websocket)
        logger.info(f"👁 Viewer connected to {camera_id}, total: {len(viewer_connections[camera_id])}")
        
        # 4. Отправляем последний кадр
        if camera_id in cameras and cameras[camera_id]["last_frame"]:
            try:
                await websocket.send_bytes(cameras[camera_id]["last_frame"])
                logger.info(f"📸 Sent last frame to {camera_id}")
            except Exception as e:
                logger.error(f"Error sending last frame: {e}")
                return
        
        # 5. Основной цикл с пингом
        last_ping = time.time()
        while True:
            try:
                # Проверяем соединение каждые 10 секунд
                if time.time() - last_ping > 10:
                    await websocket.send_text("ping")
                    last_ping = time.time()
                
                # Ждем сообщение с таймаутом
                message = await asyncio.wait_for(
                    websocket.receive_text(),
                    timeout=1.0
                )
                
                if message == "ping":
                    await websocket.send_text("pong")
                elif message.startswith("fps:"):
                    if camera_id in esp_connections:
                        await esp_connections[camera_id].send_text(message)
                        logger.info(f"Forwarded FPS command to {camera_id}")
                        
            except asyncio.TimeoutError:
                # Это нормально, просто продолжаем
                continue
            except WebSocketDisconnect:
                logger.info(f"👁 Viewer disconnected from {camera_id}")
                break
            except Exception as e:
                logger.error(f"Error in message loop for {camera_id}: {type(e).__name__}: {e}", exc_info=True)
                break
                
    except Exception as e:
        logger.error(f"Viewer error for {camera_id}: {e}")
    finally:
        if camera_id in viewer_connections:
            viewer_connections[camera_id].discard(websocket)
            logger.info(f"Remaining viewers for {camera_id}: {len(viewer_connections[camera_id])}")

# ===================== ТВОИ СУЩЕСТВУЮЩИЕ ФУНКЦИИ =====================

async def process_frame(camera_id: str, frame_data: bytes):
    """Обработка кадра (детекция движения, запись) - ТВОЯ ФУНКЦИЯ"""
    cam = cameras.get(camera_id)
    if not cam:
        return
    
    # Считаем FPS
    cam["frame_count"] += 1
    now = time.time()
    if now - cam["last_time"] >= 1.0:
        cam["fps"] = cam["frame_count"]
        cam["frame_count"] = 0
        cam["last_time"] = now
    
    # Обновляем последний кадр
    cam["last_frame"] = frame_data
    
    # Конвертируем JPEG в OpenCV
    nparr = np.frombuffer(frame_data, np.uint8)
    frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    
    if frame is None:
        return
    
    # Детекция движения (если включена)
    if cam.get("motion_detection", False):
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        gray = cv2.GaussianBlur(gray, (21, 21), 0)
        
        if cam["last_frame_gray"] is not None:
            diff = cv2.absdiff(gray, cam["last_frame_gray"])
            _, thresh = cv2.threshold(diff, 25, 255, cv2.THRESH_BINARY)
            thresh = cv2.dilate(thresh, None, iterations=2)
            contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            
            motion = False
            for contour in contours:
                if cv2.contourArea(contour) > 500:
                    motion = True
                    break
            
            cam["motion_detected"] = motion
            
            # Если движение и запись включена - записываем
            if motion and cam.get("recording", False):
                if cam["video_writer"] is None:
                    start_recording(camera_id)
                
                if cam["video_writer"]:
                    cam["video_writer"].write(frame)
            elif not motion and cam["video_writer"] is not None:
                stop_recording(camera_id)
        
        cam["last_frame_gray"] = gray

def start_recording(camera_id: str):
    """Начать запись видео"""
    cam = cameras[camera_id]
    filename = f"recordings/{camera_id}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.avi"
    fourcc = cv2.VideoWriter_fourcc(*'XVID')
    cam["video_writer"] = cv2.VideoWriter(filename, fourcc, 10, (640, 480))
    logger.info(f"Started recording: {filename}")

def stop_recording(camera_id: str):
    """Остановить запись"""
    cam = cameras[camera_id]
    if cam["video_writer"]:
        cam["video_writer"].release()
        cam["video_writer"] = None
        logger.info(f"Stopped recording: {camera_id}")

# ===================== HTTP ЭНДПОИНТЫ (для совместимости) =====================

@router.get("/last_frame/{camera_id}")
async def get_last_frame(camera_id: str, access_key: str):
    """Последний кадр как JPEG (для обратной совместимости)"""
    if VALID_ACCESS_KEYS.get(camera_id) != access_key:
        return Response(status_code=403)
    
    if camera_id in cameras and cameras[camera_id]["last_frame"]:
        return Response(
            content=cameras[camera_id]["last_frame"],
            media_type="image/jpeg"
        )
    return Response(status_code=404)

@router.get("/cameras")
async def list_cameras():
    """Список всех камер и их статус"""
    return {
        cam_id: {
            "fps": cam["fps"],
            "recording": cam["recording"],
            "motion_detected": cam.get("motion_detected", False),
            "motion_detection_enabled": cam.get("motion_detection", False),
            "last_frame_size": len(cam["last_frame"]) if cam["last_frame"] else 0,
            "connected": cam_id in esp_connections,
            "viewers": len(viewer_connections.get(cam_id, set()))
        }
        for cam_id, cam in cameras.items()
    }

@router.post("/record/{camera_id}")
async def toggle_recording(camera_id: str, enable: bool = True, access_key: str = None):
    """Включить/выключить запись"""
    if VALID_ACCESS_KEYS.get(camera_id) != access_key:
        return {"error": "Invalid key"}, 403
    
    if camera_id in cameras:
        cameras[camera_id]["recording"] = enable
        if not enable and cameras[camera_id]["video_writer"]:
            stop_recording(camera_id)
        return {"camera": camera_id, "recording": enable}
    return {"error": "Camera not found"}, 404

@router.post("/motion_detection/{camera_id}")
async def toggle_motion_detection(camera_id: str, enable: bool = True, access_key: str = None):
    """Включить/выключить детекцию движения"""
    if VALID_ACCESS_KEYS.get(camera_id) != access_key:
        return {"error": "Invalid key"}, 403
    
    if camera_id in cameras:
        cameras[camera_id]["motion_detection"] = enable
        return {"camera": camera_id, "motion_detection": enable}
    return {"error": "Camera not found"}, 404