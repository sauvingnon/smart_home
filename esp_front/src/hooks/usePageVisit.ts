// hooks/usePageVisit.ts
import { useEffect } from 'react';
import { apiClient } from '../api/client';

// Дергать один раз при реальном монтировании страницы на её роуте — это и
// есть "визит" для ленты активности. Специально не привязан ни к каким
// данным-фетчам страницы: если рядом заведут глобальный провайдер с
// фоновой синхронизацией (как ChatProvider), он не должен незаметно начать
// засчитываться визитом — только сама страница решает, что её открыли.
export function usePageVisit(section: string): void {
  useEffect(() => {
    apiClient.recordPageVisit(section).catch(() => {
      // best-effort — лента активности не критичный путь
    });
  }, [section]);
}
