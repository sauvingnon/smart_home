from aiogram import Router, types
from aiogram.filters import Command
from aiogram.types import InlineKeyboardMarkup, InlineKeyboardButton, WebAppInfo
from config import ESP_WEB_URL

router = Router()

@router.message(Command("panel"))
async def cmd_panel(message: types.Message):
    keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(
            text="🚀 Открыть управление ESP",
            web_app=WebAppInfo(url=ESP_WEB_URL)
        )]
    ])
    
    await message.answer(
        "Нажми кнопку, чтобы открыть панель управления:",
        reply_markup=keyboard
    )