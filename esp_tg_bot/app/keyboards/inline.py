# 💡 Все клавиатуры и команды бота
from aiogram.types import InlineKeyboardMarkup, InlineKeyboardButton, BotCommand
from app.schemas.ai_service import ModelName, USER_MODELS
from app.schemas.settings import SettingsData

# 📌 Команды, отображаемые в меню Telegram
commands = [
    BotCommand(command="panel", description="🎛 Управление ESP"),
    BotCommand(command="start", description="🏠 Перезапуск"),
    BotCommand(command="monitor", description="📊 Мониторинг"),
    BotCommand(command="settings", description="⚙️ Настройки")
]

# 📱 Клавиатура приветствия
start_keyboard = InlineKeyboardMarkup(
    inline_keyboard=[
        [InlineKeyboardButton(text="📊 Мониторинг", callback_data="monitor")],
        [InlineKeyboardButton(text="⚙️ Настройки", callback_data="settings")]
    ]
)

# ⚙️ Клавиатура настроек
settings_keyboard = InlineKeyboardMarkup(
    inline_keyboard=[
        [InlineKeyboardButton(text="📱 Режим экрана", callback_data="display_mode")],
        [InlineKeyboardButton(text="⏳ Таймаут экрана", callback_data="display_timeout")],
        [InlineKeyboardButton(text="🔌 Настройка реле", callback_data="rele_settings")],
        [InlineKeyboardButton(text="🚽 Настройка уборной", callback_data="toilet_settings")]
    ]
)

# Динамические клавиатуры (функции)

def get_display_timeout_keyboard(settings: SettingsData) -> InlineKeyboardMarkup:
    """Клавиатура таймаута экрана с индикатором активного значения"""
    current_timeout = settings.displayTimeout
    
    # Определяем какой таймаут активен
    timeout_10_prefix = "✅ " if current_timeout == 10 else "• "
    timeout_30_prefix = "✅ " if current_timeout == 30 else "• "
    timeout_60_prefix = "✅ " if current_timeout == 60 else "• "
    
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text=f"{timeout_10_prefix}10 секунд", callback_data="set_display_timeout_10")],
            [InlineKeyboardButton(text=f"{timeout_30_prefix}30 секунд", callback_data="set_display_timeout_30")],
            [InlineKeyboardButton(text=f"{timeout_60_prefix}60 секунд", callback_data="set_display_timeout_60")],
            [InlineKeyboardButton(text="Назад", callback_data="settings")]
        ]
    )


def get_display_mode_keyboard(settings: SettingsData) -> InlineKeyboardMarkup:
    """Клавиатура режима экрана с индикатором активного режима"""
    current_mode = settings.displayMode
    
    mode_names = {
        0: "Постоянный",
        1: "Автоматический",
        2: "Умный"
    }
    
    # Определяем какой режим активен
    mode_0_prefix = "✅ " if current_mode == 0 else "○ "
    mode_1_prefix = "✅ " if current_mode == 1 else "○ "
    mode_2_prefix = "✅ " if current_mode == 2 else "○ "
    
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text=f"{mode_0_prefix}Постоянный", callback_data="set_display_mode_0")],
            [InlineKeyboardButton(text=f"{mode_1_prefix}Автоматический", callback_data="set_display_mode_1")],
            [InlineKeyboardButton(text=f"{mode_2_prefix}Умный", callback_data="set_display_mode_2")],
            [InlineKeyboardButton(text="Назад", callback_data="settings")]
        ]
    )


def get_relay_handle_keyboard(settings: SettingsData) -> InlineKeyboardMarkup:
    """Клавиатура настройки реле с индикаторами состояния"""
    
    # Определяем текущий режим и состояние
    if settings.relayMode:  # Ручной режим
        relay_mode_text = "🔄 Переключить на Авто"
    else:  # Автоматический режим
        relay_mode_text = "⏰ Переключить на Ручной"
        
    day_state_icon = "🟢" if settings.manualDayState else "🔴"
    night_state_icon = "🟢" if settings.manualNightState else "🔴"
    day_button_text = f"{day_state_icon} ВКЛ/ОТКЛ ДНЕВНОЙ (сейчас {'ВКЛ' if settings.manualDayState else 'ОТКЛ'})"
    night_button_text = f"{night_state_icon} ВКЛ/ОТКЛ НОЧНОЙ (сейчас {'ВКЛ' if settings.manualNightState else 'ОТКЛ'})"
    
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text=day_button_text, callback_data="change_relay_handle_day")],
            [InlineKeyboardButton(text=night_button_text, callback_data="change_relay_handle_night")],
            [InlineKeyboardButton(text="📝 Расписание дневного", callback_data="set_relay_auto_day")],
            [InlineKeyboardButton(text="📝 Расписание ночного", callback_data="set_relay_auto_night")],
            [InlineKeyboardButton(text=relay_mode_text, callback_data="change_relay_mode")],
            [InlineKeyboardButton(text="Назад", callback_data="settings")]
        ]
    )

def get_cancel_keyboard() -> InlineKeyboardMarkup:
    """Клавиатура с кнопкой отмены"""
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="❌ Отмена", callback_data="cancel_schedule")]
        ]
    )

def get_back_to_relay_keyboard() -> InlineKeyboardMarkup:
    """Клавиатура для возврата к меню реле"""
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="⬅️ Назад к реле", callback_data="rele_settings")]
        ]
    )