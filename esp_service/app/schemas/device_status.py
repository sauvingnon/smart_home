# app/core/enums.py
from enum import Enum

class DeviceStatus(Enum):
    NEVER_CONNECTED = "never_connected"  # никогда не подключался
    ONLINE = "online"                    # онлайн (< 2 минут)
    OFFLINE = "offline"                  # оффлайн (2-5 минут)
    DEAD = "dead"                        # мертв (> 5 минут)