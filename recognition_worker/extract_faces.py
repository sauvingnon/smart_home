"""
Достаёт кандидатов на эталонные лица из уже отснятых видео с камеры — когда
отдельных портретных фото нет, а видео полно. У кропов из реальных видео есть
преимущество перед постановочными фото: тот же ракурс, то же освещение, то же
качество картинки, что будет и на инференсе.

Прогоняет тот же YOLO+face-detect+align+quality-фильтры, что и основной
pipeline (run_pipeline.py), но вместо классификации просто сохраняет прошедшие
фильтр лица как jpg — по подпапке на видео. Один ролик — почти всегда один и
тот же человек в кадре, так что разметка сводится к "открыл подпапку, увидел
кто это, перенёс в dataset/<label>/", а не к перебору каждого кадра отдельно.

Usage:
    python extract_faces.py --videos videos_raw --out extracted_faces
"""
import argparse
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

import cv2
import numpy as np
from insightface.app import FaceAnalysis
from insightface.utils import face_align

from yolo_onnx import PersonDetectorONNX


def blur_score(gray: np.ndarray) -> float:
    return cv2.Laplacian(gray, cv2.CV_64F).var()


def extract_from_video(video_path: Path, yolo, face_app, out_dir: Path, args) -> int:
    cap = cv2.VideoCapture(str(video_path))
    fps = cap.get(cv2.CAP_PROP_FPS) or 12.0
    frame_step = max(1, round(fps * args.sample_interval))
    min_gap_frames = max(1, round(fps * args.min_gap_seconds))

    last_saved_frame = -10**9
    saved = 0
    frame_idx = 0

    while True:
        ok = cap.grab()
        if not ok:
            break
        if saved >= args.max_per_video:
            break

        # Ждём и sample_interval (не гоняем детект на каждом кадре без нужды),
        # и min_gap с последнего сохранённого — чтобы не набрать 15 кропов
        # подряд с одной и той же секунды, а разброс по времени/ракурсам.
        if frame_idx % frame_step == 0 and frame_idx - last_saved_frame >= min_gap_frames:
            ok, frame = cap.retrieve()
            if not ok:
                break
            h, w = frame.shape[:2]

            for x1, y1, x2, y2, _score in yolo.predict(frame):
                pad_x = (x2 - x1) * 0.1
                pad_y = (y2 - y1) * 0.1
                x1 = max(0, int(x1 - pad_x)); y1 = max(0, int(y1 - pad_y))
                x2 = min(w, int(x2 + pad_x)); y2 = min(h, int(y2 + pad_y))
                person_crop = frame[y1:y2, x1:x2]
                if person_crop.size == 0:
                    continue

                for face_i, face in enumerate(face_app.get(person_crop)):
                    if face.det_score < args.face_det_thresh:
                        continue
                    fx1, fy1, fx2, fy2 = face.bbox
                    if min(fx2 - fx1, fy2 - fy1) < args.min_face_px:
                        continue
                    aligned = face_align.norm_crop(person_crop, face.kps, image_size=112)
                    gray = cv2.cvtColor(aligned, cv2.COLOR_BGR2GRAY)
                    if blur_score(gray) < args.min_blur:
                        continue

                    out_dir.mkdir(parents=True, exist_ok=True)
                    out_path = out_dir / f"{frame_idx:06d}_{face_i}.jpg"
                    cv2.imwrite(str(out_path), aligned)
                    saved += 1
                    last_saved_frame = frame_idx

                if saved >= args.max_per_video:
                    break
        frame_idx += 1
    cap.release()
    return saved


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--videos", default="videos_raw")
    ap.add_argument("--out", default="extracted_faces")
    ap.add_argument("--sample-interval", type=float, default=0.3, help="секунды между попытками детекта")
    ap.add_argument("--min-gap-seconds", type=float, default=1.0, help="минимальный интервал между сохранёнными кропами одного видео")
    ap.add_argument("--max-per-video", type=int, default=15)
    ap.add_argument("--face-det-thresh", type=float, default=0.6)
    ap.add_argument("--min-face-px", type=int, default=50)
    ap.add_argument("--min-blur", type=float, default=30.0)
    ap.add_argument("--person-conf", type=float, default=0.4)
    ap.add_argument("--yolo-model", default="yolov8n.onnx")
    ap.add_argument("--face-model", default="buffalo_l")
    ap.add_argument("--gpu", action="store_true", help="использовать CUDAExecutionProvider (нужен onnxruntime-gpu + видеокарта)")
    ap.add_argument("--det-size", type=int, default=640, help="входное разрешение детектора лиц insightface (квадрат); больше — лучше ловит мелкие/дальние лица, дороже по вычислениям")
    args = ap.parse_args()

    videos_dir = Path(args.videos)
    videos = sorted(videos_dir.glob("*.mp4"))
    if not videos:
        raise SystemExit(f"Нет .mp4 в {videos_dir}")

    if args.gpu:
        providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
        ctx_id = 0
    else:
        providers = ["CPUExecutionProvider"]
        ctx_id = -1

    yolo = PersonDetectorONNX(args.yolo_model, conf=args.person_conf, providers=providers)
    face_app = FaceAnalysis(
        name=args.face_model,
        allowed_modules=["detection", "recognition"],
        providers=providers,
    )
    face_app.prepare(ctx_id=ctx_id, det_size=(args.det_size, args.det_size))

    if args.gpu:
        actual = yolo.session.get_providers()
        print(f"YOLO провайдеры: {actual}")
        if "CUDAExecutionProvider" not in actual:
            print("⚠️ CUDA не подключилась, фактически считаем на CPU")

    out_root = Path(args.out)
    total = 0
    empty = 0
    for i, vp in enumerate(videos, 1):
        video_out = out_root / vp.stem
        n = extract_from_video(vp, yolo, face_app, video_out, args)
        total += n
        if n == 0:
            empty += 1
        print(f"[{i}/{len(videos)}] {vp.name}: сохранено {n} лиц")

    print(f"\n💾 Итого: {total} кропов лиц в {out_root}/<видео>/*.jpg "
          f"({empty} видео дали 0 кропов — пусто или лицо не прошло фильтр)")
    print("Разбери подпапки по dataset/<label>/ и запусти enroll.py")


if __name__ == "__main__":
    main()
