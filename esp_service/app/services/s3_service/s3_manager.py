import aiobotocore.session
from botocore.config import Config
from botocore.exceptions import ClientError
from botocore.signers import CloudFrontSigner
from typing import Optional
from urllib.parse import quote, urlencode
import asyncio
import os
from datetime import datetime, timezone, timedelta
import uuid
import subprocess
import json
from logger import logger
import tempfile
import shutil


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
        self._connection_lock = asyncio.Lock()
        
        # Проверяем наличие ffprobe при инициализации
        if not shutil.which('ffprobe'):
            logger.warning("⚠️ ffprobe not found in PATH, video duration detection will not work")
    
    async def _get_video_duration(self, key: str) -> Optional[int]:
        """Получить длительность видео с помощью ffprobe"""
        temp_path = None
        try:
            # Скачиваем видео во временный файл
            temp_path = os.path.join(tempfile.gettempdir(), f"{uuid.uuid4().hex}.mp4")
            response = await self._client.get_object(Bucket=self.bucket_name, Key=key)
            
            # Потоковая запись для экономии памяти
            import aiofiles
            async with aiofiles.open(temp_path, 'wb') as f:
                async for chunk in response['Body'].iter_chunks():
                    await f.write(chunk[0])  # chunk is tuple (data, ...)
            
            # Используем ffprobe для получения длительности
            result = subprocess.run([
                'ffprobe', '-v', 'quiet', '-print_format', 'json', '-show_format', temp_path
            ], capture_output=True, text=True, timeout=30)
            
            if result.returncode == 0:
                data = json.loads(result.stdout)
                duration = float(data['format']['duration'])
                return int(duration)
            else:
                logger.info(f"ffprobe failed for {key}: {result.stderr}")
                return None
                
        except subprocess.TimeoutExpired:
            logger.info(f"ffprobe timeout for {key}")
            return None
        except Exception as e:
            logger.info(f"Failed to get duration for {key}: {e}")
            return None
        finally:
            if temp_path and os.path.exists(temp_path):
                try:
                    os.remove(temp_path)
                except Exception:
                    pass

    async def connect(self, max_retries: int = 5, retry_delay: int = 5, init_delay: int = 10):
        """Устанавливает соединение с S3"""
        if init_delay > 0:
            logger.info(f"⏳ Даем S3 время на инициализацию ({init_delay} сек)...")
            await asyncio.sleep(init_delay)
        
        current_delay = retry_delay
        
        for attempt in range(max_retries):
            try:
                logger.info(f"🔌 Подключение к S3 (попытка {attempt + 1}/{max_retries})...")
                
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
                        retries={'max_attempts': 3, 'mode': 'standard'},
                        signature_version='s3v4'  # Важно для presigned URLs
                    )
                )
                
                # Входим в контекст и получаем клиента
                self._client = await self._context.__aenter__()
                
                # Проверяем, что S3 отвечает и bucket доступен
                await self._client.head_bucket(Bucket=self.bucket_name)
                
                self._is_connected = True
                logger.info(f"✅ Подключен к S3 (bucket: {self.bucket_name})")
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
        
        logger.error(f"❌ Не удалось подключиться к S3 после {max_retries} попыток")
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
        logger.info("✅ S3 соединение закрыто")
    
    @property
    def client(self):
        """Доступ к boto3 клиенту для совместимости"""
        return self._client
    
    async def _ensure_connection(self) -> bool:
        """Проверка и переподключение с блокировкой"""
        async with self._connection_lock:
            if self._client and self._is_connected:
                return True
            
            logger.warning("⚠️ Соединение с S3 потеряно, переподключаемся...")
            
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
                logger.info("✅ Соединение с S3 восстановлено")
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
        token: str,
        url: str,
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
                    
                    # Пропускаем не видео файлы
                    if not key.endswith('.mp4'):
                        continue
                        
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
                            # Если video_id нет в метаданных, извлекаем из имени файла
                            filename = os.path.basename(key)
                            if filename.endswith('.mp4'):
                                potential_uuid = filename[:-4]
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
                    
                    # 🔧 Проверяем наличие thumbnail
                    has_thumbnail = False
                    if video_id:
                        try:
                            thumb_key = f"thumbnails/{camera_id_from_key}/{video_id}.jpg"
                            await self._client.head_object(Bucket=self.bucket_name, Key=thumb_key)
                            has_thumbnail = True
                        except:
                            pass
                    
                    # 🔧 Формируем URL на наши эндпоинты (относительные)
                    stream_url = f"{url}/esp_service/videos/stream?video_id={video_id}&camera_id={camera_id_from_key}&token={token}"
                
                    thumbnail_url = None
                    if has_thumbnail:
                        thumbnail_url = f"{url}/esp_service/videos/thumbnail?camera_id={camera_id_from_key}&video_id={video_id}&token={token}"
                    
                    objects.append({
                        'key': key,
                        'video_id': video_id,
                        'size_bytes': obj['Size'],
                        'last_modified': last_modified,
                        'camera_id': camera_id or camera_id_from_key,
                        'duration_seconds': duration_seconds,
                        'start_time': start_time.isoformat() if start_time else None,
                        'video_url': stream_url,      # 🔧 ПОЛНЫЙ URL с токеном
                        'thumbnail_url': thumbnail_url,  # 🔧 ПОЛНЫЙ URL с токеном
                    })
            
            logger.info(f"📋 Найдено видео: {len(objects)}")
            return objects
            
        except Exception as e:
            logger.exception(f"❌ Failed to list videos: {e}")
            return []

    async def save_video_from_stream(
        self, 
        camera_id: str, 
        file_stream,  # file-like object (из UploadFile.file)
        start_time: datetime, 
        duration_seconds: int, 
        metadata: dict = None
    ) -> Optional[str]:
        """Сохраняет видео из потока (для загрузки от ESP32)"""
        if not await self._ensure_connection():
            return None
        
        try:
            # Генерируем уникальный ID для видео
            video_id = str(uuid.uuid4())
            
            # Организация по папкам
            year = start_time.strftime("%Y")
            month = start_time.strftime("%m")
            day = start_time.strftime("%d")
            
            # Ключ: videos/{camera_id}/{год}/{месяц}/{день}/{uuid}.mp4
            key = f"videos/{camera_id}/{year}/{month}/{day}/{video_id}.mp4"
            
            # Метаданные
            s3_metadata = {
                'camera-id': camera_id,
                'video-id': video_id,
                'start-time': start_time.isoformat(),
                'duration': str(duration_seconds),
                'uploaded-at': datetime.now(timezone.utc).isoformat()
            }
            
            if metadata:
                s3_metadata.update(self._sanitize_metadata(metadata))
            
            # Загружаем напрямую из потока
            await self._client.put_object(
                Bucket=self.bucket_name,
                Key=key,
                Body=file_stream,
                ContentType='video/mp4',
                Metadata=s3_metadata
            )
            
            logger.info(f"💾 Видео сохранено из потока: {key} (ID: {video_id})")
            return video_id
            
        except Exception as e:
            logger.exception(f"❌ Ошибка сохранения видео из потока: {e}")
            return None

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
                'video-id': video_id,
                'start-time': start_time.isoformat(),
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
            return video_id
            
        except Exception as e:
            logger.exception(f"❌ Ошибка сохранения: {e}")
            return None
    
    async def save_thumbnail(self, camera_id: str, video_id: str, thumbnail_data: bytes) -> bool:
        """Сохранить thumbnail по UUID видео"""
        if not await self._ensure_connection():
            logger.error("❌ S3 connection failed for thumbnail")
            return False
        
        try:
            thumb_key = f"thumbnails/{camera_id}/{video_id}.jpg"
            await self._client.put_object(
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
            return True
            
        except Exception as e:
            logger.error(f"❌ Failed to save thumbnail: {e}")
            return False

    async def get_thumbnail(self, camera_id: str, video_id: str) -> Optional[bytes]:
        """
        Получить thumbnail из S3
        
        Args:
            camera_id: ID камеры
            video_id: ID видео
        
        Returns:
            Данные thumbnail в bytes или None
        """
        if not await self._ensure_connection():
            return None
        
        try:
            thumb_key = f"thumbnails/{camera_id}/{video_id}.jpg"
            
            response = await self._client.get_object(
                Bucket=self.bucket_name,
                Key=thumb_key
            )
            
            thumbnail_data = await response['Body'].read()
            logger.debug(f"🖼️ Thumbnail загружен: {thumb_key} ({len(thumbnail_data)} байт)")
            return thumbnail_data
            
        except ClientError as e:
            if e.response['Error']['Code'] == 'NoSuchKey':
                logger.debug(f"Thumbnail не найден: {thumb_key}")
                return None
            else:
                logger.exception(f"❌ Ошибка загрузки thumbnail: {e}")
                return None
        except Exception as e:
            logger.exception(f"❌ Ошибка загрузки thumbnail: {e}")
            return None

    async def get_video_chunk(
        self, 
        key: str, 
        start: Optional[int] = None, 
        end: Optional[int] = None
    ) -> tuple[Optional[bytes], int, Optional[str]]:
        """
        Получает чанк видео с поддержкой Range
        
        Args:
            key: Ключ видео в S3
            start: Начальный байт (None для полного файла)
            end: Конечный байт (None для до конца)
        
        Returns:
            (data, file_size, content_range)
        """
        if not await self._ensure_connection():
            return None, 0, None
        
        try:
            # Получаем размер файла
            head = await self._client.head_object(Bucket=self.bucket_name, Key=key)
            file_size = head['ContentLength']
            
            # Если нет Range - возвращаем полный файл
            if start is None:
                response = await self._client.get_object(
                    Bucket=self.bucket_name,
                    Key=key
                )
                data = await response['Body'].read()
                return data, file_size, None
            
            # Формируем Range
            if end is None:
                end = file_size - 1
            
            response = await self._client.get_object(
                Bucket=self.bucket_name,
                Key=key,
                Range=f'bytes={start}-{end}'
            )
            data = await response['Body'].read()
            
            content_range = f'bytes {start}-{end}/{file_size}'
            return data, file_size, content_range
            
        except ClientError as e:
            if e.response['Error']['Code'] == 'NoSuchKey':
                logger.warning(f"Видео не найдено: {key}")
            else:
                logger.exception(f"❌ Ошибка получения чанка: {e}")
            return None, 0, None
        except Exception as e:
            logger.exception(f"❌ Ошибка получения чанка: {e}")
            return None, 0, None
    
    async def get_video_key_by_id(self, camera_id: str, video_id: str) -> Optional[str]:
        """
        Находит ключ видео по camera_id и video_id
        
        Args:
            camera_id: ID камеры
            video_id: ID видео
        
        Returns:
            Ключ видео в S3 или None
        """
        if not await self._ensure_connection():
            return None
        
        try:
            prefix = f"videos/{camera_id}/"
            
            paginator = self._client.get_paginator('list_objects_v2')
            async for page in paginator.paginate(
                Bucket=self.bucket_name,
                Prefix=prefix
            ):
                if 'Contents' not in page:
                    continue
                
                for obj in page['Contents']:
                    key = obj['Key']
                    if not key.endswith('.mp4'):
                        continue
                    
                    # Проверяем метаданные
                    try:
                        head = await self._client.head_object(
                            Bucket=self.bucket_name,
                            Key=key
                        )
                        metadata = head.get('Metadata', {})
                        
                        if metadata.get('video-id') == video_id:
                            return key
                        
                        # Или проверяем имя файла
                        filename = os.path.basename(key)
                        if filename == f"{video_id}.mp4":
                            return key
                            
                    except:
                        continue
            
            return None
            
        except Exception as e:
            logger.exception(f"❌ Ошибка поиска видео: {e}")
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