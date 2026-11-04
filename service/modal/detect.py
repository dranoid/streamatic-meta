# Runs RF-DETR (Apache 2.0) and ByteTrack (MIT) over a clip on Modal when the app asks, which it does for each clip when it
# starts. Nothing it finds is kept here: the app holds the tracks for as long as it runs.
#   modal secret create streamatic-detect DETECT_SECRET=<a long random value>
#   modal deploy service/modal/detect.py
import tempfile
import time

import modal

KINDS = {'person', 'bicycle', 'car', 'motorcycle', 'bus', 'truck', 'backpack', 'handbag', 'suitcase'}
SMALLEST_SCORE = 0.4
FPS = 5
MACHINES = 8
# A tracker's shortest fragments are mostly false starts, and each would count as someone new.
SHORTEST_TRACK_SECONDS = 1.0


def fetch_weights():
    from rfdetr import RFDETRLarge

    RFDETRLarge()


app = modal.App('streamatic-detect')
image = (
    modal.Image.debian_slim(python_version='3.12')
    .apt_install('libgl1', 'libglib2.0-0')
    .pip_install('rfdetr==1.11.2', 'supervision==0.29.0', 'opencv-python-headless==4.11.0.86', 'fastapi[standard]==0.115.0')
    .run_function(fetch_weights)
)


# A Modal GPU needs a payment method on the account as well as credit, so several CPU machines share the frames instead.
@app.function(image=image, cpu=8, memory=8192, timeout=900)
def detect_stretch(video: bytes, first: int, last: int) -> list:
    import cv2
    from rfdetr import RFDETRLarge
    from rfdetr.assets.coco_classes import COCO_CLASSES

    model = RFDETRLarge()
    found = []
    with tempfile.NamedTemporaryFile(suffix='.mp4') as file:
        file.write(video)
        file.flush()
        capture = cv2.VideoCapture(file.name)
        source_fps = capture.get(cv2.CAP_PROP_FPS) or FPS
        step = max(1, round(source_fps / FPS))
        capture.set(cv2.CAP_PROP_POS_FRAMES, first)
        index = first
        while index < last:
            ok, frame = capture.read()
            if not ok:
                break
            if index % step == 0:
                detected = model.predict(frame[:, :, ::-1].copy(), threshold=SMALLEST_SCORE)
                # Ids are read by name, since this model's numbering has gaps that other detectors' does not.
                rows = [
                    [[float(v) for v in box], float(score), COCO_CLASSES.get(int(kind), '')]
                    for box, score, kind in zip(detected.xyxy, detected.confidence, detected.class_id)
                ]
                found.append([round(index / source_fps * 1000), [r for r in rows if r[2] in KINDS]])
            index += 1
        capture.release()
    return found


def tracked(points: list) -> list:
    import numpy as np
    import supervision as sv

    # One tracker per kind, since a tracker that matches across kinds can pass an identity from a person to their bag.
    trackers = {kind: sv.ByteTrack(frame_rate=FPS) for kind in KINDS}
    tracks: dict[tuple[str, int], list[list[int]]] = {}
    for ms, rows in points:
        for kind, tracker in trackers.items():
            mine = [row for row in rows if row[2] == kind]
            detections = (
                sv.Detections(
                    xyxy=np.array([row[0] for row in mine], dtype=float),
                    confidence=np.array([row[1] for row in mine], dtype=float),
                    class_id=np.zeros(len(mine), dtype=int),
                )
                if mine
                else sv.Detections.empty()
            )
            result = tracker.update_with_detections(detections)
            for box, track_id in zip(result.xyxy, result.tracker_id):
                tracks.setdefault((kind, int(track_id)), []).append([ms, *[round(float(v)) for v in box]])
    kept = [track for track in tracks.items() if track[1][-1][0] - track[1][0][0] >= SHORTEST_TRACK_SECONDS * 1000]
    return [{'id': i, 'kind': kind, 'points': points} for i, ((kind, _), points) in enumerate(kept)]


@app.function(image=image, cpu=2, memory=4096, timeout=1800)
def detect_clip(video: bytes) -> dict:
    import cv2

    with tempfile.NamedTemporaryFile(suffix='.mp4') as file:
        file.write(video)
        file.flush()
        capture = cv2.VideoCapture(file.name)
        frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
        width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
        capture.release()
    size = frames // MACHINES + 1
    stretches = detect_stretch.starmap([(video, i * size, min(frames, (i + 1) * size)) for i in range(MACHINES)])
    points = sorted((point for stretch in stretches for point in stretch), key=lambda point: point[0])
    return {'fps': FPS, 'width': width, 'height': height, 'tracks': tracked(points)}


@app.function(image=image, secrets=[modal.Secret.from_name('streamatic-detect')], timeout=300)
@modal.asgi_app()
def web():
    import hmac
    import os

    from fastapi import FastAPI, Header, HTTPException, Request, Response

    api = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    def allowed(secret: str | None) -> None:
        if not secret or not hmac.compare_digest(secret, os.environ['DETECT_SECRET']):
            raise HTTPException(status_code=401)

    @api.post('/start')
    async def start(request: Request, x_detect_secret: str | None = Header(default=None)):
        allowed(x_detect_secret)
        call = detect_clip.spawn(await request.body())
        return {'call': call.object_id, 'startedAt': time.time()}

    @api.get('/result/{call}')
    async def result(call: str, response: Response, x_detect_secret: str | None = Header(default=None)):
        allowed(x_detect_secret)
        try:
            return modal.FunctionCall.from_id(call).get(timeout=0)
        except TimeoutError:
            response.status_code = 202
            return {'status': 'running'}

    return api
