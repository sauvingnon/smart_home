# services/remnawave/client.py

import httpx
from config import ESP_SERVICE_URL

client = httpx.AsyncClient(base_url=ESP_SERVICE_URL, timeout=20.0)