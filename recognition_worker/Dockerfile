FROM python:3.11-slim

# Иначе Docker не видит print() из worker.py, пока питон не сбросит буфер сам —
# stdout не подключён к терминалу, питон переходит на блочную буферизацию.
ENV PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
# pypi.org недоступен из РФ с 01.06.2026 — ставим через зеркало
RUN pip install --no-cache-dir \
    -i https://pypi.tuna.tsinghua.edu.cn/simple/ \
    --extra-index-url https://mirror.yandex.ru/pypi/web/simple/ \
    -r requirements.txt

COPY run_pipeline.py worker.py yolo_onnx.py backfill_queue.py classifier.joblib yolov8n.onnx ./

# Прогреваем insightface на этапе сборки, а не при каждом коротком запуске воркера.
# YOLO ONNX никакой прогрузки весов не требует — файл уже с нами, никуда не ходит.
# insightface качает все 5 моделей пака buffalo_l разом — используем только 2
# (detection, recognition), остальные 150MB чистый мёртвый груз, сносим тут же
# в этом же слое (удаление отдельным RUN слоем размер образа не уменьшило бы).
RUN python -c "\
from insightface.app import FaceAnalysis; \
FaceAnalysis(name='buffalo_l', allowed_modules=['detection', 'recognition'], providers=['CPUExecutionProvider']).prepare(ctx_id=-1, det_size=(320, 320))" \
    && rm -f /root/.insightface/models/buffalo_l/1k3d68.onnx \
             /root/.insightface/models/buffalo_l/2d106det.onnx \
             /root/.insightface/models/buffalo_l/genderage.onnx

CMD ["python", "worker.py"]
