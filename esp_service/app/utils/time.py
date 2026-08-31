import re
from zoneinfo import ZoneInfo
from datetime import datetime
from typing import Optional

IZHEVSK_TZ = ZoneInfo('Europe/Samara')

def _get_izhevsk_time() -> datetime:
        """Текущее время в Ижевске"""
        return datetime.now(IZHEVSK_TZ)


_RU_MONTHS_GENITIVE = (
    "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря",
)


def format_ru_datetime(dt: datetime) -> str:
    """Дата/время в формате '2 декабря 21:48'."""
    return f"{dt.day} {_RU_MONTHS_GENITIVE[dt.month - 1]} {dt.strftime('%H:%M')}"


_VIDEO_KEY_DATE_RE = re.compile(r"/(\d{4})/(\d{2})/(\d{2})/(\d{2})-(\d{2})-(\d{2})_")


def parse_video_key_datetime(video_key: str) -> Optional[datetime]:
    """Достаёт дату/время записи из ключа вида videos/{camera}/{Y}/{m}/{d}/{H}-{M}-{S}_{uuid}.mp4
    (см. S3Manager._generate_key). Время уже ижевское — генерировалось из start_time."""
    match = _VIDEO_KEY_DATE_RE.search(video_key)
    if not match:
        return None
    year, month, day, hour, minute, second = (int(g) for g in match.groups())
    try:
        return datetime(year, month, day, hour, minute, second, tzinfo=IZHEVSK_TZ)
    except ValueError:
        return None