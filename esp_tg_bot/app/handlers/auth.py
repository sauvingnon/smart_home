from aiogram import Router, types, F
from aiogram.types import CallbackQuery, Message, InlineKeyboardMarkup, InlineKeyboardButton, WebAppInfo
from aiogram.fsm.context import FSMContext
from app.state.model_fsm import ModelFSM
from app.services.esp_service import get_key as fetch_key
from config import TGAPP_URL
from logger import logger
from datetime import datetime, timedelta

router = Router()

# Команда /getkey в статичной клавиатуре
@router.message(F.text == "/getkey")
async def cmd_getkey(message: Message, state: FSMContext):
    await get_key_handler(message)

# Кнопка "Авторизация" (callback_data="getkey")
@router.callback_query(F.data == "getkey")
async def cmd_getkey_callback(callback: CallbackQuery, state: FSMContext):
    await get_key_handler(callback.message)

async def get_key_handler(message: Message):
    """Обработчик получения ключа"""
    
    status_msg = await message.answer("🔄 Генерирую ключ доступа...")

    try:
        # Получаем ключ через сервис
        key_response = await fetch_key(message.from_user.id)
        
        if not key_response:
            await status_msg.edit_text(
                "❌ Не удалось получить ключ. Попробуйте позже."
            )
            return
        
        # Рассчитываем дату истечения
        expires_date = (datetime.now() + timedelta(days=key_response.expires_in_days)).strftime("%d.%m.%Y")
        
        # Формируем URL для WebApp
        webapp_url = f"{TGAPP_URL}?key={key_response.key}"
        
        # Создаем клавиатуру
        keyboard = InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(
                text="🚀 Открыть панель управления",
                web_app=WebAppInfo(url=webapp_url)
            )],
            [InlineKeyboardButton(
                text="📋 Копировать ключ",
                callback_data=f"copy_key_{key_response.key}"
            )]
        ])
        
        # Отправляем результат
        await status_msg.edit_text(
            f"✅ Ключ доступа сгенерирован!\n\n"
            f"🔑 <code>{key_response.key}</code>\n"
            f"⏳ Действует до: {expires_date}\n\n"
            f"Нажми кнопку, чтобы открыть панель управления:",
            reply_markup=keyboard,
            parse_mode="HTML"
        )
        
        logger.info(f"✅ Ключ получен для user_id {message.from_user.id}")
        
    except Exception as e:
        logger.exception(f"❌ Ошибка при получении ключа: {e}")
        await status_msg.edit_text(
            "❌ Произошла ошибка. Попробуйте позже."
        )


@router.callback_query(F.data.startswith("copy_key_"))
async def callback_copy_key(callback: CallbackQuery):
    """Обработчик копирования ключа"""
    try:
        key = callback.data.replace("copy_key_", "")
        
        # Отвечаем на callback
        await callback.answer(
            f"🔑 Ключ скопирован в буфер",
            show_alert=False
        )
        
        # Отправляем отдельное сообщение с ключом для копирования
        await callback.message.answer(
            f"<b>🔑 Ваш ключ доступа:</b>\n\n"
            f"<code>{key}</code>\n\n"
            f"Введите его в поле ввода на сайте или используйте кнопку выше.",
            parse_mode="HTML"
        )
        
    except Exception as e:
        logger.exception(f"❌ Ошибка при копировании ключа: {e}")
        await callback.answer(
            "❌ Ошибка",
            show_alert=True
        )