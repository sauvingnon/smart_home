from aiogram import Router, types, F
from aiogram.types import CallbackQuery, Message
from aiogram.fsm.context import FSMContext
from app.state.model_fsm import ModelFSM
from app.keyboards.inline import settings_keyboard

router = Router()

# Команда /settings в статичной клавиатуре
@router.message(F.text == "/settings")
async def cmd_settings(message: Message, state: FSMContext):

    await message.answer("⚙️ Настройки", reply_markup=settings_keyboard)

# Кнопка «⚙️ Настройки» (callback_data="settings")
@router.callback_query(F.data == "settings")
async def cmd_settings_callback(callback: CallbackQuery, state: FSMContext):
    
    await callback.message.answer("⚙️ Настройки", reply_markup=settings_keyboard)

    await callback.answer()