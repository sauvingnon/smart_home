# api/routes/esp_service.py
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends, Query
from app.core.worker import WeatherBackgroundWorker
from app.api.endpoints.auth import get_current_user_id
from app.schemas.ai_command import AICommandResponse, AICommandRequest
from app.core.orchestrator import handle_text_command

router = APIRouter(
    prefix="/esp_service",
    tags=["esp_service"],
)

@router.post("/ai_command", response_model=str)
async def ai_command_endpoint(
    request: AICommandRequest,
    user_id: int = Depends(get_current_user_id)
):
    """
    Принимает текстовую команду от AI-ассистента
    """
    result = await handle_text_command(request.text)

    return result