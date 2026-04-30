# app/api/esp_service.py
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request, Response, WebSocket, Depends, Header, UploadFile, File
from fastapi.responses import StreamingResponse
from app.core.worker import BackgroundWorker
from app.core.auth import get_current_user_id_dep
from pydantic import BaseModel
from logger import logger

router = APIRouter(prefix="/esp_service", tags=["esp_service"])

class ResolutionRequest(BaseModel):
    resolution: str

class FanControlRequest(BaseModel):
    enable: bool

@router.websocket("/ws/camera")
async def websocket_camera(websocket: WebSocket):
    """Сокет соединение с камерой. Авторизация внутри подключения."""
    worker = BackgroundWorker.get_instance()
    await worker.video_service.handle_camera(websocket)

@router.websocket("/ws/view/{camera_id}")
async def websocket_viewer(websocket: WebSocket, camera_id: str):
    """Сокет соединение со зрителем. Авторизация внутри подключения."""
    worker = BackgroundWorker.get_instance()
    await worker.video_service.handle_viewer_websocket(websocket, camera_id)

@router.post("/camera/{camera_id}/resolution")
async def set_camera_resolution(
    camera_id: str, 
    request: ResolutionRequest,
    user_id: int = Depends(get_current_user_id_dep)
):
    """Запрос на смену разрешения камеры."""
    worker = BackgroundWorker.get_instance()
    success = await worker.video_service.set_resolution(camera_id, request.resolution)
    
    if not success:
        raise HTTPException(status_code=400, detail="Failed to set resolution")
    
    return {"status": "ok", "camera_id": camera_id, "resolution": request.resolution}

@router.post("/camera/{camera_id}/fan")
async def set_camera_fan(
    camera_id: str,
    request: FanControlRequest,
    user_id: int = Depends(get_current_user_id_dep)
):
    """Включить/выключить вентилятор на камере."""
    worker = BackgroundWorker.get_instance()
    success = await worker.video_service.set_fan(camera_id, request.enable)
    
    if not success:
        raise HTTPException(status_code=400, detail="Failed to control fan")
    
    return {"status": "ok", "camera_id": camera_id, "fan": "on" if request.enable else "off"}

@router.get("/camera/{camera_id}/status")
async def get_camera_status(
    camera_id: str,
    user_id: int = Depends(get_current_user_id_dep)
):
    """Получить статус камеры."""
    worker = BackgroundWorker.get_instance()
    state = await worker.video_service.get_camera_state(camera_id)
    
    if not state:
        raise HTTPException(status_code=503, detail="Camera not found")
    
    return state

@router.get("/videos")
async def list_videos(
    request: Request,
    camera_id: Optional[str] = Query(None, description="ID камеры"),
    user_id: int = Depends(get_current_user_id_dep)
):
    """Получить список видео с presigned URLs и токеном доступа"""
    worker = BackgroundWorker.get_instance()
    
    # Получаем список видео
    return await worker.video_service.get_video_list(camera_id=camera_id)

@router.get("/videos/stream")
async def stream_video(
    request: Request,
    video_id: str = Query(..., description="UUID видео"),
    camera_id: str = Query(..., description="ID камеры"),
    token: str = Query(..., description="Session token для доступа")
):
    """Потоковая передача видео с поддержкой Range"""
    worker = BackgroundWorker.get_instance()
    
    # Проверяем токен
    user_id = await worker.cache.validate_session_token(token)
    if not user_id:
        raise HTTPException(status_code=403, detail="Недействительный токен")
    
    # Получаем видео через VideoService
    range_header = request.headers.get('range')
    data, file_size, content_range, error = await worker.video_service.stream_video(
        camera_id=camera_id,
        video_id=video_id,
        range_header=range_header
    )
    
    if error:
        if error == "Видео не найдено":
            raise HTTPException(status_code=503, detail=error)
        else:
            raise HTTPException(status_code=500, detail=error)
    
    # Формируем ответ
    headers = {
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length',
    }
    
    status_code = 200
    if content_range:
        status_code = 206
        headers['Content-Range'] = content_range
        headers['Content-Length'] = str(len(data))
    else:
        headers['Content-Length'] = str(file_size)
    
    return Response(
        content=data,
        status_code=status_code,
        media_type='video/mp4',
        headers=headers
    )

@router.options("/videos/stream")
async def options_stream_video():
    """Preflight CORS запрос"""
    return Response(
        status_code=200,
        headers={
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'range',
            'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length',
        }
    )

@router.get("/videos/presigned-url") 
async def get_video_presigned_url(
    camera_id: str = Query(..., description="ID камеры"),
    video_id: str = Query(..., description="UUID видео"),
    expires_in: int = Query(3600, description="Время жизни URL в секундах"),
    token: str = Query(..., description="Токен доступа")
):
    """
    Получить presigned URL для прямого доступа к видео.
    
    Полезно для плееров, которые не поддерживают стриминг через прокси.
    """
    worker = BackgroundWorker.get_instance()
    
    # Проверяем токен
    user_id = await worker.cache.validate_session_token(token)
    if not user_id:
        raise HTTPException(status_code=403, detail="Доступ запрещен.")
    
    url = await worker.video_service.get_video_presigned_url(
        camera_id=camera_id,
        video_id=video_id,
        user_id=user_id,
        expires_in=expires_in
    )
    
    if not url:
        raise HTTPException(status_code=503, detail="Video not found")
    
    return {"url": url, "expires_in": expires_in}

