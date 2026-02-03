from aiogram import Router, types, F
from aiogram.types import CallbackQuery, Message
from aiogram.fsm.context import FSMContext
from app.state.model_fsm import ModelFSM
from app.keyboards.inline import display_mode_keyboard
from app.services.esp_service import get_settings, set_settings
from logger import logger

router = Router()

mode_names = {
        0: "Постоянный",
        1: "Автоматический", 
        2: "Умный"
    }

# Кнопка «⚙️ Настройки» (callback_data="display_mode")
@router.callback_query(F.data == "display_mode")
async def cmd_display_mode_callback(callback: CallbackQuery, state: FSMContext):

    settings = await get_settings()

    mode_name = mode_names.get(settings.displayMode, "Неизвестный")

    if settings is None:
        await callback.message.answer("Не удалось получить настройки.")
        return
    
    await callback.message.answer(f"Настройка режима экрана. Текущий {mode_name}", reply_markup=display_mode_keyboard)

    await callback.answer()

# Вариант 1: Простая обработка по паттерну
@router.callback_query(F.data.startswith("set_display_mode_"))
async def handle_display_mode(callback: CallbackQuery):
    """Обработчик выбора режима экрана"""
    
    # Извлекаем номер режима из callback_data
    mode_str = callback.data.replace("set_display_mode_", "")
    
    try:

        settings = await get_settings()

        if settings is None:
            await callback.message.answer("Не удалось получить настройки.")
            return

        mode = int(mode_str)
        
        # Определяем текстовое название режима
        
        mode_name = mode_names.get(mode, "Неизвестный")

        settings.displayMode = mode

        await set_settings(settings)

        # Обновляем сообщение с подтверждением
        await callback.message.edit_text(
            f"✅ Выбран режим: *{mode_name}*\n\n"
            f"Режим экрана установлен. Устройство получит настройки.",
            parse_mode="Markdown"
        )
        
        # Здесь отправляем команду на устройство через MQTT
        # await send_display_mode_to_device(
        #     device_id="greenhouse_01",
        #     mode=mode
        # )
        
        await callback.answer(f"Режим {mode_name} установлен")
        
    except ValueError:
        await callback.answer("Ошибка: некорректный режим", show_alert=True)
    except Exception as e:
        logger.error(f"Ошибка установки режима: {e}")
        await callback.answer("Произошла ошибка", show_alert=True)