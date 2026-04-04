# app/api/esp_service.py
import io
import os
import tempfile
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request, Response, WebSocket, Depends
from fastapi.responses import FileResponse, StreamingResponse
from starlette.background import BackgroundTask
from app.core.worker import WeatherBackgroundWorker
from app.api.endpoints.auth import get_current_user_id
from pydantic import BaseModel
from datetime import datetime
from logger import logger

router = APIRouter(prefix="/esp_service", tags=["esp_service"])

class ResolutionRequest(BaseModel):
    resolution: str

@router.post("/camera/{camera_id}/control")
async def control_camera(camera_id: str, action: str):
    worker = WeatherBackgroundWorker.get_instance()
    return await worker.video_service.control_camera(camera_id, action)

@router.post("/camera/{camera_id}/recording/stop")
async def stop_recording(camera_id: str):
    """Принудительно остановить запись видео"""
    worker = WeatherBackgroundWorker.get_instance()
    result = await worker.video_service.force_stop_recording(camera_id)
    if result is None:
        raise HTTPException(status_code=404, detail="No active recording")
    return {"status": "stopped", "camera_id": camera_id}

@router.websocket("/ws/camera")
async def websocket_camera(websocket: WebSocket):
    worker = WeatherBackgroundWorker.get_instance()
    await worker.video_service.handle_camera_websocket(websocket)

@router.websocket("/ws/view/{camera_id}")
async def websocket_viewer(websocket: WebSocket, camera_id: str):
    worker = WeatherBackgroundWorker.get_instance()
    await worker.video_service.handle_viewer_websocket(websocket, camera_id)

@router.post("/camera/{camera_id}/resolution")
async def set_camera_resolution(camera_id: str, request: ResolutionRequest):
    worker = WeatherBackgroundWorker.get_instance()
    return await worker.video_service.set_resolution(camera_id, request.resolution)

@router.get("/camera/{camera_id}/status")
async def get_camera_status(camera_id: str):
    worker = WeatherBackgroundWorker.get_instance()
    return await worker.video_service.get_status(camera_id)

@router.get("/videos")
async def list_videos(
    camera_id: Optional[str] = Query(None, description="ID камеры"),
    user_id: int = Depends(get_current_user_id)
) -> list[dict]:
    """Получить список видео."""
    try:

        worker = WeatherBackgroundWorker.get_instance()

        videos = await worker.video_service.list_videos(
            camera_id=camera_id
        )
        return videos
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/videos/stream")
async def stream_video(key: str = Query(...)):
    worker = WeatherBackgroundWorker.get_instance()
    video_data = await worker.video_service.get_video(key)
    
    if not video_data:
        raise HTTPException(status_code=404)
    
    return StreamingResponse(
        io.BytesIO(video_data),
        media_type="video/mp4",
        headers={"Content-Disposition": "inline"},
    )

@router.get("/videos/download")
async def download_video(
    key: str = Query(..., description="Key видео."),
):
    """Скачать видео"""
    worker = WeatherBackgroundWorker.get_instance()
    
    video_data = await worker.video_service.get_video(key)
    if not video_data:
        raise HTTPException(status_code=404, detail="Video not found")
    
    return StreamingResponse(
        io.BytesIO(video_data),
        media_type="video/mp4",
        headers={
            "Content-Disposition": f"attachment; filename={key.split('/')[-1]}",  # attachment для скачивания
            "Content-Length": str(len(video_data))
        }
    )

@router.get("/videos/thumbnail")
async def get_video_thumbnail(
    camera_id: str = Query(..., description="ID камеры"),
    timestamp: int = Query(..., description="Unix timestamp начала записи"),
):
    """Получить thumbnail (превью) видео"""
    worker = WeatherBackgroundWorker.get_instance()
    
    thumbnail_data = await worker.video_service.get_thumbnail(camera_id, timestamp)
    if not thumbnail_data:
        raise HTTPException(status_code=404, detail="Thumbnail not found")
    
    return Response(
        content=thumbnail_data,
        media_type="image/jpeg",
        headers={
            "Cache-Control": "public, max-age=86400",  # Кэшируем на 24 часа
            "Content-Length": str(len(thumbnail_data))
        }
    )