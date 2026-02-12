from aiogram import Dispatcher
from app.handlers import start, settings, monitoring, display_mode, display_timeout, relay_settings, panel

def setup_routers(dp: Dispatcher):
    dp.include_router(start.router)
    dp.include_router(settings.router)
    dp.include_router(monitoring.router)
    dp.include_router(display_mode.router)
    dp.include_router(display_timeout.router)
    dp.include_router(relay_settings.router)
    dp.include_router(panel.router)

