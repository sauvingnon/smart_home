from aiogram import Router, types, F
from aiogram.types import CallbackQuery, Message
from aiogram.fsm.context import FSMContext
from aiogram.filters import StateFilter
from app.state.model_fsm import ModelFSM
from app.keyboards.inline import get_relay_handle_keyboard, get_cancel_keyboard, get_back_to_relay_keyboard
from app.services.esp_service import get_settings, set_settings
from logger import logger
import re

router = Router()

# --- СОСТОЯНИЯ FSM ---
class RelayScheduleStates:
    WAITING_DAY_ON = "waiting_day_on"
    WAITING_DAY_OFF = "waiting_day_off"
    WAITING_NIGHT_ON = "waiting_night_on"
    WAITING_NIGHT_OFF = "waiting_night_off"

# --- ОБЩИЕ ФУНКЦИИ ---
def validate_time_format(time_str: str) -> tuple[int, int] | None:
    """Проверяет формат HH:MM и возвращает (часы, минуты)"""
    match = re.match(r'^([0-1]?[0-9]|2[0-3]):([0-5][0-9])$', time_str)
    if match:
        hours = int(match.group(1))
        minutes = int(match.group(2))
        # Проверяем что часы 0-23, минуты 0-59
        if 0 <= hours <= 23 and 0 <= minutes <= 59:
            return hours, minutes
    return None

# Кнопка «⚙️ Настройки» (callback_data="rele_settings")
@router.callback_query(F.data == "rele_settings")
async def cmd_rele_settings_callback(callback: CallbackQuery, state: FSMContext):

    settings = await get_settings()

    if settings is None:
        await callback.message.answer("❌ Не удалось получить настройки.")
        return
    
    # Определяем режим с иконкой
    if settings.relayMode:
        relay_mode_str = "⚙️ Ручной"
        mode_icon = "🔄"
    else:
        relay_mode_str = "🤖 Автоматический"
        mode_icon = "⏰"
    
    # Форматируем время с ведущими нулями
    def format_time(hour, minute):
        return f"{hour:02d}:{minute:02d}"
    
    # Иконки статусов
    on_icon = "✅"
    off_icon = "❌"
    
    await callback.message.answer(
        f"<b>⚡ Настройка режима работы реле</b>\n\n"
        
        f"<b>{mode_icon} Текущий режим:</b> <code>{relay_mode_str}</code>\n"
        
        f"<b>👤 Ручной режим:</b>\n"
        f"🌙 Ночное реле: {on_icon if settings.manualNightState else off_icon} "
        f"{'Включено' if settings.manualNightState else 'Отключено'}\n"
        f"☀️ Дневное реле: {on_icon if settings.manualDayState else off_icon} "
        f"{'Включено' if settings.manualDayState else 'Отключено'}\n\n"
        
        f"<b>🤖 Автоматический режим:</b>\n"
        f"🌙 Ночное: <code>{format_time(settings.nightOnHour, settings.nightOnMinute)}</code> – "
        f"<code>{format_time(settings.nightOffHour, settings.nightOffMinute)}</code>\n"
        f"☀️ Дневное: <code>{format_time(settings.dayOnHour, settings.dayOnMinute)}</code> – "
        f"<code>{format_time(settings.dayOffHour, settings.dayOffMinute)}</code>\n\n",
        parse_mode="HTML",
        reply_markup=get_relay_handle_keyboard(settings)
    )

    await callback.answer()

@router.callback_query(F.data == "change_relay_mode")
async def handle_relay_mode(callback: CallbackQuery):
    """Обработка смены режима работы реле."""
    
    settings = await get_settings()
    
    if settings is None:
        await callback.message.answer("❌ Не удалось получить настройки.")
        await callback.answer()
        return

    # Определяем режим с иконкой
    if settings.relayMode:
        relay_mode_str = "Автоматический"
        settings.relayMode = False
    else:
        relay_mode_str = "Ручной"
        settings.relayMode = True

    await set_settings(settings)

    await callback.message.edit_text(
            f"✅ Выбран режим работы реле: *{relay_mode_str}*\n\n"
            f"Режим работы реле установлен. Устройство получит настройки.",
            parse_mode="Markdown"
        )

    await callback.answer()
        

@router.callback_query(F.data.startswith("change_relay_handle_"))
async def handle_display_timeout(callback: CallbackQuery):
    """Обработчик вкл\откл обоих реле в ручном режиме"""
    
    # Извлекаем выбранное реле из строки
    relay_str = callback.data.replace("change_relay_handle_", "")
    relay_name = ""
    state_name = ""
    
    settings = await get_settings()
    
    if settings is None:
        await callback.message.answer("❌ Не удалось получить настройки.")
        await callback.answer()
        return

    # Определяем реле с которым работаем
    if relay_str == "day":
        relay_name = "дневного"
        settings.manualDayState = False if settings.manualDayState else True
        state_name = "Включено" if settings.manualDayState else "Отключено"
    elif relay_str == "night":
        relay_name = "ночного"
        settings.manualNightState = False if settings.manualNightState else True
        state_name = "Включено" if settings.manualNightState else "Отключено"
    else:
        await callback.message.answer("Не удалось обработать выбор.")
        return
    
    await set_settings(settings)

    await callback.message.edit_text(
            f"✅ Выбрано состояние ручного режима {relay_name} реле: *{state_name}*\n\n"
            f"Состояние {relay_name} реле установлено. Устройство получит настройки.",
            parse_mode="Markdown"
        )

    await callback.answer()

