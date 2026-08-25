#!/usr/bin/env python3
"""
Управление юзерами чата — интерактивный CLI, без веб-интерфейса.

Раньше ключи выдавал Telegram-бот через POST /auth/generate_key + BOT_SECRET.
Бота больше нет, а тот эндпоинт не проверял, что user_id вообще существует —
опечатка в ID тихо создавала рабочую сессию "юзера-призрака". Вместо этого —
ручной запуск прямо на сервере:

    docker exec -it esp_service python manage_users.py
"""
import asyncio
import sys

from app.services.redis.cache_manager import CacheManager
from config import REDIS_URL


def prompt(label: str) -> str:
    return input(f"{label}: ").strip()


def prompt_int(label: str) -> int:
    while True:
        raw = prompt(label)
        if raw.isdigit():
            return int(raw)
        print("Нужно число, попробуй ещё раз.")


def prompt_yes_no(label: str, default: bool = False) -> bool:
    suffix = "[Y/n]" if default else "[y/N]"
    raw = input(f"{label} {suffix}: ").strip().lower()
    if not raw:
        return default
    return raw in ("y", "yes", "д", "да")


async def cmd_list(cache: CacheManager):
    users = await cache.list_users()
    if not users:
        print("Юзеров нет.")
        return
    print(f"{'ID':<12} {'username':<14} {'display_name':<16} role")
    print("-" * 55)
    for u in users:
        print(f"{u['user_id']:<12} {u['username']:<14} {u['display_name']:<16} {u['role']}")


async def cmd_create(cache: CacheManager):
    user_id = prompt_int("Telegram ID")
    if await cache.get_user(user_id):
        print("Такой юзер уже есть.")
        return

    username = prompt("username (латиницей, для внутренних нужд)")
    display_name = prompt("Имя для отображения в чате")
    role = "admin" if prompt_yes_no("Сделать админом?") else "user"

    await cache.create_user(user_id, username, display_name, role)
    key = await cache.generate_key(user_id)
    print(f"\n✅ Юзер {display_name} создан.")
    print(f"Ключ для входа (вставить в форму логина в приложении): {key}")


async def cmd_delete(cache: CacheManager):
    user_id = prompt_int("Telegram ID юзера для удаления")
    user = await cache.get_user(user_id)
    if not user:
        print("Такого юзера нет.")
        return

    if not prompt_yes_no(
        f"Точно удалить {user['display_name']} ({user_id})? Все его ключи будут отозваны"
    ):
        print("Отменено.")
        return

    revoked = await cache.revoke_all_keys_for_user(user_id)
    await cache.delete_user(user_id)
    print(f"✅ Юзер {user['display_name']} удалён, отозвано ключей: {revoked}")


async def cmd_reissue_key(cache: CacheManager):
    user_id = prompt_int("Telegram ID")
    user = await cache.get_user(user_id)
    if not user:
        print("Такого юзера нет — сначала создай через пункт 2.")
        return

    revoked = await cache.revoke_all_keys_for_user(user_id)
    key = await cache.generate_key(user_id)
    print(f"\n✅ Новый ключ для {user['display_name']} выпущен (старых отозвано: {revoked}).")
    print(f"Ключ для входа (вставить в форму логина в приложении): {key}")


MENU = {
    "1": ("Список юзеров", cmd_list),
    "2": ("Создать юзера", cmd_create),
    "3": ("Удалить юзера", cmd_delete),
    "4": ("Перевыпустить ключ", cmd_reissue_key),
}


async def main():
    cache = CacheManager(REDIS_URL)
    if not await cache.connect():
        print("❌ Не удалось подключиться к Redis.")
        sys.exit(1)

    try:
        while True:
            print("\n=== Управление юзерами ===")
            for key, (label, _) in MENU.items():
                print(f"{key}. {label}")
            print("0. Выход")

            choice = input("> ").strip()
            if choice == "0":
                break

            action = MENU.get(choice)
            if not action:
                print("Не понял, выбери пункт из списка.")
                continue

            try:
                await action[1](cache)
            except Exception as e:
                print(f"❌ Ошибка: {e}")
    finally:
        await cache.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
