from aiogram import Router, F
from aiogram.fsm.context import FSMContext
from aiogram.types import Message
from app.utils.resources import get_welcome_message
from logger import logger
from app.keyboards.inline import start_keyboard

router = Router()

def extract_username(user):
    if user.username:
        return user.username
    elif user.first_name:
        return user.first_name
    else:
        return f"Unknown {user.id}"

# Стартовое сообщение
@router.message(F.text == "/start")
async def cmd_start(message: Message, state: FSMContext):
    try:
        user_name = extract_username(message.from_user)

        logger.info(f"Пользователь {user_name} запустил бота.")

        await message.answer(get_welcome_message(user_name), reply_markup=start_keyboard)

    except Exception as e:
        logger.exception(f"Ошибка в /start: {e}")