@router.get("/videos/download")
async def download_video(
    video_id: str = Query(..., description="UUID видео"),
    camera_id: str = Query(..., description="ID камеры"),
    user_id: int = Depends(get_current_user_id_dep)
):
    """
    Скачать видео — стриминг напрямую из S3 без буферизации на сервере.
    Content-Length известен заранее, поэтому клиент может отображать прогресс.
    """
    worker = BackgroundWorker.get_instance()

    stream, file_size = await worker.video_service.stream_video_download(camera_id, video_id)
    if not stream:
        raise HTTPException(status_code=404, detail="Video not found")

    return StreamingResponse(
        stream,
        media_type="video/mp4",
        headers={
            "Content-Disposition": f"attachment; filename={camera_id}_{video_id}.mp4",
            "Content-Length": str(file_size),
        }
    )

@router.get("/videos/thumbnail")
async def get_video_thumbnail(
    camera_id: str = Query(..., description="ID камеры"),
    video_id: str = Query(..., description="UUID видео"),
    token: str = Query(..., description="Session token")
):
    """Получить thumbnail с проверкой токена"""
    worker = BackgroundWorker.get_instance()
    
    # Проверяем токен
    user_id = await worker.cache.validate_session_token(token)
    if not user_id:
        raise HTTPException(status_code=403, detail="Недействительный токен")
    
    thumbnail_data = await worker.video_service.get_thumbnail(camera_id, video_id)
    if not thumbnail_data:
        raise HTTPException(status_code=503, detail="Thumbnail не найден")
    
    return Response(
        content=thumbnail_data,
        media_type="image/jpeg",
        headers={
            "Cache-Control": "public, max-age=86400",
            "Content-Length": str(len(thumbnail_data))
        }
    )

# ========== ЗАГРУЗКА ВИДЕО ОТ КАМЕРЫ ==========

@router.post("/video/upload_chunk")
async def upload_chunk(
    request: Request,
    camera_id: str = Query(..., description="ID камеры"),
    start_time: int = Query(..., description="Unix timestamp начала записи"),
    duration: int = Query(..., description="Длительность в секундах"),
    chunk: int = Query(..., description="Номер чанка (начиная с 1)"),
    total_chunks: int = Query(..., description="Общее количество чанков"),
    filename: str = Query(..., description="Имя файла"),
    x_access_key: str = Header(..., description="Ключ доступа камеры")
):
    """
    Принимает чанк видео от ESP32 камеры.
    Когда все чанки собраны — передаёт собранный файл в VideoService.
    """
    
    worker = BackgroundWorker.get_instance()
    
    # 1. Проверка авторизации
    if not worker.video_service.verify_camera(camera_id, x_access_key):
        logger.warning(f"🔒 [{camera_id}] Неавторизованная попытка загрузки чанка")
        raise HTTPException(status_code=403, detail="Unauthorized camera")
    
    # 2. Читаем данные чанка
    chunk_data = await request.body()
    
    if not chunk_data:
        raise HTTPException(status_code=400, detail="Empty chunk data")
    
    # 3. Ключ сессии
    session_key = worker.video_service.chunk_service._make_session_key(camera_id, start_time, filename)
    
    try:
        # 4. Добавляем чанк через сервис
        session, is_complete = worker.video_service.chunk_service.add_chunk(
            session_key=session_key,
            camera_id=camera_id,
            filename=filename,
            chunk_number=chunk,
            total_chunks=total_chunks,
            data=chunk_data
        )
        
        # 5. Если сессия завершена — собираем и сохраняем видео
        if is_complete:
            video_stream = session.assemble()
            
            video_id = await worker.video_service.save_video_from_camera(
                camera_id=camera_id,
                file_stream=video_stream,
                start_timestamp=start_time,
                duration_seconds=duration,
            )
            
            if not video_id:
                raise HTTPException(status_code=500, detail="Failed to save video")
            
            file_size = video_stream.getbuffer().nbytes
            
            logger.info(f"🎉 [{camera_id}] Видео {video_id} сохранено ({file_size} байт)")
            
            return {
                "status": "complete",
                "video_id": video_id,
                "size_bytes": file_size,
                "chunks_received": total_chunks
            }
        
        # 6. Ещё не все чанки
        return {
            "status": "chunk_received",
            "chunk": chunk,
            "received": len(session.chunks),
            "total": total_chunks
        }
        
    except ValueError as e:
        # Чанк не по порядку или сессия истекла
        logger.warning(f"📦 [{camera_id}] Ошибка чанка: {e}")
        raise HTTPException(status_code=400, detail=str(e))

@router.post("/camera/{camera_id}/record/start")  # 🔧 ДОБАВЛЕНО: эндпоинт запуска записи
async def start_camera_recording(
    camera_id: str,
    user_id: int = Depends(get_current_user_id_dep)
):
    """
    Запустить запись на камере.
    Камера начнёт запись видео в локальный буфер.
    """
    worker = BackgroundWorker.get_instance()
    
    result = await worker.video_service.start_recording(camera_id=camera_id)
    
    if not result:
        raise HTTPException(status_code=400, detail="Failed to start recording")
    
    return {
        "status": "started",
        "camera_id": camera_id,
        "message": "Recording started"
    }

@router.post("/camera/{camera_id}/record/stop")
async def stop_camera_recording(
    camera_id: str,
    user_id: int = Depends(get_current_user_id_dep)
):
    """
    Остановить запись на камере.
    Камера завершит текущий файл и загрузит его на сервер.
    """
    worker = BackgroundWorker.get_instance()
    
    result = await worker.video_service.stop_recording(camera_id=camera_id)
    
    if not result:
        raise HTTPException(status_code=400, detail="Failed to stop recording or no active recording")
    
    return {
        "status": "stopped",
        "camera_id": camera_id,
        "message": "Recording stopped"
    }