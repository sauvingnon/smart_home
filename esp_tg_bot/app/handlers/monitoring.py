from aiogram import Router, types, F
from aiogram.types import CallbackQuery, Message
from aiogram.fsm.context import FSMContext
from app.services.esp_service import get_telemetry
from datetime import datetime, timezone

router = Router()

# Команда /monitor в статичной клавиатуре
@router.message(F.text == "/monitor")
async def cmd_monitor(message: Message, state: FSMContext):
    
    await monitoring_func(message=message)

# Кнопка «📊 Мониторинг (callback_data="monitor")
@router.callback_query(F.data == "monitor")
async def cmd_monitor_callback(callback: CallbackQuery, state: FSMContext):
    
    await monitoring_func(message=callback.message)

    await callback.answer()

async def monitoring_func(message: Message):
    """
    Показать текущие показатели дома
    """
    try:
        telemetry = await get_telemetry()
        
        if not telemetry:
            await message.answer(
                "📡 *Нет данных от устройства*\n\n"
                "Устройство не подключено или данные еще не получены\\.\n"
                "Попробуйте позже или проверьте подключение устройства\\."
            )
            return
            
        # Получаем текущее время в UTC (aware)
        now_utc = datetime.now(timezone.utc)
        
        # Проверяем тип timestamp и приводим к aware datetime
        if telemetry.timestamp.tzinfo is None:
            # Если timestamp наивный, предполагаем что это UTC
            timestamp_utc = telemetry.timestamp.replace(tzinfo=timezone.utc)
        else:
            # Если уже aware, оставляем как есть
            timestamp_utc = telemetry.timestamp
        
        # Вычисляем разницу
        time_diff = now_utc - timestamp_utc
        time_ago = time_diff.total_seconds()
        
        # Форматируем время
        last_update = timestamp_utc.strftime("%H:%M:%S")

        # Флаг того, что данные актуальны
        no_info = True
        
        # Определяем свежесть данных
        if time_ago < 60:
            no_info = False
            freshness = "🟢 Только что"
        elif time_ago < 300:  # 5 минут
            freshness = f"🟡 {int(time_ago//60)} мин назад"
        elif time_ago < 1800:  # 30 минут
            freshness = f"🟠 {int(time_ago//60)} мин назад"
        elif time_ago < 86400:  # 24 часа
            freshness = f"🔴 {int(time_ago//3600)} ч назад"
        else:
            freshness = f"⚫ {int(time_ago//86400)} д назад"
        
        # Эмодзи для температуры
        if telemetry.temperature > 28:
            temp_emoji = "🔥"
            temp_status = "Высокая"
        elif telemetry.temperature < 18:
            temp_emoji = "❄️"
            temp_status = "Низкая"
        else:
            temp_emoji = "🌡️"
            temp_status = "Норма"
        
        # Эмодзи для влажности
        if telemetry.humidity > 70:
            hum_emoji = "💦"
            hum_status = "Высокая"
        elif telemetry.humidity < 40:
            hum_emoji = "🏜️"
            hum_status = "Низкая"
        else:
            hum_emoji = "💧"
            hum_status = "Норма"
        
        # Создаем сообщение
        response = (
            f"🌿 *ДОМ: МОНИТОРИНГ*\n"
            f"━━━━━━━━━━━━━━━━━━\n\n"
            
            f"📋 *Основные показатели:*\n"
            f"{temp_emoji} *Температура:* `{telemetry.temperature:.1f}°C` \\- *{temp_status}*\n"
            f"{hum_emoji} *Влажность:* `{telemetry.humidity:.1f}%` \\- *{hum_status}*\n\n"
            
            f"📊 *Системная информация:*\n"
            f"📟 *Устройство:* `{telemetry.device_id}`\n"
        )
        
        # Добавляем опциональные поля
        if telemetry.uptime is not None:
            hours = telemetry.uptime // 3600
            minutes = (telemetry.uptime % 3600) // 60
            days = hours // 24
            if days > 0:
                response += f"⏱️ *Работает:* `{days} д {hours%24} ч`\n"
            else:
                response += f"⏱️ *Работает:* `{hours} ч {minutes} м`\n"
        
        if telemetry.free_memory is not None:
            memory_kb = telemetry.free_memory / 1024
            memory_mb = memory_kb / 1024
            if memory_mb >= 1:
                response += f"💾 *Память:* `{memory_mb:.1f} MB`\n"
            else:
                response += f"💾 *Память:* `{memory_kb:.0f} KB`\n"

        if telemetry.bluetooth_is_active is not None:
            bt_status = "✅ Активен" if telemetry.bluetooth_is_active else "❌ Неактивен"
            response += f"🔵 *Bluetooth:* `{bt_status}`\n"
        
        response += f"\n━━━━━━━━━━━━━━━━━━\n"
        response += f"📡 *Статус:* {freshness}\n"
        response += f"🕐 *Обновлено:* `{last_update} UTC`\n"
        response += f"📅 *Дата:* `{timestamp_utc.strftime('%d.%m.%Y')}`\n"
        
        # Добавляем рекомендации
        recommendations = []
        if telemetry.temperature > 28:
            recommendations.append("• Снизить температуру \\(проветрить\\)")
        elif telemetry.temperature < 18:
            recommendations.append("• Повысить температуру")
            
        if telemetry.humidity > 70:
            recommendations.append("• Снизить влажность \\(включить вентиляцию\\)")
        elif telemetry.humidity < 40:
            recommendations.append("• Повысить влажность")
        
        if recommendations:
            response += "\n💡 *Рекомендации:*\n"
            response += "\n".join(recommendations)
        
        await message.answer(response, parse_mode="MarkdownV2")
        
    except Exception as e:
        # Без Markdown для сообщения об ошибке
        await message.answer(
            f"❌ Ошибка получения данных\n\n"
            f"Произошла ошибка: {str(e)[:100]}\n"
            f"Попробуйте позже или обратитесь к администратору."
        )