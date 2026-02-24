from pydantic import BaseModel


class AICommandRequest(BaseModel):
    text: str

class AICommandResponse(BaseModel):
    reply: str
    action: str | None = None
    device: str | None = None