from openai import AsyncOpenAI
from config import API_TOKEN_DEEPSEEK, BASE_URL_DEEPSEEK
from logger import logger

# Инициализация клиента
client = AsyncOpenAI(api_key=API_TOKEN_DEEPSEEK, base_url=BASE_URL_DEEPSEEK)

# --- 💬 Chat LLM ---
async def ai_message_request(user_message: str, system_message: str) -> str | None:
    """Обработка текстового запроса пользователем."""
    try:
        response = await client.chat.completions.create(
            model="deepseek-chat",
            messages=[
                {"role": "system", "content": system_message},
                {"role": "user", "content": user_message} 
            ],
            stream=False
        )

        result = response.choices[0].message.content.strip()
        return result

    except Exception as e:
        logger.exception(f"Ошибка при выполнении запроса к DeepSeek API: {e}")
        return None