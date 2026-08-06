"""
Ручной YOLOv8-инференс через голый onnxruntime, без ultralytics/torch.
Летербокс + постпроцессинг воспроизводят поведение ultralytics.YOLO.predict()
настолько близко, насколько можно сделать руками.
"""
import cv2
import numpy as np
import onnxruntime as ort


class PersonDetectorONNX:
    def __init__(self, onnx_path="yolov8n.onnx", imgsz=640, conf=0.4, iou=0.7):
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 1
        opts.inter_op_num_threads = 1
        self.session = ort.InferenceSession(onnx_path, sess_options=opts, providers=["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name
        self.imgsz = imgsz
        self.conf = conf
        self.iou = iou

    def _letterbox(self, img):
        h, w = img.shape[:2]
        scale = min(self.imgsz / h, self.imgsz / w)
        nh, nw = round(h * scale), round(w * scale)
        resized = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LINEAR)
        dh, dw = self.imgsz - nh, self.imgsz - nw
        top, bottom = dh // 2, dh - dh // 2
        left, right = dw // 2, dw - dw // 2
        padded = cv2.copyMakeBorder(resized, top, bottom, left, right, cv2.BORDER_CONSTANT, value=(114, 114, 114))
        return padded, scale, left, top

    def predict(self, img):
        """Возвращает список (x1, y1, x2, y2, conf) в координатах исходного img, только класс person."""
        padded, scale, pad_x, pad_y = self._letterbox(img)
        blob = cv2.cvtColor(padded, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        blob = blob.transpose(2, 0, 1)[None]  # HWC->CHW, add batch

        out = self.session.run(None, {self.input_name: blob})[0]  # [1, 84, 8400]
        preds = out[0].T  # [8400, 84]

        boxes_xywh = preds[:, :4]
        person_scores = preds[:, 4]  # класс 0 = person, это первый из 80 после 4 box-координат

        mask = person_scores >= self.conf
        boxes_xywh = boxes_xywh[mask]
        scores = person_scores[mask]
        if len(scores) == 0:
            return []

        cx, cy, w, h = boxes_xywh[:, 0], boxes_xywh[:, 1], boxes_xywh[:, 2], boxes_xywh[:, 3]
        x1 = cx - w / 2
        y1 = cy - h / 2

        idxs = cv2.dnn.NMSBoxes(
            bboxes=np.stack([x1, y1, w, h], axis=1).tolist(),
            scores=scores.tolist(),
            score_threshold=self.conf,
            nms_threshold=self.iou,
        )
        if len(idxs) == 0:
            return []
        idxs = np.array(idxs).flatten()

        results = []
        for i in idxs:
            bx1 = (x1[i] - pad_x) / scale
            by1 = (y1[i] - pad_y) / scale
            bx2 = (x1[i] + w[i] - pad_x) / scale
            by2 = (y1[i] + h[i] - pad_y) / scale
            results.append((float(bx1), float(by1), float(bx2), float(by2), float(scores[i])))
        return results
