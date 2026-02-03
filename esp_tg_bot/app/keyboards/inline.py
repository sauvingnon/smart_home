# 💡 Все клавиатуры и команды бота
from aiogram.types import InlineKeyboardMarkup, InlineKeyboardButton, BotCommand
from app.schemas.ai_service import ModelName, USER_MODELS

# 📌 Команды, отображаемые в меню Telegram
commands = [
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

# Настройки таймаута экрана
display_timeout_keyboard = InlineKeyboardMarkup(
    inline_keyboard=[
        [InlineKeyboardButton(text="• 10 секунд", callback_data="set_display_timeout_10")],
        [InlineKeyboardButton(text="• 30 секунд", callback_data="set_display_timeout_30")],
        [InlineKeyboardButton(text="• 60 секунд", callback_data="set_display_timeout_60")],
        [InlineKeyboardButton(text="Назад", callback_data="settings")]
    ]
)


# ⚙️ Настройка режима экрана
display_mode_keyboard = InlineKeyboardMarkup(
    inline_keyboard=[
        [InlineKeyboardButton(text="Постоянный", callback_data="set_display_mode_0")],
        [InlineKeyboardButton(text="Автоматический", callback_data="set_display_mode_1")],
        [InlineKeyboardButton(text="Умный", callback_data="set_display_mode_2")],
        [InlineKeyboardButton(text="Назад", callback_data="settings")]
    ]
)

# ⚙️ Настройка режима реле
relay_handle_keyboard = InlineKeyboardMarkup(
    inline_keyboard=[
        [InlineKeyboardButton(text="ВКЛ\ОТКЛ ДНЕВНОЙ", callback_data="change_relay_handle_day")], # Тоггл для ручного режима дневного реле
        [InlineKeyboardButton(text="ВКЛ\ОТКЛ НОЧНОЙ", callback_data="change_relay_handle_night")], # Тоггл для ручного режима ночного реле
        [InlineKeyboardButton(text="НАСТРОИТЬ ДНЕВНОЙ", callback_data="set_relay_auto_day")], # Установка времени для дневного реле
        [InlineKeyboardButton(text="НАСТРОИТЬ НОЧНОЙ", callback_data="set_relay_auto_night")], # Установка времени для ночного реле
        [InlineKeyboardButton(text="Переключить режим реле", callback_data="change_relay_mode")], # Переключить режим реле
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