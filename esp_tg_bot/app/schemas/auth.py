from pydantic import BaseModel

class KeyResponse(BaseModel):
    key: str
    expires_in_days: int