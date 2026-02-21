from openai import OpenAI
from config import API_TOKEN_DEEPSEEK, BASE_URL_DEEPSEEK
from logger import logger

# Инициализация клиента
client = OpenAI(api_key=API_TOKEN_DEEPSEEK, base_url=BASE_URL_DEEPSEEK)

# --- 💬 Chat LLM ---
async def ai_message_request(message: str) -> str | None:
    """Обработка текстового запроса пользователем."""
    try:
        response = client.chat.completions.create(
            model="deepseek-chat",
            messages=[
                {"role": "user", "content": message} 
            ],
            stream=False
        )

        result = response.choices[0].message.content.strip()
        return result

    except Exception as e:
        logger.exception(f"Ошибка при выполнении запроса к DeepSeek API: {e}")
        return None