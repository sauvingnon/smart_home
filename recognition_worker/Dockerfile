FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# CPU-only torch явно — иначе pip на linux тянет CUDA-сборку (лишние сотни MB, GPU тут не нужен)
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY run_pipeline.py worker.py classifier.joblib ./

# Прогреваем веса на этапе сборки, а не при каждом коротком запуске воркера
RUN python -c "from ultralytics import YOLO; YOLO('yolov8n.pt')"
RUN python -c "\
from insightface.app import FaceAnalysis; \
FaceAnalysis(name='buffalo_l', allowed_modules=['detection', 'recognition'], providers=['CPUExecutionProvider']).prepare(ctx_id=-1, det_size=(640, 640))"

CMD ["python", "worker.py"]
