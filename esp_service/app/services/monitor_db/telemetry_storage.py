import sqlite3
from datetime import datetime, timedelta
from typing import List, Optional, Dict, Any
from pathlib import Path
from contextlib import contextmanager
from logger import logger

from app.schemas.telemetry_history import (
    TelemetryRecord,
    StatsResponse,
    RawStats
)

class TelemetryStorage:
    """
    Хранилище телеметрии на SQLite.
    - Внутренние методы идут за сырыми данными в БД
    - Публичные методы возвращают валидированные схемы
    """
    
    def __init__(self, db_path: str = "/app/data/telemetry.db"):
        self.db_path = db_path
        self._init_db()
    
    @contextmanager
    def _get_connection(self):
        """Контекстный менеджер для соединения с БД"""
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        except Exception as e:
            conn.rollback()
            logger.exception(f"❌ Ошибка базы данных: {e}")
            raise
        finally:
            conn.close()
    
    def _init_db(self):
        """Инициализация таблицы, если её нет"""
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        
        with self._get_connection() as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS telemetry (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                    
                    -- Внутренние датчики (ESP)
                    temp_in REAL,
                    hum_in REAL,
                    
                    -- Уличные данные (погодное API)
                    temp_out REAL,
                    hum_out REAL,
                    
                    -- Метаданные
                    device_id TEXT DEFAULT 'greenhouse_01',
                    source TEXT DEFAULT 'esp',
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            """)
            
            conn.execute("CREATE INDEX IF NOT EXISTS idx_telemetry_timestamp ON telemetry(timestamp)")
            logger.info("✅ База данных инициализирована")
    
    # ==================== ВНУТРЕННИЕ МЕТОДЫ (работа с сырыми данными) ====================
    
    def _save_esp_reading_raw(self, temp: float, hum: float, device_id: str, dt: datetime) -> bool:
        """Сырое сохранение показаний ESP (синхронное, без валидации)"""
        try:
            with self._get_connection() as conn:
                conn.execute("""
                    INSERT INTO telemetry (timestamp, temp_in, hum_in, device_id, source)
                    VALUES (?, ?, ?, ?, 'esp')
                """, (dt.isoformat(), temp, hum, device_id))
                
                logger.debug(f"📊 Показания платы успешно сохранены: {temp}°C, {hum}%")
                return True
        except Exception as e:
            logger.exception(f"❌ Сохранение показаний платы не удалось: {e}")
            return False

    def _save_weather_reading_raw(self, temp: float, hum: float, dt: datetime) -> bool:
        """Сырое сохранение показаний погоды (синхронное, без валидации)"""
        try:
            with self._get_connection() as conn:
                conn.execute("""
                    INSERT INTO telemetry (timestamp, temp_out, hum_out, source)
                    VALUES (?, ?, ?, 'weather_api')
                """, (dt.isoformat(), temp, hum))
                
                logger.debug(f"📊 Показания погоды успешно сохранены: {temp}°C, {hum}%")
                return True
        except Exception as e:
            logger.exception(f"❌ Сохранение показаний погоды не удалось: {e}")
            return False
    
    def _get_history_raw(
        self, 
        hours: int,
        end_time: datetime,  # текущее время Ижевска
        device_id: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """Сырое получение истории (без заполнения пропусков, без валидации)"""
        with self._get_connection() as conn:
            query = """
                SELECT 
                    timestamp,
                    temp_in,
                    hum_in,
                    temp_out,
                    hum_out,
                    device_id
                FROM telemetry 
                WHERE timestamp >= ? AND timestamp <= ?  -- 👈 добавил верхнюю границу
            """
            
            start_time = end_time - timedelta(hours=hours)
            
            params = [start_time.isoformat(), end_time.isoformat()]
            
            if device_id:
                query += " AND device_id = ?"
                params.append(device_id)
            
            query += " ORDER BY timestamp ASC"
            
            cursor = conn.execute(query, params)
            return [dict(row) for row in cursor.fetchall()]
    
    def _get_stats_raw(self, hours: int = 24, device_id: Optional[str] = None) -> Dict[str, Any]:
        """Сырое получение статистики (без валидации)"""
        with self._get_connection() as conn:
            query = """
                SELECT 
                    COUNT(*) as total_records,
                    SUM(CASE WHEN temp_in IS NOT NULL THEN 1 ELSE 0 END) as esp_records,
                    SUM(CASE WHEN temp_out IS NOT NULL THEN 1 ELSE 0 END) as weather_records,
                    
                    AVG(temp_in) as avg_temp_in,
                    MIN(temp_in) as min_temp_in,
                    MAX(temp_in) as max_temp_in,
                    
                    AVG(hum_in) as avg_hum_in,
                    MIN(hum_in) as min_hum_in,
                    MAX(hum_in) as max_hum_in,
                    
                    AVG(temp_out) as avg_temp_out,
                    MIN(temp_out) as min_temp_out,
                    MAX(temp_out) as max_temp_out,

                    AVG(hum_out) as avg_hum_out,
                    MIN(hum_out) as min_hum_out,
                    MAX(hum_out) as max_hum_out
                    
                FROM telemetry 
                WHERE timestamp >= datetime('now', ?)
            """
            params = [f'-{hours} hours']
            
            if device_id:
                query += " AND device_id = ?"
                params.append(device_id)
            
            cursor = conn.execute(query, params)
            row = cursor.fetchone()
            return dict(row) if row else {}
    
    def _get_last_esp_raw(self, device_id: str) -> Optional[Dict]:
        """Сырое получение последнего показания ESP"""
        with self._get_connection() as conn:
            cursor = conn.execute("""
                SELECT timestamp, temp_in, hum_in
                FROM telemetry
                WHERE device_id = ? AND temp_in IS NOT NULL
                ORDER BY timestamp DESC
                LIMIT 1
            """, [device_id])
            
            row = cursor.fetchone()
            return dict(row) if row else None
    
    def _get_last_weather_raw(self) -> Optional[Dict]:
        """Сырое получение последнего показания погоды"""
        with self._get_connection() as conn:
            cursor = conn.execute("""
                SELECT timestamp, temp_out, hum_out
                FROM telemetry
                WHERE source = 'weather_api'
                ORDER BY timestamp DESC
                LIMIT 1
            """)
            
            row = cursor.fetchone()
            return dict(row) if row else None
    
    def _cleanup_old_raw(self, days: int) -> int:
        """Сырое удаление старых данных"""
        with self._get_connection() as conn:
            cursor = conn.execute("""
                DELETE FROM telemetry 
                WHERE timestamp < datetime('now', ?)
            """, [f'-{days} days'])
            
            deleted = cursor.rowcount
            logger.info(f"🧹 Удаление данных, удалено: {deleted} старых записей.")
            return deleted
    
    # ==================== ПУБЛИЧНЫЕ МЕТОДЫ (с валидацией через схемы) ====================
    
    async def save_esp_reading(self, temp: float, hum: float, timestamp: datetime, device_id: str = "greenhouse_01") -> bool:
        """
        Сохранить показания с ESP (внутренние датчики)
        Вызывается раз в 5-10 минут
        """
        logger.info(f"💾 Показания с платы сохранены в БД {timestamp.isoformat()}: {temp}°C, {hum}%")
        return self._save_esp_reading_raw(temp, hum, device_id, timestamp)

    async def save_weather_reading(self, temp: float, hum: float, timestamp: datetime) -> bool:
        """
        Сохранить показания с погодного API (уличные данные)
        Вызывается раз в час
        """
        logger.info(f"💾 Показания погоды сохранены в БД {timestamp.isoformat()}: {temp}°C, {hum}%")
        return self._save_weather_reading_raw(temp, hum, timestamp)
    
    async def get_history(
        self, 
        end_time: datetime,
        hours: int = 24,
        device_id: Optional[str] = None,
        max_points: int = 100  # максимум точек для графика
    ) -> List[TelemetryRecord]:
        """
        Получить историю за последние N часов.
        Берем данные за N+1 час для заполнения начала периода,
        агрегируем, потом отсекаем лишний час.
        Возвращает валидированные записи с заполненными пропусками.
        """
        logger.info(f"📖 Получение истории за последние {hours}h (макс {max_points} точек)")
        
        # 1️⃣ Берем на час больше для заполнения начала
        extended_hours = hours + 1
        raw_records = self._get_history_raw(
            hours=extended_hours,
            end_time=end_time,
            device_id=device_id
        )
        
        if not raw_records:
            logger.info("✅ Нет данных за указанный период")
            return []
        
        # 2️⃣ АГРЕГАЦИЯ: если данных слишком много
        if len(raw_records) > max_points:
            logger.info(f"📊 Сырых данных: {len(raw_records)}, агрегирую до {max_points}")
            
            # Размер чанка для группировки
            chunk_size = len(raw_records) // max_points
            if chunk_size == 0:
                chunk_size = 1
                
            aggregated = []
            last_temp_out = None
            last_hum_out = None
            
            for i in range(0, len(raw_records), chunk_size):
                chunk = raw_records[i:i+chunk_size]
                
                # Собираем значения для усреднения
                temp_in_vals = [r['temp_in'] for r in chunk if r.get('temp_in') is not None]
                hum_in_vals = [r['hum_in'] for r in chunk if r.get('hum_in') is not None]
                
                # Для внешних данных берем последнее не-null значение в чанке
                chunk_temp_out = None
                chunk_hum_out = None
                for r in chunk:
                    if r.get('temp_out') is not None:
                        chunk_temp_out = r['temp_out']
                    if r.get('hum_out') is not None:
                        chunk_hum_out = r['hum_out']
                
                # Обновляем last значения (для заполнения пропусков)
                if chunk_temp_out is not None:
                    last_temp_out = chunk_temp_out
                if chunk_hum_out is not None:
                    last_hum_out = chunk_hum_out
                
                # Создаем агрегированную запись
                agg_record = {
                    'timestamp': chunk[0]['timestamp'],
                    'temp_in': sum(temp_in_vals)/len(temp_in_vals) if temp_in_vals else None,
                    'hum_in': sum(hum_in_vals)/len(hum_in_vals) if hum_in_vals else None,
                    'temp_out': last_temp_out,
                    'hum_out': last_hum_out,
                    'device_id': chunk[0].get('device_id', 'unknown')
                }
                aggregated.append(agg_record)
            
            raw_records = aggregated
            logger.info(f"📊 После агрегации: {len(raw_records)} точек")
        
        # 3️⃣ Отсекаем лишний час
        cutoff_time = (end_time - timedelta(hours=hours)).isoformat()
        raw_records = [r for r in raw_records if r['timestamp'] >= cutoff_time]
        
        # 4️⃣ Заполняем пропуски и валидируем
        result = []
        last_temp_out = None
        last_hum_out = None
        
        for raw in raw_records:
            # Заполняем пропуски уличных данных последним известным значением
            if raw.get('temp_out') is not None:
                last_temp_out = raw['temp_out']
            if raw.get('hum_out') is not None:
                last_hum_out = raw['hum_out']
            
            try:
                record = TelemetryRecord(
                    timestamp=raw['timestamp'],
                    temp_in=raw.get('temp_in'),
                    hum_in=raw.get('hum_in'),
                    temp_out=last_temp_out,
                    hum_out=last_hum_out,
                    device_id=raw.get('device_id', 'unknown')
                )
                result.append(record)
            except Exception as e:
                logger.exception(f"❌ Не удалось создать запись за {raw.get('timestamp')}: {e}")
                continue
        
        logger.info(f"✅ История: {len(result)} точек за {hours}ч готово к отправке")
        return result
    
    async def get_stats(self, hours: int = 24, device_id: Optional[str] = None) -> StatsResponse:
        """
        Получить статистику за период.
        Возвращает валидированную статистику.
        """
        logger.info(f"📊 Получение статистики за последние {hours}h")
        
        # Получаем сырые данные
        raw_stats = self._get_stats_raw(hours, device_id)
        
        try:
            # Валидируем через промежуточную схему
            validated_raw = RawStats(**raw_stats)
            
            # Формируем ответ
            stats = StatsResponse(
                period_hours=hours,
                total_records=validated_raw.total_records,
                esp_records=validated_raw.esp_records,
                weather_records=validated_raw.weather_records,
                avg_temp_in=validated_raw.avg_temp_in,
                min_temp_in=validated_raw.min_temp_in,
                max_temp_in=validated_raw.max_temp_in,
                avg_hum_in=validated_raw.avg_hum_in,
                min_hum_in=validated_raw.min_hum_in,
                max_hum_in=validated_raw.max_hum_in,
                avg_temp_out=validated_raw.avg_temp_out,
                min_temp_out=validated_raw.min_temp_out,
                max_temp_out=validated_raw.max_temp_out,
                avg_hum_out=validated_raw.avg_hum_out,
                min_hum_out=validated_raw.min_hum_out,
                max_hum_out=validated_raw.max_hum_out
            )
            
            logger.info(f"✅ Статистика получена: {stats.total_records} записей, "
                       f"Средняя температура: {stats.avg_temp_in}°C")
            return stats
            
        except Exception as e:
            logger.error(f"❌ Не удалось получить статистику: {e}, raw: {raw_stats}")
            # Возвращаем пустую, но валидную статистику
            return StatsResponse(
                period_hours=hours,
                total_records=raw_stats.get('total_records', 0),
                esp_records=raw_stats.get('esp_records', 0),
                weather_records=raw_stats.get('weather_records', 0)
            )
        
    async def get_week_stats(
    self,
    now: datetime,
    device_id: Optional[str] = None
) -> Dict[str, Any]:
        """
        Получить статистику за последние 7 календарных дней.
        Неделя заканчивается ВЧЕРА (последний завершённый день).
        """
        
        # Последний завершённый день = вчера
        end_date = (now - timedelta(days=1)).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        
        # Начало недели (6 дней назад от end_date)
        start_date = end_date - timedelta(days=6)
        start_date = start_date.replace(hour=0, minute=0, second=0, microsecond=0)
        
        # Конец последнего дня (вчера 23:59:59)
        end_datetime = end_date.replace(hour=23, minute=59, second=59, microsecond=999999)
        
        logger.info(f"📆 Статистика за неделю: {start_date.date()} - {end_date.date()}")
        
        with self._get_connection() as conn:
            # 1️⃣ Общая статистика за неделю
            query_total = """
                SELECT 
                    COUNT(*) as total_records,
                    SUM(CASE WHEN temp_in IS NOT NULL THEN 1 ELSE 0 END) as esp_records,
                    SUM(CASE WHEN temp_out IS NOT NULL THEN 1 ELSE 0 END) as weather_records,
                    
                    AVG(temp_in) as avg_temp_in,
                    MIN(temp_in) as min_temp_in,
                    MAX(temp_in) as max_temp_in,
                    
                    AVG(hum_in) as avg_hum_in,
                    MIN(hum_in) as min_hum_in,
                    MAX(hum_in) as max_hum_in,
                    
                    AVG(temp_out) as avg_temp_out,
                    MIN(temp_out) as min_temp_out,
                    MAX(temp_out) as max_temp_out,
                    
                    AVG(hum_out) as avg_hum_out,
                    MIN(hum_out) as min_hum_out,
                    MAX(hum_out) as max_hum_out
                    
                FROM telemetry 
                WHERE timestamp >= ? AND timestamp <= ?
            """
            
            params = [start_date.isoformat(), end_datetime.isoformat()]
            
            if device_id:
                query_total += " AND device_id = ?"
                params.append(device_id)
            
            cursor = conn.execute(query_total, params)
            total_row = cursor.fetchone()
            
            if not total_row or total_row["total_records"] == 0:
                return None
            
            # 2️⃣ Статистика по дням (для тренда)
            query_daily = """
                SELECT 
                    date(timestamp) as day,
                    AVG(temp_in) as avg_temp_in,
                    MIN(temp_in) as min_temp_in,
                    MAX(temp_in) as max_temp_in,
                    AVG(hum_in) as avg_hum_in,
                    AVG(temp_out) as avg_temp_out
                FROM telemetry 
                WHERE timestamp >= ? AND timestamp <= ?
            """
            
            daily_params = [start_date.isoformat(), end_datetime.isoformat()]
            
            if device_id:
                query_daily += " AND device_id = ?"
                daily_params.append(device_id)
            
            query_daily += " GROUP BY date(timestamp) ORDER BY day"
            
            cursor = conn.execute(query_daily, daily_params)
            daily_rows = cursor.fetchall()
            
            # Превращаем общую статистику в словарь
            total = dict(total_row)
            
            # Собираем данные по дням
            daily_stats = []
            for row in daily_rows:
                daily_stats.append({
                    "date": row["day"],
                    "temp_avg": round(row["avg_temp_in"], 1) if row["avg_temp_in"] else None,
                    "temp_min": round(row["min_temp_in"], 1) if row["min_temp_in"] else None,
                    "temp_max": round(row["max_temp_in"], 1) if row["max_temp_in"] else None,
                    "hum_avg": round(row["avg_hum_in"]) if row["avg_hum_in"] else None,
                    "outside_temp": round(row["avg_temp_out"], 1) if row["avg_temp_out"] else None
                })
            
            # Вычисляем тренд (сравнение первой и последней половины недели)
            mid_point = len(daily_stats) // 2
            if len(daily_stats) >= 4:
                first_half = [d["temp_avg"] for d in daily_stats[:mid_point] if d["temp_avg"]]
                second_half = [d["temp_avg"] for d in daily_stats[mid_point:] if d["temp_avg"]]
                
                if first_half and second_half:
                    first_avg = sum(first_half) / len(first_half)
                    second_avg = sum(second_half) / len(second_half)
                    trend = round(second_avg - first_avg, 1)
                else:
                    trend = None
            else:
                trend = None
            
            return {
                "period": {
                    "start": start_date.date().isoformat(),
                    "end": end_date.date().isoformat(),
                    "days": len(daily_stats)
                },
                "summary": {
                    "temperature": {
                        "inside": {
                            "avg": round(total["avg_temp_in"], 1) if total["avg_temp_in"] else None,
                            "min": round(total["min_temp_in"], 1) if total["min_temp_in"] else None,
                            "max": round(total["max_temp_in"], 1) if total["max_temp_in"] else None,
                        },
                        "outside": {
                            "avg": round(total["avg_temp_out"], 1) if total["avg_temp_out"] else None,
                            "min": round(total["min_temp_out"], 1) if total["min_temp_out"] else None,
                            "max": round(total["max_temp_out"], 1) if total["max_temp_out"] else None,
                        }
                    },
                    "humidity": {
                        "inside": {
                            "avg": round(total["avg_hum_in"]) if total["avg_hum_in"] else None,
                            "min": round(total["min_hum_in"]) if total["min_hum_in"] else None,
                            "max": round(total["max_hum_in"]) if total["max_hum_in"] else None,
                        },
                        "outside": {
                            "avg": round(total["avg_hum_out"]) if total["avg_hum_out"] else None,
                            "min": round(total["min_hum_out"]) if total["min_hum_out"] else None,
                            "max": round(total["max_hum_out"]) if total["max_hum_out"] else None,
                        }
                    },
                    "records": {
                        "total": total["total_records"],
                        "esp": total["esp_records"],
                        "weather": total["weather_records"]
                    },
                    "trend": trend  # изменение температуры за неделю (+1.2 / -0.5 / None)
                },
                "daily": daily_stats  # данные по дням для детального анализа
            }
        
    async def get_week_records(
    self,
    now: datetime,
    device_id: Optional[str] = None,
    max_points: int = 100
) -> Dict[str, Any]:
        """
        Получить записи за последние 7 дней с агрегацией.
        Возвращает словарь с записями по дням (внутри + снаружи).
        """
        
        end_date = (now - timedelta(days=1)).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        start_date = end_date - timedelta(days=6)
        start_date = start_date.replace(hour=0, minute=0, second=0, microsecond=0)
        end_datetime = end_date.replace(hour=23, minute=59, second=59, microsecond=999999)
        
        logger.info(f"📆 Получение записей за неделю: {start_date.date()} - {end_date.date()}")
        
        with self._get_connection() as conn:
            query = """
                SELECT 
                    timestamp,
                    temp_in,
                    hum_in,
                    temp_out,
                    hum_out
                FROM telemetry 
                WHERE timestamp >= ? AND timestamp <= ?
            """
            
            params = [start_date.isoformat(), end_datetime.isoformat()]
            
            if device_id:
                query += " AND device_id = ?"
                params.append(device_id)
            
            query += " ORDER BY timestamp ASC"
            
            cursor = conn.execute(query, params)
            all_records = [dict(row) for row in cursor.fetchall()]
        
        if not all_records:
            return {"days": []}
        
        # Группируем по дням
        from collections import defaultdict
        days = defaultdict(list)
        
        for r in all_records:
            day = r['timestamp'][:10]
            days[day].append(r)
        
        result = []
        points_per_day = max_points // len(days)
        
        for day, records in sorted(days.items()):
            if len(records) <= points_per_day:
                day_records = self._format_records_for_ai(records)
            else:
                chunk_size = len(records) // points_per_day
                aggregated = []
                
                for i in range(0, len(records), chunk_size):
                    chunk = records[i:i+chunk_size]
                    
                    temp_in_vals = [r['temp_in'] for r in chunk if r.get('temp_in')]
                    hum_in_vals = [r['hum_in'] for r in chunk if r.get('hum_in')]
                    temp_out_vals = [r['temp_out'] for r in chunk if r.get('temp_out')]
                    hum_out_vals = [r['hum_out'] for r in chunk if r.get('hum_out')]
                    
                    mid_idx = len(chunk) // 2
                    
                    entry = {
                        'time': chunk[mid_idx]['timestamp'][11:16],
                    }
                    if temp_in_vals:
                        entry['temp_in'] = round(sum(temp_in_vals)/len(temp_in_vals), 1)
                    if hum_in_vals:
                        entry['hum_in'] = round(sum(hum_in_vals)/len(hum_in_vals))
                    if temp_out_vals:
                        entry['temp_out'] = round(sum(temp_out_vals)/len(temp_out_vals), 1)
                    if hum_out_vals:
                        entry['hum_out'] = round(sum(hum_out_vals)/len(hum_out_vals))
                    
                    aggregated.append(entry)
                
                day_records = aggregated
            
            result.append({
                'date': day,
                'records': day_records,
                'count': len(records)
            })
        
        return {
            'period': {
                'start': start_date.date().isoformat(),
                'end': end_date.date().isoformat(),
                'days': len(result)
            },
            'days': result
        }

    async def get_yesterday_stats(
        self,
        now: datetime,
        device_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Получить статистику за вчерашние сутки (00:00 - 23:59).
        Возвращает словарь с цифрами для ИИ.
        """
        # Начало вчерашнего дня
        yesterday_start = (now - timedelta(days=1)).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        # Конец вчерашнего дня
        yesterday_end = yesterday_start.replace(
            hour=23, minute=59, second=59, microsecond=999999
        )
        
        logger.info(f"📅 Статистика за вчера: {yesterday_start.date()}")
        
        with self._get_connection() as conn:
            query = """
                SELECT 
                    COUNT(*) as total_records,
                    SUM(CASE WHEN temp_in IS NOT NULL THEN 1 ELSE 0 END) as esp_records,
                    SUM(CASE WHEN temp_out IS NOT NULL THEN 1 ELSE 0 END) as weather_records,
                    
                    AVG(temp_in) as avg_temp_in,
                    MIN(temp_in) as min_temp_in,
                    MAX(temp_in) as max_temp_in,
                    
                    AVG(hum_in) as avg_hum_in,
                    MIN(hum_in) as min_hum_in,
                    MAX(hum_in) as max_hum_in,
                    
                    AVG(temp_out) as avg_temp_out,
                    MIN(temp_out) as min_temp_out,
                    MAX(temp_out) as max_temp_out,
                    
                    AVG(hum_out) as avg_hum_out,
                    MIN(hum_out) as min_hum_out,
                    MAX(hum_out) as max_hum_out
                    
                FROM telemetry 
                WHERE timestamp >= ? AND timestamp <= ?
            """
            
            params = [yesterday_start.isoformat(), yesterday_end.isoformat()]
            
            if device_id:
                query += " AND device_id = ?"
                params.append(device_id)
            
            cursor = conn.execute(query, params)
            row = cursor.fetchone()
            
            if not row:
                return None
            
            # Превращаем sqlite3.Row в обычный словарь
            data = dict(row)
            
            # Добавляем понятные названия и округления
            return {
                "date": yesterday_start.date().isoformat(),
                "temperature": {
                    "inside": {
                        "avg": round(data["avg_temp_in"], 1) if data["avg_temp_in"] else None,
                        "min": round(data["min_temp_in"], 1) if data["min_temp_in"] else None,
                        "max": round(data["max_temp_in"], 1) if data["max_temp_in"] else None,
                    },
                    "outside": {
                        "avg": round(data["avg_temp_out"], 1) if data["avg_temp_out"] else None,
                        "min": round(data["min_temp_out"], 1) if data["min_temp_out"] else None,
                        "max": round(data["max_temp_out"], 1) if data["max_temp_out"] else None,
                    }
                },
                "humidity": {
                    "inside": {
                        "avg": round(data["avg_hum_in"]) if data["avg_hum_in"] else None,
                        "min": round(data["min_hum_in"]) if data["min_hum_in"] else None,
                        "max": round(data["max_hum_in"]) if data["max_hum_in"] else None,
                    },
                    "outside": {
                        "avg": round(data["avg_hum_out"]) if data["avg_hum_out"] else None,
                        "min": round(data["min_hum_out"]) if data["min_hum_out"] else None,
                        "max": round(data["max_hum_out"]) if data["max_hum_out"] else None,
                    }
                },
                "records": {
                    "total": data["total_records"],
                    "esp": data["esp_records"],
                    "weather": data["weather_records"]
                }
            }
    
    async def get_yesterday_records(
    self,
    now: datetime,
    device_id: Optional[str] = None,
    max_points: int = 50
) -> List[Dict[str, Any]]:
        """
        Получить записи за вчерашние сутки с агрегацией.
        Возвращает список записей (температура/влажность внутри + снаружи).
        """
        
        day_start = (now - timedelta(days=1)).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        day_end = day_start.replace(hour=23, minute=59, second=59, microsecond=999999)
        
        logger.info(f"📅 Получение записей за {day_start.date()}")
        
        with self._get_connection() as conn:
            query = """
                SELECT 
                    timestamp,
                    temp_in,
                    hum_in,
                    temp_out,
                    hum_out
                FROM telemetry 
                WHERE timestamp >= ? AND timestamp <= ?
            """
            
            params = [day_start.isoformat(), day_end.isoformat()]
            
            if device_id:
                query += " AND device_id = ?"
                params.append(device_id)
            
            query += " ORDER BY timestamp ASC"
            
            cursor = conn.execute(query, params)
            raw_records = [dict(row) for row in cursor.fetchall()]
        
        if not raw_records:
            return []
        
        if len(raw_records) <= max_points:
            return self._format_records_for_ai(raw_records)
        
        # Агрегация
        chunk_size = len(raw_records) // max_points
        aggregated = []
        
        for i in range(0, len(raw_records), chunk_size):
            chunk = raw_records[i:i+chunk_size]
            
            # Внутри
            temp_in_vals = [r['temp_in'] for r in chunk if r.get('temp_in')]
            hum_in_vals = [r['hum_in'] for r in chunk if r.get('hum_in')]
            
            # Снаружи
            temp_out_vals = [r['temp_out'] for r in chunk if r.get('temp_out')]
            hum_out_vals = [r['hum_out'] for r in chunk if r.get('hum_out')]
            
            mid_idx = len(chunk) // 2
            timestamp = chunk[mid_idx]['timestamp']
            
            aggregated.append({
                'timestamp': timestamp,
                'temp_in': round(sum(temp_in_vals)/len(temp_in_vals), 1) if temp_in_vals else None,
                'hum_in': round(sum(hum_in_vals)/len(hum_in_vals)) if hum_in_vals else None,
                'temp_out': round(sum(temp_out_vals)/len(temp_out_vals), 1) if temp_out_vals else None,
                'hum_out': round(sum(hum_out_vals)/len(hum_out_vals)) if hum_out_vals else None,
            })
        
        return self._format_records_for_ai(aggregated)

    def _format_records_for_ai(self, records: List[Dict]) -> List[Dict[str, Any]]:
        """Привести записи к формату для ИИ"""
        result = []
        for r in records:
            entry = {
                'time': r['timestamp'][11:16] if 'timestamp' in r else None,
            }
            if r.get('temp_in'):
                entry['temp_in'] = r['temp_in']
            if r.get('hum_in'):
                entry['hum_in'] = r['hum_in']
            if r.get('temp_out'):
                entry['temp_out'] = r['temp_out']
            if r.get('hum_out'):
                entry['hum_out'] = r['hum_out']
            
            result.append(entry)
        
        return result

    async def cleanup_old_data(self, days: int = 30) -> int:
        """
        Удалить данные старше N дней.
        Возвращает количество удалённых записей.
        """
        logger.info(f"🧹 Cleaning up data older than {days} days")
        deleted = self._cleanup_old_raw(days)
        logger.info(f"✅ Cleanup complete: {deleted} records deleted")
        return deleted


# Синглтон
_telemetry_storage: Optional[TelemetryStorage] = None

def get_telemetry_storage() -> TelemetryStorage:
    """Получить или создать экземпляр хранилища"""
    global _telemetry_storage
    if _telemetry_storage is None:
        _telemetry_storage = TelemetryStorage()
    return _telemetry_storage