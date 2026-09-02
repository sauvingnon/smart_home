// Метки people-эталонов (dataset/<label>/) -> отображаемое имя на фронте.
// Общий источник для VideoPage (фильтр по людям) и VideoSettingsPage
// (тумблеры уведомлений о посещении).
export const RECOGNIZED_NAMES: Record<string, string> = {
  andrey: 'Андрей',
  liliya: 'Лилия',
  kamelia: 'Камелия',
  grisha: 'Гриша',
}

export const recognizedDisplayName = (label: string) => RECOGNIZED_NAMES[label] ?? label

export const PEOPLE_FILTERS = Object.keys(RECOGNIZED_NAMES)
