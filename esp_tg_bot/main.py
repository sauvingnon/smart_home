import asyncio
from aiogram import Bot, Dispatcher, types
from aiogram.fsm.storage.memory import MemoryStorage
from config import BOT_TOKEN, ALLOWED_USER_IDS
from app.dispatcher_module import setup_routers
from logger import logger
from app.keyboards.inline import commands
from functools import lru_cache

@lru_cache(maxsize=100)
def is_user_allowed(user_id: int) -> bool:
    """Проверка доступа с кэшированием"""
    allowed = user_id in ALLOWED_USER_IDS
    if not allowed:
        logger.warning(f"Отказ в доступе для user_id: {user_id}")
    return allowed

# Middleware для проверки доступа
async def access_middleware(handler, event: types.Message, data: dict):
    """Middleware проверяет доступ перед любым хендлером"""
    if not is_user_allowed(event.from_user.id):
        await event.answer("⛔ Доступ запрещен")
        return  # останавливаем обработку
    return await handler(event, data)

# Создаем бота и диспетчер
bot = Bot(token=BOT_TOKEN)
dp = Dispatcher(storage=MemoryStorage())

# Регистрируем middleware
dp.message.middleware(access_middleware)

# Настраиваем роутеры
setup_routers(dp)

async def main():
    logger.info("Бот запущен.")
    await bot.set_my_commands(commands)
    await dp.start_polling(bot)

if __name__ == "__main__":
    asyncio.run(main())