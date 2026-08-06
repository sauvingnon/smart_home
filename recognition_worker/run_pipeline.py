"""
Этап 5: полный pipeline video -> кто присутствует.

Video -> YOLO (person) -> person crop -> face detect+align (insightface) ->
embedding -> classifier -> агрегация по видео -> присутствие каждого из 4 людей.

Usage:
    python scripts/run_pipeline.py --videos data_video --limit 5
    python scripts/run_pipeline.py --video data_video/some.mp4
"""
import argparse
import json
from collections import defaultdict
from pathlib import Path

import cv2
import joblib
import numpy as np
from insightface.app import FaceAnalysis
from insightface.utils import face_align
from ultralytics import YOLO

ROOT = Path(__file__).resolve().parent.parent
PERSON_CLASS_ID = 0


def blur_score(gray: np.ndarray) -> float:
    return cv2.Laplacian(gray, cv2.CV_64F).var()


def process_video(video_path, yolo, face_app, rec_model, clf, classes, args):
    cap = cv2.VideoCapture(str(video_path))
    fps = cap.get(cv2.CAP_PROP_FPS) or 12.0
    frame_step = max(1, round(fps * args.sample_interval))

    # per detected face: (predicted_label_or_None, max_prob)
    face_calls = []

    frame_idx = 0
    while True:
        ok = cap.grab()
        if not ok:
            break
        if frame_idx % frame_step == 0:
            ok, frame = cap.retrieve()
            if not ok:
                break
            h, w = frame.shape[:2]
            results = yolo.predict(frame, classes=[PERSON_CLASS_ID], conf=args.person_conf, verbose=False)[0]
            for box in results.boxes:
                x1, y1, x2, y2 = box.xyxy[0].tolist()
                pad_x = (x2 - x1) * 0.1
                pad_y = (y2 - y1) * 0.1
                x1 = max(0, int(x1 - pad_x)); y1 = max(0, int(y1 - pad_y))
                x2 = min(w, int(x2 + pad_x)); y2 = min(h, int(y2 + pad_y))
                person_crop = frame[y1:y2, x1:x2]
                if person_crop.size == 0:
                    continue

                for face in face_app.get(person_crop):
                    if face.det_score < args.face_det_thresh:
                        continue
                    fx1, fy1, fx2, fy2 = face.bbox
                    if min(fx2 - fx1, fy2 - fy1) < args.min_face_px:
                        continue
                    aligned = face_align.norm_crop(person_crop, face.kps, image_size=112)
                    gray = cv2.cvtColor(aligned, cv2.COLOR_BGR2GRAY)
                    if blur_score(gray) < args.min_blur:
                        continue

                    feat = rec_model.get_feat(aligned)[0].reshape(1, -1)
                    probs = clf.predict_proba(feat)[0]
                    best_idx = int(np.argmax(probs))
                    best_prob = float(probs[best_idx])
                    label = classes[best_idx] if best_prob >= args.unknown_threshold else None
                    face_calls.append((label, best_prob))
        frame_idx += 1
    cap.release()

    votes = defaultdict(list)
    for label, prob in face_calls:
        if label is not None:
            votes[label].append(prob)

    presence = {}
    for c in classes:
        n = len(votes[c])
        presence[c] = {
            "detections": n,
            "avg_conf": round(float(np.mean(votes[c])), 3) if n else 0.0,
            "present": n >= args.min_votes,
        }
    unknown_n = sum(1 for label, _ in face_calls if label is None)

    return {
        "video": video_path.name,
        "total_faces_seen": len(face_calls),
        "unknown_faces": unknown_n,
        "presence": presence,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--videos", default="data_video")
    ap.add_argument("--video", default=None, help="обработать один конкретный файл")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--sample-interval", type=float, default=1.0)
    ap.add_argument("--person-conf", type=float, default=0.4)
    ap.add_argument("--face-det-thresh", type=float, default=0.5)
    ap.add_argument("--min-face-px", type=int, default=30)
    ap.add_argument("--min-blur", type=float, default=8.0)
    ap.add_argument("--unknown-threshold", type=float, default=0.55, help="ниже этой уверенности лицо считается неизвестным")
    ap.add_argument("--min-votes", type=int, default=2, help="сколько уверенных детекций нужно, чтобы засчитать присутствие")
    ap.add_argument("--yolo-model", default="yolov8n.pt")
    ap.add_argument("--face-model", default="buffalo_l")
    ap.add_argument("--out", default="dataset/pipeline_results.jsonl")
    args = ap.parse_args()

    bundle = joblib.load(ROOT / "dataset" / "classifier.joblib")
    clf, classes = bundle["clf"], bundle["classes"]

    yolo = YOLO(args.yolo_model)
    face_app = FaceAnalysis(name=args.face_model, allowed_modules=["detection", "recognition"], providers=["CPUExecutionProvider"])
    face_app.prepare(ctx_id=-1, det_size=(640, 640))
    rec_model = face_app.models["recognition"]

    if args.video:
        videos = [Path(args.video)]
    else:
        videos = sorted(Path(args.videos).glob("*.mp4"))
        if args.limit:
            videos = videos[: args.limit]

    out_path = ROOT / args.out
    with out_path.open("a") as out_f:
        for vp in videos:
            result = process_video(vp, yolo, face_app, rec_model, clf, classes, args)
            out_f.write(json.dumps(result, ensure_ascii=False) + "\n")
            present = [c for c, info in result["presence"].items() if info["present"]]
            print(f"[{vp.name}] present: {present or '-'} | unknown_faces: {result['unknown_faces']} | total_faces: {result['total_faces_seen']}")


if __name__ == "__main__":
    main()
