from aiogram import Router, types, F
from aiogram.types import CallbackQuery, Message
from aiogram.fsm.context import FSMContext
from app.state.model_fsm import ModelFSM
from app.keyboards.inline import display_timeout_keyboard
from logger import logger
from aiogram.filters import StateFilter
from app.services.esp_service import get_settings, set_settings

router = Router()

@router.callback_query(F.data == "display_timeout")
async def ask_timeout(callback: CallbackQuery, state: FSMContext):
    """Показываем текущее время. Даем кнопки для выбора пресетов или ввода руками и кнопку назад."""

    settings = await get_settings()
    
    await callback.message.answer(
        f"Текущее значение таймаута дисплея: {settings.displayTimeout}",
        reply_markup=display_timeout_keyboard
    )
    
    await callback.answer()

# Вариант 1: Простая обработка по паттерну
@router.callback_query(F.data.startswith("set_display_timeout_"))
async def handle_display_timeout(callback: CallbackQuery):
    """Обработчик выбора таймаута экрана"""
    
    # Извлекаем номер режима из callback_data
    timeout_str = callback.data.replace("set_display_timeout_", "")
    
    try:

        settings = await get_settings()

        if settings is None:
            await callback.message.answer("Не удалось получить настройки.")
            return

        timeout = int(timeout_str)

        settings.displayTimeout = timeout

        await set_settings(settings)

        # Обновляем сообщение с подтверждением
        await callback.message.edit_text(
            f"✅ Указан таймаут: *{timeout}*\n\n"
            f"Таймаут экрана установлен. Устройство получит настройки.",
            parse_mode="Markdown"
        )
        
        await callback.answer(f"Таймаут {timeout} установлен")
        
    except Exception as e:
        logger.error(f"Ошибка установки режима: {e}")
        await callback.answer("Произошла ошибка", show_alert=True)