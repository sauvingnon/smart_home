"""
Этап 5: полный pipeline video -> кто присутствует.

Video -> YOLO (person) -> person-трек между кадрами (IOU) -> insightface
face detect+align внутри трека -> усреднение эмбеддингов трека -> один
classify на трек -> присутствие каждого из 4 людей (хотя бы один уверенно
классифицированный трек). Портировано из cv_recognizer/scripts/run_pipeline.py
после находки бага с classes_ и перехода на трекинг там же.

Usage:
    python scripts/run_pipeline.py --videos data_video --limit 5
    python scripts/run_pipeline.py --video data_video/some.mp4
"""
import argparse
import json
from pathlib import Path

import cv2
import joblib
import numpy as np
from insightface.app import FaceAnalysis
from insightface.utils import face_align

from yolo_onnx import PersonDetectorONNX

ROOT = Path(__file__).resolve().parent.parent


def blur_score(gray: np.ndarray) -> float:
    return cv2.Laplacian(gray, cv2.CV_64F).var()


def iou(box_a, box_b):
    xa1, ya1, xa2, ya2 = box_a
    xb1, yb1, xb2, yb2 = box_b
    ix1, iy1 = max(xa1, xb1), max(ya1, yb1)
    ix2, iy2 = min(xa2, xb2), min(ya2, yb2)
    inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
    area_a = max(0, xa2 - xa1) * max(0, ya2 - ya1)
    area_b = max(0, xb2 - xb1) * max(0, yb2 - yb1)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


class Track:
    __slots__ = ("id", "bbox", "last_frame_idx", "embeddings")

    def __init__(self, track_id, bbox, frame_idx):
        self.id = track_id
        self.bbox = bbox
        self.last_frame_idx = frame_idx
        self.embeddings = []

    def update(self, bbox, frame_idx):
        self.bbox = bbox
        self.last_frame_idx = frame_idx


def process_video(video_path, yolo, face_app, rec_model, clf, classes, args):
    cap = cv2.VideoCapture(str(video_path))
    fps = cap.get(cv2.CAP_PROP_FPS) or 12.0
    frame_step = max(1, round(fps * args.sample_interval))
    # В секундах, не в сэмплах -- иначе допуск на разрыв трека меняется вместе с
    # sample_interval (на 1 fps 3 сэмпла = 3с, на нативном fps 3 сэмпла = ~0.4с,
    # трек рвётся в 7 раз чаще без реальной причины).
    max_gap_frames = round(args.max_frame_gap_seconds * fps)

    tracks = []
    next_track_id = 0

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
            for x1, y1, x2, y2, _score in yolo.predict(frame):
                pad_x = (x2 - x1) * 0.1
                pad_y = (y2 - y1) * 0.1
                x1 = max(0, int(x1 - pad_x)); y1 = max(0, int(y1 - pad_y))
                x2 = min(w, int(x2 + pad_x)); y2 = min(h, int(y2 + pad_y))
                if x2 <= x1 or y2 <= y1:
                    continue
                cur_box = (x1, y1, x2, y2)

                # ---- связываем с существующим треком по пересечению боксов ----
                best_iou, best_track = 0.0, None
                for t in tracks:
                    if frame_idx - t.last_frame_idx > max_gap_frames:
                        continue
                    i = iou(cur_box, t.bbox)
                    if i > best_iou:
                        best_iou, best_track = i, t
                if best_track is not None and best_iou >= args.iou_threshold:
                    track = best_track
                    track.update(cur_box, frame_idx)
                else:
                    track = Track(next_track_id, cur_box, frame_idx)
                    next_track_id += 1
                    tracks.append(track)

                # ---- поиск лица и эмбеддинг (не классифицируем сразу -- копим в трек) ----
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
                    feat = rec_model.get_feat(aligned)[0]
                    track.embeddings.append(feat)
        frame_idx += 1
    cap.release()

    # ---- классифицируем один раз на трек, по усреднённому эмбеддингу ----
    track_results = []
    for t in tracks:
        if len(t.embeddings) < args.min_track_faces:
            continue
        avg_feat = np.mean(t.embeddings, axis=0).reshape(1, -1)
        probs = clf.predict_proba(avg_feat)[0]
        best_idx = int(np.argmax(probs))
        best_prob = float(probs[best_idx])
        label = clf.classes_[best_idx] if best_prob >= args.unknown_threshold else None
        track_results.append({"track_id": t.id, "n_faces": len(t.embeddings), "label": label, "confidence": round(best_prob, 3)})

    presence = {}
    for c in classes:
        matching = [tr for tr in track_results if tr["label"] == c]
        presence[c] = {
            "tracks": len(matching),
            "best_confidence": max((tr["confidence"] for tr in matching), default=0.0),
            "present": len(matching) >= 1,
        }
    unknown_tracks = sum(1 for tr in track_results if tr["label"] is None)

    return {
        "video": video_path.name,
        "total_tracks": len(tracks),
        "classified_tracks": len(track_results),
        "unknown_tracks": unknown_tracks,
        "presence": presence,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--videos", default="data_video")
    ap.add_argument("--video", default=None, help="обработать один конкретный файл")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--sample-interval", type=float, default=0.01, help="0.01 ~= каждый кадр на любом реальном fps камеры; было 1.0 (1 кадр/сек) до находки, что recall лиц страдает от разреженного сэмплинга")
    ap.add_argument("--person-conf", type=float, default=0.4)
    ap.add_argument("--face-det-thresh", type=float, default=0.5)
    ap.add_argument("--min-face-px", type=int, default=30)
    ap.add_argument("--min-blur", type=float, default=8.0)
    ap.add_argument("--unknown-threshold", type=float, default=0.75, help="ниже этой уверенности трек считается неизвестным")
    ap.add_argument("--iou-threshold", type=float, default=0.2, help="минимальное пересечение боксов, чтобы считать это тем же треком")
    ap.add_argument("--max-frame-gap-seconds", type=float, default=3.0, help="сколько секунд подряд трек может не детектиться, прежде чем считаться потерянным (не зависит от sample_interval)")
    ap.add_argument("--min-track-faces", type=int, default=1, help="сколько лиц нужно набрать в треке, чтобы вообще классифицировать его")
    ap.add_argument("--yolo-model", default="yolov8n.onnx")
    ap.add_argument("--face-model", default="buffalo_l")
    ap.add_argument("--det-size", type=int, default=320)
    ap.add_argument("--out", default="dataset/pipeline_results.jsonl")
    args = ap.parse_args()

    bundle = joblib.load(Path(__file__).resolve().parent / "classifier.joblib")
    clf, classes = bundle["clf"], bundle["classes"]

    yolo = PersonDetectorONNX(args.yolo_model, conf=args.person_conf)
    face_app = FaceAnalysis(name=args.face_model, allowed_modules=["detection", "recognition"], providers=["CPUExecutionProvider"])
    face_app.prepare(ctx_id=-1, det_size=(args.det_size, args.det_size))
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
            print(f"[{vp.name}] present: {present or '-'} | tracks: {result['total_tracks']} (classified: {result['classified_tracks']}, unknown: {result['unknown_tracks']})")


if __name__ == "__main__":
    main()
