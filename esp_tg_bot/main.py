import asyncio
from aiogram import Bot, Dispatcher, types
from config import BOT_TOKEN
from app.dispatcher_module import setup_routers
from aiogram.fsm.storage.memory import MemoryStorage
from logger import logger
from app.keyboards.inline import commands


dp = Dispatcher(storage=MemoryStorage())
bot = Bot(token=BOT_TOKEN)

async def main():
    logger.info("Бот запущен.")
    await bot.set_my_commands(commands)
    setup_routers(dp)
    await dp.start_polling(bot)

if __name__ == "__main__":
    asyncio.run(main())