# --- ДНЕВНОЕ РЕЛЕ: ВКЛЮЧЕНИЕ ---
@router.callback_query(F.data == "set_relay_auto_day")
async def ask_day_on_time(callback: CallbackQuery, state: FSMContext):
    """Запрашиваем время ВКЛЮЧЕНИЯ дневного реле"""
    await callback.message.edit_text(
        "⏰ <b>Время ВКЛЮЧЕНИЯ дневного реле</b>\n\n"
        "Введите время в формате <code>HH:MM</code>\n"
        "Пример: <code>08:00</code>\n\n"
        "Или нажмите ❌ Отмена",
        parse_mode="HTML",
        reply_markup=get_cancel_keyboard()
    )
    await state.set_state(RelayScheduleStates.WAITING_DAY_ON)
    await callback.answer()

@router.message(StateFilter(RelayScheduleStates.WAITING_DAY_ON), F.text)
async def set_day_on_time(message: Message, state: FSMContext):
    """Получаем время включения и запрашиваем выключение"""
    time_data = validate_time_format(message.text.strip())
    
    if not time_data:
        await message.answer(
            "❌ Неверный формат!\n"
            "Используйте <code>HH:MM</code> (например: 08:30)\n"
            "Часы: 0-23, Минуты: 0-59",
            parse_mode="HTML",
            reply_markup=get_cancel_keyboard()
        )
        return
    
    hours, minutes = time_data
    
    # Сохраняем время включения
    await state.update_data(day_on_hour=hours, day_on_minute=minutes)
    
    # Запрашиваем время выключения
    await message.answer(
        "⏰ <b>Время ВЫКЛЮЧЕНИЯ дневного реле</b>\n\n"
        "Введите время в формате <code>HH:MM</code>\n"
        "Пример: <code>22:00</code>\n\n"
        "Или нажмите ❌ Отмена",
        parse_mode="HTML",
        reply_markup=get_cancel_keyboard()
    )
    await state.set_state(RelayScheduleStates.WAITING_DAY_OFF)

@router.message(StateFilter(RelayScheduleStates.WAITING_DAY_OFF), F.text)
async def set_day_off_time(message: Message, state: FSMContext):
    """Получаем время выключения и сохраняем дневное реле"""
    time_data = validate_time_format(message.text.strip())
    
    if not time_data:
        await message.answer(
            "❌ Неверный формат!\n"
            "Используйте <code>HH:MM</code> (например: 22:00)",
            parse_mode="HTML",
            reply_markup=get_cancel_keyboard()
        )
        return
    
    hours, minutes = time_data
    
    # Получаем время включения из состояния
    data = await state.get_data()
    day_on_hour = data.get('day_on_hour')
    day_on_minute = data.get('day_on_minute')
    
    if day_on_hour is None or day_on_minute is None:
        await message.answer("❌ Ошибка: не найдено время включения")
        await state.clear()
        return
    
    # Получаем текущие настройки
    settings = await get_settings()
    if not settings:
        await message.answer("❌ Ошибка получения настроек")
        await state.clear()
        return
    
    # Обновляем настройки дневного реле
    settings.dayOnHour = day_on_hour
    settings.dayOnMinute = day_on_minute
    settings.dayOffHour = hours
    settings.dayOffMinute = minutes
    
    # Сохраняем
    success = await set_settings(settings)
    
    if success:
        await message.answer(
            f"✅ <b>Дневное реле установлено!</b>\n\n"
            f"⏰ Включение: <code>{day_on_hour:02d}:{day_on_minute:02d}</code>\n"
            f"⏰ Выключение: <code>{hours:02d}:{minutes:02d}</code>",
            parse_mode="HTML",
            reply_markup=get_back_to_relay_keyboard()
        )
    else:
        await message.answer(
            "❌ Ошибка сохранения настроек",
            reply_markup=get_back_to_relay_keyboard()
        )
    
    await state.clear()

