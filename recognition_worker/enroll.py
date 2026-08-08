"""
Строит эталонные эмбеддинги людей из фото — замена обучению classifier.joblib.

Вместо одной общей модели на всех: у каждого человека свой независимый набор
эталонных эмбеддингов, сравнение по косинусной близости (см. match_face в
run_pipeline.py). Дисбаланс количества фото между людьми больше не портит
качество остальных — у каждого своя, ни от кого не зависящая база.

Ожидает структуру:
    dataset/<label>/*.jpg (или .png/.jpeg)
где <label> — то же имя, что попадёт в recognized (например andrey, liliya, kamelia, grisha).
Одно лицо на фото — если найдено 0 или больше 1, фото пропускается с предупреждением.

Usage:
    python enroll.py --photos-dir dataset --out references.joblib
"""
import argparse
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

import cv2
import joblib
import numpy as np
from insightface.app import FaceAnalysis

IMG_EXTS = {".jpg", ".jpeg", ".png"}


def build_references(photos_dir: Path, face_app: FaceAnalysis, rec_model) -> dict:
    references = {}

    for person_dir in sorted(p for p in photos_dir.iterdir() if p.is_dir()):
        label = person_dir.name
        photos = sorted(p for p in person_dir.iterdir() if p.suffix.lower() in IMG_EXTS)
        embeddings = []

        for photo_path in photos:
            img = cv2.imread(str(photo_path))
            if img is None:
                print(f"  ⚠️ {photo_path.name}: не читается, пропускаю")
                continue

            h, w = img.shape[:2]
            if h <= 128 and w <= 128:
                # Уже выровненный face-crop 112x112 (например из extract_faces.py) —
                # повторный детект на нём обычно ничего не находит, вокруг лица
                # нет контекста, на который рассчитан детектор. Эмбеддинг считаем
                # напрямую, это ровно тот же вход, что и при обучении/инференсе.
                feat = rec_model.get_feat(img)[0].astype(np.float32)
            else:
                faces = face_app.get(img)
                if len(faces) == 0:
                    print(f"  ⚠️ {photo_path.name}: лицо не найдено, пропускаю")
                    continue
                if len(faces) > 1:
                    print(f"  ⚠️ {photo_path.name}: найдено {len(faces)} лиц, пропускаю (нужно фото с одним человеком)")
                    continue
                feat = faces[0].embedding.astype(np.float32)

            feat = feat / np.linalg.norm(feat)
            embeddings.append(feat)

        if not embeddings:
            print(f"⚠️ {label}: ни одного валидного фото, человек пропущен целиком")
            continue

        references[label] = np.stack(embeddings)
        print(f"✅ {label}: {len(embeddings)}/{len(photos)} фото использовано")

    return references


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--photos-dir", default="dataset", help="папка с подпапками dataset/<label>/*.jpg")
    ap.add_argument("--out", default="references.joblib")
    ap.add_argument("--face-model", default="buffalo_l")
    args = ap.parse_args()

    photos_dir = Path(args.photos_dir)
    if not photos_dir.is_dir():
        raise SystemExit(f"Нет папки {photos_dir} — создай {photos_dir}/<label>/*.jpg для каждого человека")

    face_app = FaceAnalysis(
        name=args.face_model,
        allowed_modules=["detection", "recognition"],
        providers=["CPUExecutionProvider"],
    )
    face_app.prepare(ctx_id=-1, det_size=(640, 640))
    rec_model = face_app.models["recognition"]

    references = build_references(photos_dir, face_app, rec_model)
    if not references:
        raise SystemExit("Ни один человек не набрал ни одного валидного фото — эталоны не сохранены")

    joblib.dump(references, args.out)
    total = sum(len(v) for v in references.values())
    counts = ", ".join(f"{label}={len(v)}" for label, v in sorted(references.items()))
    print(f"\n💾 Сохранено {args.out}: {len(references)} человек, {total} эмбеддингов всего ({counts})")


if __name__ == "__main__":
    main()
