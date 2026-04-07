import aiobotocore.session
from botocore.config import Config
from botocore.exceptions import ClientError
from typing import Optional
from urllib.parse import quote
import asyncio
import os
from datetime import datetime, timezone
import uuid
import subprocess
import json
from logger import logger
import uuid

class S3Manager:
    def __init__(self, endpoint_url: str, access_key: str, secret_key: str, bucket_name: str, region: str = "us-east-1"):
        self.endpoint_url = endpoint_url
        self.access_key = access_key
        self.secret_key = secret_key
        self.bucket_name = bucket_name
        self.region = region
        self._client = None
        self._context = None
        self._is_connected = False
        
    async def _get_video_duration(self, key: str) -> Optional[int]:
        """Получить длительность видео с помощью ffprobe"""
        try:
            # Скачиваем видео во временный файл
            temp_path = f"/tmp/{uuid.uuid4().hex}.mp4"
            response = await self._client.get_object(Bucket=self.bucket_name, Key=key)
            video_data = await response['Body'].read()
            
            with open(temp_path, 'wb') as f:
                f.write(video_data)
            
            # Используем ffprobe для получения длительности
            result = subprocess.run([
                'ffprobe', '-v', 'quiet', '-print_format', 'json', '-show_format', temp_path
            ], capture_output=True, text=True, timeout=30)
            
            if result.returncode == 0:
                data = json.loads(result.stdout)
                duration = float(data['format']['duration'])
                os.remove(temp_path)
                return int(duration)
            else:
                logger.info(f"ffprobe failed for {key}: {result.stderr}")
                os.remove(temp_path)
                return None
        except subprocess.TimeoutExpired:
            logger.info(f"ffprobe timeout for {key}")
            if os.path.exists(temp_path):
                os.remove(temp_path)
            return None
        except Exception as e:
            logger.info(f"Failed to get duration for {key}: {e}")
            if os.path.exists(temp_path):
                os.remove(temp_path)
            return None

    async def connect(self, max_retries: int = 5, retry_delay: int = 5, init_delay: int = 10):
        """Устанавливает соединение с Garage"""
        if init_delay > 0:
            logger.info(f"⏳ Даем Garage время на инициализацию ({init_delay} сек)...")
            await asyncio.sleep(init_delay)
        
        current_delay = retry_delay
        
        for attempt in range(max_retries):
            try:
                logger.info(f"🔌 Подключение к Garage (попытка {attempt + 1}/{max_retries})...")
                
                session = aiobotocore.session.get_session()
                
                self._context = session.create_client(
                    's3',
                    endpoint_url=self.endpoint_url,
                    aws_access_key_id=self.access_key,
                    aws_secret_access_key=self.secret_key,
                    region_name=self.region,
                    use_ssl=False,
                    verify=False,
                    config=Config(
                        s3={'addressing_style': 'path'},
                        retries={'max_attempts': 3, 'mode': 'standard'}
                    )
                )
                
                # Входим в контекст и получаем клиента
                self._client = await self._context.__aenter__()
                
                # Проверяем, что Garage отвечает и bucket доступен
                await self._client.head_bucket(Bucket=self.bucket_name)
                
                self._is_connected = True
                logger.info(f"✅ Подключен к Garage (bucket: {self.bucket_name})")
                return True
                
            except Exception as e:
                logger.error(f"❌ Ошибка подключения: {e}")
                
                # Закрываем контекст при ошибке
                if self._context:
                    try:
                        await self._context.__aexit__(None, None, None)
                    except Exception:
                        pass
                    self._client = None
                    self._context = None
                
                self._is_connected = False
                
                if attempt < max_retries - 1:
                    logger.info(f"🔄 Повтор через {current_delay} сек...")
                    await asyncio.sleep(current_delay)
                    current_delay *= 2
        
        logger.error(f"❌ Не удалось подключиться к Garage после {max_retries} попыток")
        return False

    async def disconnect(self):
        """Корректное отключение"""
        if self._context:
            try:
                await self._context.__aexit__(None, None, None)
            except Exception as e:
                logger.warning(f"Ошибка при закрытии клиента: {e}")
        self._client = None
        self._context = None
        self._is_connected = False
        logger.info("✅ Garage соединение закрыто")
    
    @property
    def client(self):
        """Доступ к boto3 клиенту для совместимости"""
        return self._client
    
    async def _ensure_connection(self) -> bool:
        """Проверка и переподключение"""
        if self._client and self._is_connected:
            return True
        
        logger.warning("⚠️ Соединение с Garage потеряно, переподключаемся...")
        
        # Закрываем старый клиент
        if self._client:
            try:
                await self._client.__aexit__(None, None, None)
            except:
                pass
            self._client = None
            self._context = None
        
        # Создаём новое соединение
        success = await self.connect(max_retries=3, retry_delay=2, init_delay=0)
        
        if success:
            logger.info("✅ Соединение с Garage восстановлено")
        else:
            logger.error("❌ Не удалось восстановить соединение")
        
        return success
    
    def _generate_key(self, camera_id: str, start_time: datetime) -> str:
        """Генерирует ключ для видео"""
        return f"videos/{camera_id}/{start_time.strftime('%Y/%m/%d')}/{start_time.strftime('%H-%M-%S')}_{uuid.uuid4().hex[:8]}.mp4"
    
    @staticmethod
    def _sanitize_metadata(metadata: dict) -> dict:
        """Санитизация метаданных для S3"""
        result = {}
        for k, v in metadata.items():
            safe_key = str(k).lower().replace(' ', '-')
            safe_value = quote(str(v), safe='')
            result[safe_key] = safe_value
        return result
    
    @staticmethod
    def _make_aware(dt: Optional[datetime]) -> Optional[datetime]:
        """Приводит naive datetime к UTC-aware"""
        if dt is None:
            return None
        if dt.tzinfo is None:
            return dt.replace(tzinfo=timezone.utc)
        return dt
    
    async def list_videos(
        self, 
        camera_id: Optional[str] = None
    ) -> list:
        """Получает список видео из S3"""
        if not await self._ensure_connection():
            return []
        
        try:
            prefix = "videos/"
            if camera_id:
                prefix += f"{camera_id}/"
            
            objects = []
            paginator = self._client.get_paginator('list_objects_v2')
            
            async for page in paginator.paginate(
                Bucket=self.bucket_name,
                Prefix=prefix
            ):
                if 'Contents' not in page:
                    continue

                for obj in page['Contents']:
                    key = obj['Key']
                    last_modified = obj['LastModified']
                    
                    # Извлекаем camera_id из ключа
                    parts = key.split('/')
                    camera_id_from_key = parts[1] if len(parts) > 1 else 'unknown'
                    
                    # Получаем метаданные через head_object
                    metadata = {}
                    duration_seconds = None
                    start_time = None
                    video_id = None
                    
                    try:
                        head = await self._client.head_object(
                            Bucket=self.bucket_name, 
                            Key=key
                        )
                        metadata = head.get('Metadata', {}) or {}
                        
                        # Получаем video_id из метаданных
                        if 'video-id' in metadata:
                            video_id = metadata['video-id']
                        else:
                            # Если video_id нет в метаданных, пытаемся извлечь из имени файла
                            # Имя файла: {uuid}.mp4
                            filename = os.path.basename(key)
                            if filename.endswith('.mp4'):
                                potential_uuid = filename[:-4]  # Убираем .mp4
                                # Проверяем, похоже ли на UUID
                                if len(potential_uuid) == 36 and potential_uuid.count('-') == 4:
                                    video_id = potential_uuid
                        
                        # Получаем duration
                        if 'duration' in metadata:
                            try:
                                duration_seconds = int(metadata['duration'])
                            except (ValueError, TypeError):
                                pass
                        
                        # Получаем start_time из метаданных
                        if 'start-time' in metadata:
                            try:
                                start_time = datetime.fromisoformat(metadata['start-time'])
                            except (ValueError, TypeError):
                                pass
                        
                    except Exception as e:
                        logger.debug(f"Failed head_object for {key}: {e}")
                    
                    # Формируем thumbnail URL используя video_id
                    thumbnail_url = None
                    if video_id and camera_id_from_key:
                        # Проверяем существует ли thumbnail
                        thumb_key = f"thumbnails/{camera_id_from_key}/{video_id}.jpg"
                        try:
                            await self._client.head_object(
                                Bucket=self.bucket_name, 
                                Key=thumb_key
                            )
                            # Thumbnail существует, формируем URL с video_id
                            thumbnail_url = f"/esp_service/videos/thumbnail?camera_id={camera_id_from_key}&video_id={video_id}"
                        except Exception as e:
                            # Thumbnail не найден
                            logger.warning(f"❌ Thumbnail not found for video {video_id}: {e}")
                            pass
                    
                    objects.append({
                        'key': key,
                        'video_id': video_id,  # Добавляем video_id в ответ
                        'size_bytes': obj['Size'],
                        'last_modified': last_modified,
                        'camera_id': camera_id or camera_id_from_key,
                        'duration_seconds': duration_seconds,
                        'start_time': start_time.isoformat() if start_time else None,  # Возвращаем ISO строку
                        'thumbnail_url': thumbnail_url,
                    })
            
            logger.info(f"📋 Найдено видео: {len(objects)}")
            return objects
            
        except Exception as e:
            logger.exception(f"❌ Ошибка получения списка видео: {e}")
            return []

    async def save_video(self, camera_id: str, video_data: bytes, start_time: datetime, duration_seconds: int, metadata: dict = None) -> Optional[str]:
        """Сохраняет видео с уникальным ID"""
        if not await self._ensure_connection():
            return None
        
        try:
            # Генерируем уникальный ID для видео
            video_id = str(uuid.uuid4())
            
            # Для организации по папкам используем даты
            year = start_time.strftime("%Y")
            month = start_time.strftime("%m")
            day = start_time.strftime("%d")
            
            # Ключ: videos/{camera_id}/{год}/{месяц}/{день}/{uuid}.mp4
            key = f"videos/{camera_id}/{year}/{month}/{day}/{video_id}.mp4"
            
            # Метаданные содержат локальное время для отображения
            s3_metadata = {
                'camera-id': camera_id,
                'video-id': video_id,  # Сохраняем ID в метаданных
                'start-time': start_time.isoformat(),  # Локальное время как есть
                'duration': str(duration_seconds),
                'file-size': str(len(video_data))
            }
            
            if metadata:
                s3_metadata.update(self._sanitize_metadata(metadata))
            
            await self._client.put_object(
                Bucket=self.bucket_name,
                Key=key,
                Body=video_data,
                ContentType='video/mp4',
                Metadata=s3_metadata
            )
            
            logger.info(f"💾 Видео сохранено: {key} (ID: {video_id})")
            return video_id  # Возвращаем ID, а не ключ
            
        except Exception as e:
            logger.exception(f"❌ Ошибка сохранения: {e}")
            return None
    
    async def save_thumbnail(self, camera_id: str, video_id: str, thumbnail_data: bytes):
        """Сохранить thumbnail по UUID видео"""
        if not await self._ensure_connection():
            logger.error("❌ S3 connection failed for thumbnail")
            return  # Лучше вернуть None, чем бросать исключение
        
        try:
            thumb_key = f"thumbnails/{camera_id}/{video_id}.jpg"
            await self._client.put_object(  # 🔧 _client, не client
                Bucket=self.bucket_name,
                Key=thumb_key,
                Body=thumbnail_data,
                ContentType="image/jpeg",
                Metadata={
                    "camera": camera_id,
                    "video_id": video_id,
                    "type": "thumbnail"
                }
            )
            logger.debug(f"🖼️ [{camera_id}] Thumbnail saved: {thumb_key}")
        except Exception as e:
            logger.error(f"❌ Failed to save thumbnail: {e}")

    async def get_video(self, key: str) -> Optional[bytes]:
        """Получает видео"""
        if not await self._ensure_connection():
            return None
        
        try:
            response = await self._client.get_object(
                Bucket=self.bucket_name,
                Key=key
            )
            video_data = await response['Body'].read()
            logger.info(f"📥 Видео загружено: {key} ({len(video_data)} байт)")
            return video_data
            
        except ClientError as e:
            if e.response['Error']['Code'] == 'NoSuchKey':
                logger.warning(f"Видео не найдено: {key}")
            else:
                logger.exception(f"❌ Ошибка: {e}")
            return None
        except Exception as e:
            logger.exception(f"❌ Ошибка: {e}")
            return None
    
    async def get_thumbnail(self, camera_id: str, video_id: str) -> Optional[bytes]:
        """Получить thumbnail по camera_id и video_id"""
        if not await self._ensure_connection():
            return None
        
        try:
            thumb_key = f"thumbnails/{camera_id}/{video_id}.jpg"
            
            response = await self._client.get_object(
                Bucket=self.bucket_name,
                Key=thumb_key
            )
            
            async with response['Body'] as stream:
                thumbnail_data = await stream.read()
                logger.debug(f"✅ Thumbnail found: {thumb_key}")
                return thumbnail_data
                
        except ClientError as e:
            if e.response['Error']['Code'] == 'NoSuchKey':
                logger.debug(f"Thumbnail not found: {thumb_key}")
            else:
                logger.error(f"Error getting thumbnail: {e}")
            return None
        except Exception as e:
            logger.error(f"Failed to get thumbnail: {e}")
            return None

    async def delete_video(self, key: str) -> bool:
        """Удаляет видео"""
        if not await self._ensure_connection():
            return False
        
        try:
            await self._client.delete_object(
                Bucket=self.bucket_name,
                Key=key
            )
            logger.info(f"🗑️ Видео удалено: {key}")
            return True
        except Exception as e:
            logger.exception(f"❌ Ошибка удаления: {e}")
            return False