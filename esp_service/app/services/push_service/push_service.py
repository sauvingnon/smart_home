# app/services/push_service/push_service.py
import asyncio
import json

from pywebpush import webpush, WebPushException

from config import VAPID_PRIVATE_KEY, VAPID_CONTACT_EMAIL
from logger import logger


class PushSubscriptionExpired(Exception):
    """Подписка больше не действительна (браузер её отозвал) — надо удалить."""


async def send_push(subscription: dict, payload: dict) -> bool:
    """Отправляет Web Push уведомление. pywebpush синхронный (requests) —
    уводим в отдельный поток, чтобы не блокировать event loop."""
    return await asyncio.to_thread(_send_push_sync, subscription, payload)


def _send_push_sync(subscription: dict, payload: dict) -> bool:
    try:
        webpush(
            subscription_info=subscription,
            data=json.dumps(payload, ensure_ascii=False),
            vapid_private_key=VAPID_PRIVATE_KEY,
            vapid_claims={"sub": f"mailto:{VAPID_CONTACT_EMAIL}"},
        )
        return True
    except WebPushException as e:
        status = e.response.status_code if e.response is not None else None
        if status in (404, 410):
            raise PushSubscriptionExpired() from e
        logger.warning(f"⚠️ Ошибка отправки push: {e}")
        return False
