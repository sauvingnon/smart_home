"""
Порт presence_detector.py (v7, door_direction/, 88% на labels.csv) под прод —
PersonDetectorONNX вместо ultralytics YOLO, чтобы переиспользовать уже
загруженную в worker.py модель, а не тащить вторую (лишняя память на тесной
VPS). Отдельный проход по видео на собственном (почти нативном) fps —
episode-логика v7 калибровалась на секундных порогах (merge-gap 0.7с,
min-episode 0.3с, есть эпизоды выхода короче 3с в разметке), а общий
recognition-пайплайн сэмплирует 1 кадр/сек ради CPU-бюджета, чего для этой
логики недостаточно (см. door_direction/README.md, "Восстановление разметки").

Маска зеркала (mirror_x1/x2) — те же координаты, что в door_direction,
камера и кадр те же (source video общий с cv_recognizer/data_video).

Не включает leading_gap/face_orient (v8, не реализовано и не проверено) —
только проверенный v7.
"""
from pathlib import Path

import cv2


def find_episodes(presence, merge_gap_frames, min_episode_frames):
    n = len(presence)
    runs = []
    i = 0
    while i < n:
        if presence[i]:
            start = i
            while i < n and presence[i]:
                i += 1
            runs.append((start, i - 1))
        else:
            i += 1

    if not runs:
        return []

    merged = [runs[0]]
    for start, end in runs[1:]:
        last_start, last_end = merged[-1]
        gap = start - last_end - 1
        if gap <= merge_gap_frames:
            merged[-1] = (last_start, end)
        else:
            merged.append((start, end))

    return [(s, e) for s, e in merged if (e - s + 1) >= min_episode_frames]


class DirectionArgs:
    person_conf = 0.4
    trailing_gap_thresh = 3.5
    low_confidence_margin = 0.5  # |gap_after_sec - trailing_gap_thresh| меньше этого -> low_confidence
    merge_gap_seconds = 0.7
    min_episode_seconds = 0.3
    mask_mirror = True
    mirror_x1 = 800
    mirror_x2 = 1100


def process_video_direction(video_path, yolo, args=None):
    """yolo — уже загруженный PersonDetectorONNX (тот же экземпляр, что и для
    recognition), video_path — путь к тому же временному файлу, что и
    process_video() из run_pipeline.py. Отдельная cv2.VideoCapture-пробежка,
    почти нативный fps (в отличие от sample_interval=1.0 у recognition)."""
    args = args or DirectionArgs()
    cap = cv2.VideoCapture(str(video_path))
    fps = cap.get(cv2.CAP_PROP_FPS) or 12.0
    merge_gap_frames = max(0, round(fps * args.merge_gap_seconds))

    presence = []
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if args.mask_mirror:
            frame[:, args.mirror_x1:args.mirror_x2] = 0
        boxes = yolo.predict(frame)
        presence.append(len(boxes) > 0)
    cap.release()

    total = len(presence)
    min_episode_frames = max(1, round(fps * args.min_episode_seconds))
    episodes_raw = find_episodes(presence, merge_gap_frames, min_episode_frames)

    if not episodes_raw:
        return {"total_frames": total, "fps": round(fps, 1), "verdict": "nothing", "low_confidence": False, "episodes": []}

    episodes = []
    for idx, (start, end) in enumerate(episodes_raw):
        is_last = idx == len(episodes_raw) - 1
        if is_last:
            gap_after_sec = (total - 1 - end) / fps
            verdict = "entering" if gap_after_sec <= args.trailing_gap_thresh else "exiting"
            # эвристический proxy уверенности, не калиброванная вероятность -- близко к
            # порогу решение шаткое (см. door_direction/README.md, пара видео 3.01с/3.04с
            # с противоположным GT, порог там принципиально не разруливает)
            raw_margin = abs(gap_after_sec - args.trailing_gap_thresh)
            low_confidence = raw_margin < args.low_confidence_margin
            margin_sec = round(raw_margin, 1)
        else:
            # "не последний эпизод = exiting" не пороговая эвристика, margin не считаем --
            # но сама по себе она менее проверена, чем trailing-gap для последнего эпизода
            gap_after_sec = None
            verdict = "exiting"
            margin_sec = None
            low_confidence = True
        episodes.append({
            "start": start,
            "end": end,
            "n_frames": end - start + 1,
            "start_sec": round(start / fps, 1),
            "end_sec": round(end / fps, 1),
            "is_last": is_last,
            "verdict": verdict,
            "gap_after_sec": round(gap_after_sec, 1) if gap_after_sec is not None else None,
            "margin_sec": margin_sec,
            "low_confidence": low_confidence,
        })

    return {
        "total_frames": total,
        "fps": round(fps, 1),
        "verdict": episodes[-1]["verdict"],
        "low_confidence": episodes[-1]["low_confidence"],
        "episodes": episodes,
    }


if __name__ == "__main__":
    import argparse

    from yolo_onnx import PersonDetectorONNX

    ap = argparse.ArgumentParser()
    ap.add_argument("--videos-dir", required=True)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--yolo-model", default="yolov8n.onnx")
    cli_args = ap.parse_args()

    yolo = PersonDetectorONNX(cli_args.yolo_model, conf=DirectionArgs.person_conf)
    videos = sorted(Path(cli_args.videos_dir).glob("*.mp4"))
    if cli_args.limit:
        videos = videos[: cli_args.limit]

    for vp in videos:
        r = process_video_direction(vp, yolo)
        conf = " [low_confidence]" if r["low_confidence"] else ""
        print(f"[{vp.name}] {r['total_frames']}f@{r['fps']}fps -> {r['verdict']}{conf} | {len(r['episodes'])} эпизод(ов)")