# --- НОЧНОЕ РЕЛЕ: ВКЛЮЧЕНИЕ ---
@router.callback_query(F.data == "set_relay_auto_night")
async def ask_night_on_time(callback: CallbackQuery, state: FSMContext):
    """Запрашиваем время ВКЛЮЧЕНИЯ ночного реле"""
    await callback.message.edit_text(
        "🌙 <b>Время ВКЛЮЧЕНИЯ ночного реле</b>\n\n"
        "Введите время в формате <code>HH:MM</code>\n"
        "Пример: <code>22:00</code>\n\n"
        "Или нажмите ❌ Отмена",
        parse_mode="HTML",
        reply_markup=get_cancel_keyboard()
    )
    await state.set_state(RelayScheduleStates.WAITING_NIGHT_ON)
    await callback.answer()

@router.message(StateFilter(RelayScheduleStates.WAITING_NIGHT_ON), F.text)
async def set_night_on_time(message: Message, state: FSMContext):
    """Получаем время включения и запрашиваем выключение"""
    time_data = validate_time_format(message.text.strip())
    
    if not time_data:
        await message.answer(
            "❌ Неверный формат!\n"
            "Используйте <code>HH:MM</code> (например: 22:00)",
            parse_mode="HTML",
            reply_markup=get_cancel_keyboard()
        )
        return
    
    hours, minutes = time_data
    
    # Сохраняем время включения
    await state.update_data(night_on_hour=hours, night_on_minute=minutes)
    
    # Запрашиваем время выключения
    await message.answer(
        "🌙 <b>Время ВЫКЛЮЧЕНИЯ ночного реле</b>\n\n"
        "Введите время в формате <code>HH:MM</code>\n"
        "Пример: <code>08:00</code>\n\n"
        "Или нажмите ❌ Отмена",
        parse_mode="HTML",
        reply_markup=get_cancel_keyboard()
    )
    await state.set_state(RelayScheduleStates.WAITING_NIGHT_OFF)

@router.message(StateFilter(RelayScheduleStates.WAITING_NIGHT_OFF), F.text)
async def set_night_off_time(message: Message, state: FSMContext):
    """Получаем время выключения и сохраняем ночное реле"""
    time_data = validate_time_format(message.text.strip())
    
    if not time_data:
        await message.answer(
            "❌ Неверный формат!\n"
            "Используйте <code>HH:MM</code> (например: 08:00)",
            parse_mode="HTML",
            reply_markup=get_cancel_keyboard()
        )
        return
    
    hours, minutes = time_data
    
    # Получаем время включения из состояния
    data = await state.get_data()
    night_on_hour = data.get('night_on_hour')
    night_on_minute = data.get('night_on_minute')
    
    if night_on_hour is None or night_on_minute is None:
        await message.answer("❌ Ошибка: не найдено время включения")
        await state.clear()
        return
    
    # Получаем текущие настройки
    settings = await get_settings()
    if not settings:
        await message.answer("❌ Ошибка получения настроек")
        await state.clear()
        return
    
    # Обновляем настройки ночного реле
    settings.nightOnHour = night_on_hour
    settings.nightOnMinute = night_on_minute
    settings.nightOffHour = hours
    settings.nightOffMinute = minutes
    
    # Сохраняем
    success = await set_settings(settings)
    
    if success:
        await message.answer(
            f"✅ <b>Ночное реле установлено!</b>\n\n"
            f"🌙 Включение: <code>{night_on_hour:02d}:{night_on_minute:02d}</code>\n"
            f"🌙 Выключение: <code>{hours:02d}:{minutes:02d}</code>",
            parse_mode="HTML",
            reply_markup=get_back_to_relay_keyboard()
        )
    else:
        await message.answer(
            "❌ Ошибка сохранения настроек",
            reply_markup=get_back_to_relay_keyboard()
        )
    
    await state.clear()

# --- ОТМЕНА ---
@router.callback_query(F.data == "cancel_schedule")
async def cancel_schedule(callback: CallbackQuery, state: FSMContext):
    """Отмена установки расписания"""
    await state.clear()
    await callback.message.edit_text(
        "❌ Установка расписания отменена",
        reply_markup=get_back_to_relay_keyboard()
    )
    await callback.answer()

# --- ОБРАБОТКА НЕВЕРНОГО ВВОДА ---
@router.message(StateFilter(
    RelayScheduleStates.WAITING_DAY_ON,
    RelayScheduleStates.WAITING_DAY_OFF,
    RelayScheduleStates.WAITING_NIGHT_ON,
    RelayScheduleStates.WAITING_NIGHT_OFF
))
async def handle_wrong_time_input(message: Message, state: FSMContext):
    """Обработка неверного ввода времени"""
    current_state = await state.get_state()
    
    # Определяем какой именно реле настраиваем
    relay_name = "дневного" if "DAY" in current_state else "ночного"
    action = "включения" if "ON" in current_state else "выключения"
    
    await message.answer(
        f"❌ Неверный формат для {relay_name} реле ({action})!\n\n"
        "Введите время в формате <code>HH:MM</code>\n"
        "Пример: <code>08:30</code> или <code>22:00</code>\n\n"
        "Или нажмите ❌ Отмена",
        parse_mode="HTML",
        reply_markup=get_cancel_keyboard()
    )