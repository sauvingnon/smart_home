from fastapi import APIRouter, Request, Depends
from fastapi.responses import JSONResponse
from logger import logger
from app.core.worker import WeatherBackgroundWorker
import os
import time
from app.api.endpoints.auth import get_current_user_id
from fastapi.responses import StreamingResponse, Response
from typing import Dict
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

# Папка для записей
os.makedirs("recordings", exist_ok=True)

@router.post("/upload/{camera_id}")
async def upload_frame(camera_id: str, request: Request):
    """
    ESP32 шлет сюда JPEG кадры
    camera_id = "cam1", "cam2" или что-то свое
    """
    frame_data = await request.body()
    
    # Инициализируем камеру если новая
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
    
    cam = cameras[camera_id]
    
    # Считаем FPS
    cam["frame_count"] += 1
    now = time.time()
    if now - cam["last_time"] >= 1.0:
        cam["fps"] = cam["frame_count"]
        cam["frame_count"] = 0
        cam["last_time"] = now
    
    # Обновляем последний кадр
    cam["last_frame"] = frame_data
    
    # Асинхронно обрабатываем (детекция движения, запись)
    asyncio.create_task(process_frame(camera_id, frame_data))
    
    return {"status": "ok", "camera": camera_id, "fps": cam["fps"]}

async def process_frame(camera_id: str, frame_data: bytes):
    """Обработка кадра (детекция движения, запись)"""
    cam = cameras.get(camera_id)
    if not cam:
        return
    
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
                if cv2.contourArea(contour) > 500:  # Чувствительность
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
    print(f"Started recording: {filename}")

def stop_recording(camera_id: str):
    """Остановить запись"""
    cam = cameras[camera_id]
    if cam["video_writer"]:
        cam["video_writer"].release()
        cam["video_writer"] = None
        print(f"Stopped recording: {camera_id}")

@router.get("/stream/{camera_id}")
async def stream_video(
    camera_id: str,
    user_id: int = Depends(get_current_user_id)
    ):
    """
    MJPEG стрим для браузера
    http://localhost:8000/stream/cam1
    """
    async def generate():
        while True:
            if camera_id in cameras and cameras[camera_id]["last_frame"]:
                yield (
                    b'--frame\r\n'
                    b'Content-Type: image/jpeg\r\n\r\n' +
                    cameras[camera_id]["last_frame"] +
                    b'\r\n'
                )
            await asyncio.sleep(0.05)  # 20 fps
    
    return StreamingResponse(
        generate(),
        media_type="multipart/x-mixed-replace; boundary=frame"
    )

@router.get("/last_frame/{camera_id}")
async def get_last_frame(
    camera_id: str,
    user_id: int = Depends(get_current_user_id)
    ):
    """Последний кадр как JPEG"""
    if camera_id in cameras and cameras[camera_id]["last_frame"]:
        return Response(
            content=cameras[camera_id]["last_frame"],
            media_type="image/jpeg"
        )
    return Response(status_code=404)

@router.post("/record/{camera_id}")
async def toggle_recording(
    camera_id: str, 
    enable: bool = True,
    user_id: int = Depends(get_current_user_id)
    ):
    """Включить/выключить запись"""
    if camera_id in cameras:
        cameras[camera_id]["recording"] = enable
        if not enable and cameras[camera_id]["video_writer"]:
            stop_recording(camera_id)
        return {"camera": camera_id, "recording": enable}
    return {"error": "Camera not found"}, 404

@router.post("/motion_detection/{camera_id}")
async def toggle_motion_detection(
    camera_id: str, 
    enable: bool = True,
    user_id: int = Depends(get_current_user_id)
    ):
    """Включить/выключить детекцию движения"""
    if camera_id in cameras:
        cameras[camera_id]["motion_detection"] = enable
        return {"camera": camera_id, "motion_detection": enable}
    return {"error": "Camera not found"}, 404

@router.get("/cameras")
async def list_cameras(
    user_id: int = Depends(get_current_user_id)
):
    """Список всех камер и их статус"""
    return {
        cam_id: {
            "fps": cam["fps"],
            "recording": cam["recording"],
            "motion_detected": cam.get("motion_detected", False),
            "motion_detection_enabled": cam.get("motion_detection", False),
            "last_frame_size": len(cam["last_frame"]) if cam["last_frame"] else 0
        }
        for cam_id, cam in cameras.items()
    }