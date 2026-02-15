// Вот сюда вписываешь реальный URL бека
export const API_BASE = 'https://tgapp.dotnetdon.ru:4444/esp_service' // или 'https://api.example.com'

export const API_ENDPOINTS = {
  telemetry: `${API_BASE}/telemetry`,
  settings: `${API_BASE}/settings`,
  weather: `${API_BASE}/weather`
}
