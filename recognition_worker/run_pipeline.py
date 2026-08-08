"""
Полный pipeline video -> кто присутствует.

Video -> YOLO (person) -> person crop -> face detect+align (insightface) ->
embedding -> косинусное сравнение с эталонными эмбеддингами каждого человека
(references.joblib, см. enroll.py) -> агрегация по видео -> присутствие.

Раньше вместо эталонов был единый classifier.joblib (LogisticRegression на
всех сразу) — его точность на редких классах страдала от дисбаланса выборки
между людьми. Сравнение с независимым набором эталонов на человека от этого
не зависит: у кого сколько фото, никак не влияет на качество распознавания
остальных.

Usage:
    python run_pipeline.py --videos data_video --limit 5
    python run_pipeline.py --video data_video/some.mp4
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


def blur_score(gray: np.ndarray) -> float:
    return cv2.Laplacian(gray, cv2.CV_64F).var()


def _iou(a, b) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


class _Track:
    """Один физический проход человека через кадр. Копится по bbox-у между
    соседними сэмплированными кадрами (IoU), а не по распознанному лицу —
    трек существует даже пока лицо ещё не поймано ни разу."""

    def __init__(self, bbox, frame_idx):
        self.bbox = bbox
        self.last_frame_idx = frame_idx
        self.embeddings = []

    def update(self, bbox, frame_idx):
        self.bbox = bbox
        self.last_frame_idx = frame_idx


def match_face(feat: np.ndarray, references: dict, topk: int, sim_threshold: float, margin: float):
    """
    feat: сырой эмбеддинг лица (512,), нормируется внутри.
    references: {label: (N, 512) L2-нормированная матрица эталонов человека}.

    Для каждого человека берём среднее по topk самым похожим его эталонам
    (не просто ближайший один — устойчивее к случайному выбросу среди фото,
    и не просто центроид всех — сохраняет расброс по ракурсам/условиям).
    Принимаем результат, только если лучший кандидат прошёл порог похожести
    И оторвался от второго по близости человека хотя бы на margin — иначе
    лицо слишком неоднозначное между двумя людьми, честнее сказать "неизвестно".

    Возвращает (label_или_None, score_лучшего_кандидата).
    """
    feat = feat / np.linalg.norm(feat)

    scores = {}
    for label, refs in references.items():
        sims = refs @ feat
        k = min(topk, len(sims))
        top_sims = np.partition(sims, -k)[-k:]
        scores[label] = float(np.mean(top_sims))

    ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
    best_label, best_score = ranked[0]
    second_score = ranked[1][1] if len(ranked) > 1 else -1.0

    if best_score >= sim_threshold and (best_score - second_score) >= margin:
        return best_label, best_score
    return None, best_score


def process_video(video_path, yolo, face_app, rec_model, references, args):
    """
    Вместо голосования по отдельным кадрам — трекинг человека по видео
    (простой IoU-трекер bbox-ов) и один агрегированный вердикт на трек:
    все эмбеддинги лица, пойманные за время одного прохода через кадр,
    усредняются в один и сравниваются с эталонами один раз. Так слабые
    по отдельности кадры вместе дают уверенный ответ, а одно по-настоящему
    уверенное появление не нужно повторять несколько раз, чтобы засчитаться.
    """
    cap = cv2.VideoCapture(str(video_path))
    fps = cap.get(cv2.CAP_PROP_FPS) or 12.0
    frame_step = max(1, round(fps * args.sample_interval))
    max_gap = max(1, round(fps * args.track_max_gap_seconds))

    tracks: list[_Track] = []
    total_faces_seen = 0

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
                bx1 = max(0, int(x1 - pad_x)); by1 = max(0, int(y1 - pad_y))
                bx2 = min(w, int(x2 + pad_x)); by2 = min(h, int(y2 + pad_y))
                bbox = (bx1, by1, bx2, by2)
                person_crop = frame[by1:by2, bx1:bx2]
                if person_crop.size == 0:
                    continue

                # Ищем чей это трек — по пересечению bbox с последним
                # известным положением ещё не "остывших" треков.
                best_track, best_iou = None, 0.0
                for t in tracks:
                    if frame_idx - t.last_frame_idx > max_gap:
                        continue
                    iou = _iou(bbox, t.bbox)
                    if iou > best_iou:
                        best_track, best_iou = t, iou

                if best_track is not None and best_iou >= args.track_iou_thresh:
                    track = best_track
                    track.update(bbox, frame_idx)
                else:
                    track = _Track(bbox, frame_idx)
                    tracks.append(track)

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
                    feat = feat / np.linalg.norm(feat)
                    track.embeddings.append(feat)
                    total_faces_seen += 1
        frame_idx += 1
    cap.release()

    # Один вердикт на трек: усредняем все его эмбеддинги, сравниваем один раз.
    track_results = []
    for t in tracks:
        if not t.embeddings:
            continue
        avg_feat = np.mean(t.embeddings, axis=0)
        avg_feat = avg_feat / np.linalg.norm(avg_feat)
        label, score = match_face(avg_feat, references, args.topk, args.sim_threshold, args.margin)
        track_results.append((label, score, len(t.embeddings)))

    presence = {}
    for c in sorted(references.keys()):
        matches = [(score, n) for label, score, n in track_results if label == c]
        presence[c] = {
            "tracks_matched": len(matches),
            "avg_conf": round(float(np.mean([s for s, _ in matches])), 3) if matches else 0.0,
            "present": len(matches) >= 1,
        }
    unknown_n = sum(1 for label, _, _ in track_results if label is None)

    return {
        "video": video_path.name,
        "total_faces_seen": total_faces_seen,
        "tracks_found": len(tracks),
        "tracks_with_face": len(track_results),
        "unknown_tracks": unknown_n,
        "presence": presence,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--videos", default="data_video")
    ap.add_argument("--video", default=None, help="обработать один конкретный файл")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--sample-interval", type=float, default=0.05, help="секунды между сэмплами; при обычном fps камеры это фактически каждый кадр")
    ap.add_argument("--person-conf", type=float, default=0.4)
    ap.add_argument("--face-det-thresh", type=float, default=0.6)
    ap.add_argument("--min-face-px", type=int, default=50)
    ap.add_argument("--min-blur", type=float, default=30.0)
    ap.add_argument("--sim-threshold", type=float, default=0.38, help="минимальная косинусная близость к эталону, ниже — лицо неизвестное")
    ap.add_argument("--topk", type=int, default=5, help="сколько ближайших эталонов человека усредняем при сравнении")
    ap.add_argument("--margin", type=float, default=0.05, help="насколько лучший кандидат должен оторваться от второго, иначе неоднозначно -> неизвестно")
    ap.add_argument("--track-iou-thresh", type=float, default=0.3, help="порог IoU, чтобы считать bbox продолжением того же трека")
    ap.add_argument("--track-max-gap-seconds", type=float, default=1.0, help="сколько секунд трек может быть без детекции, прежде чем считать что он закончился")
    ap.add_argument("--yolo-model", default="yolov8n.onnx")
    ap.add_argument("--face-model", default="buffalo_l")
    ap.add_argument("--references", default="references.joblib")
    ap.add_argument("--out", default="pipeline_results.jsonl")
    args = ap.parse_args()

    references = joblib.load(args.references)

    yolo = PersonDetectorONNX(args.yolo_model, conf=args.person_conf)
    face_app = FaceAnalysis(name=args.face_model, allowed_modules=["detection", "recognition"], providers=["CPUExecutionProvider"])
    face_app.prepare(ctx_id=-1, det_size=(640, 640))
    rec_model = face_app.models["recognition"]

    if args.video:
        videos = [Path(args.video)]
    else:
        videos = sorted(Path(args.videos).glob("*.mp4"))
        if args.limit:
            videos = videos[: args.limit]

    out_path = Path(args.out)
    with out_path.open("a") as out_f:
        for vp in videos:
            result = process_video(vp, yolo, face_app, rec_model, references, args)
            out_f.write(json.dumps(result, ensure_ascii=False) + "\n")
            present = [c for c, info in result["presence"].items() if info["present"]]
            print(f"[{vp.name}] present: {present or '-'} | треков: {result['tracks_found']} "
                  f"(с лицом: {result['tracks_with_face']}, неопознано: {result['unknown_tracks']})")


if __name__ == "__main__":
    main()
