from zoneinfo import ZoneInfo
from datetime import datetime

IZHEVSK_TZ = ZoneInfo('Europe/Samara')

def _get_izhevsk_time() -> datetime:
        """Текущее время в Ижевске"""
        return datetime.now(IZHEVSK_TZ)