"""The posture of a person (src/pose.py): the rule on keypoints, the fitting of a crop into the model's input, the
decoding of SimCC, and — when the model file is given (POSE_MODEL_FILE) — the model itself on drawn people.

    POSE_MODEL_FILE=/path/rtmpose-t-256x192.onnx python3 -m pytest camera-ui-onnx/tests/test_pose.py
"""

from __future__ import annotations

import asyncio
import math
import os
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "camera-ui-onnx" / "src"))

import pose  # noqa: E402


def body(shoulder, hip, knee, ankle, score=0.9):
    """17 keypoints with shoulders, hips, knees and ankles where given (both sides alike), the rest unseen."""
    points = [(0.0, 0.0, 0.05)] * 17
    for (left, right), at in (((5, 6), shoulder), ((11, 12), hip), ((13, 14), knee), ((15, 16), ankle)):
        if at is None:
            continue
        points[left] = (at[0] - 5, at[1], score)
        points[right] = (at[0] + 5, at[1], score)
    return points


def test_standing_sitting_lying():
    assert pose.posture(body((96, 60), (96, 130), (96, 180), (96, 230)))[0] == "стоит"
    # the thighs out in front, the torso upright
    assert pose.posture(body((96, 60), (96, 130), (150, 135), (150, 190)))[0] == "сидит"
    # the torso flat
    assert pose.posture(body((40, 128), (110, 135), (150, 136), (185, 138)))[0] == "лежит"


def at(start, degrees, length=70.0):
    """The point `length` below `start`, turned `degrees` from the vertical."""
    return (
        start[0] + length * math.sin(math.radians(degrees)),
        start[1] + length * math.cos(math.radians(degrees)),
    )


def test_the_borders_of_the_postures():
    shoulder = (60.0, 40.0)

    def of(torso, thigh):
        hip = at(shoulder, torso)
        knee = at(hip, thigh, 50.0)
        result = pose.posture(body(shoulder, hip, knee, at(knee, 0, 50.0)))
        return result and result[0]

    # the torso from the vertical: up to 45 upright, past 60 lying, between bent (nothing said)
    assert of(40, 0) == "стоит"
    assert of(50, 0) is None
    assert of(70, 0) == "лежит"
    # the thigh from the vertical under an upright torso: past 55 sitting
    assert of(0, 45) == "стоит"
    assert of(0, 65) == "сидит"


def test_too_little_seen_says_nothing():
    assert pose.posture(body(None, (96, 130), (96, 180), (96, 230))) is None
    assert pose.posture(body((96, 60), None, (96, 180), (96, 230))) is None
    # upright, the knees unseen: standing or sitting cannot be told
    assert pose.posture(body((96, 60), (96, 130), None, None)) is None
    # bent over, crouching
    assert pose.posture(body((55, 90), (110, 130), (110, 180), (110, 230))) is None
    assert pose.posture([]) is None


def test_lying_without_the_hips_seen():
    # the shoulders to the knees flat: lying; upright without hips: nothing
    assert pose.posture(body((40, 128), None, (150, 136), None))[0] == "лежит"
    assert pose.posture(body((96, 60), None, (96, 180), None)) is None


def test_how_sure_is_the_mean_score_of_the_keypoints():
    label, sure = pose.posture(body((96, 60), (96, 130), (96, 180), (96, 230), score=0.6))
    assert label == "стоит"
    assert sure == pytest.approx(0.6)


def test_one_side_seen_is_enough():
    points = body((96, 60), (96, 130), (96, 180), (96, 230))
    for i in (6, 12, 14):
        points[i] = (0.0, 0.0, 0.0)
    assert pose.posture(points)[0] == "стоит"


def test_a_crop_is_fitted_whole_without_stretching():
    square = np.full((100, 100, 3), 200, dtype=np.uint8)
    fitted = pose.fit_to_input(square)
    assert fitted.shape == (256, 192, 3)
    # a square becomes 192x192 with bars of 32 above and below
    assert fitted[31, 96].tolist() == [0, 0, 0]
    assert fitted[32, 96].tolist() == [200, 200, 200]
    assert fitted[223, 96].tolist() == [200, 200, 200]
    assert fitted[224, 96].tolist() == [0, 0, 0]
    wide = pose.fit_to_input(np.full((50, 200, 3), 200, dtype=np.uint8))
    assert wide[128, 0].tolist() == [200, 200, 200]
    assert wide[0, 96].tolist() == [0, 0, 0]


def test_decode():
    simcc_x = np.zeros((1, 17, 384), dtype=np.float32)
    simcc_y = np.zeros((1, 17, 512), dtype=np.float32)
    simcc_x[0, 3, 100] = 0.8
    simcc_y[0, 3, 300] = 0.6
    points = pose.decode(simcc_x, simcc_y)
    assert len(points) == 17
    assert points[3] == (50.0, 150.0, pytest.approx(0.6))


def simcc_of(points):
    """SimCC outputs that decode to `points`."""
    simcc_x = np.zeros((1, 17, 384), dtype=np.float32)
    simcc_y = np.zeros((1, 17, 512), dtype=np.float32)
    for i, (x, y, score) in enumerate(points):
        simcc_x[0, i, int(x * 2)] = score
        simcc_y[0, i, int(y * 2)] = score
    return [simcc_x, simcc_y]


def test_the_estimator_runs_the_fitted_crop_raw():
    seen = {}

    class Backend:
        async def run(self, rgb, spec):
            seen["shape"], seen["spec"] = rgb.shape, spec
            return simcc_of(body((96, 60), (96, 130), (150, 135), (150, 190)))

    estimator = pose.PoseEstimator(None, None)
    # not loaded yet: says nothing, runs nothing
    assert asyncio.run(estimator.estimate(np.zeros((64, 64, 3), dtype=np.uint8))) is None
    estimator.backend = Backend()
    estimator.initialized = True
    assert asyncio.run(estimator.estimate(np.zeros((0, 0, 3), dtype=np.uint8))) is None
    label, _ = asyncio.run(estimator.estimate(np.zeros((64, 64, 3), dtype=np.uint8)))
    assert label == "сидит"
    assert seen["shape"] == (256, 192, 3)
    assert (seen["spec"].width, seen["spec"].height, seen["spec"].normalize) == (192, 256, "none")


MODEL = os.environ.get("POSE_MODEL_FILE")


@pytest.mark.skipif(not MODEL, reason="POSE_MODEL_FILE not given")
def test_the_model_on_drawn_people():
    """A stick person drawn thick on gray is found standing: the folded normalization, the fitting and the decoding hold
    together. Not the model's accuracy: on a person of the bench turned on its side it said lying once of two ways."""
    import onnxruntime as ort
    from PIL import Image, ImageDraw

    session = ort.InferenceSession(MODEL, providers=["CPUExecutionProvider"])

    class Backend:
        async def run(self, rgb, spec):
            assert (spec.width, spec.height, spec.normalize) == (192, 256, "none")
            x = rgb.astype(np.float32).transpose(2, 0, 1)[None]
            return session.run(None, {session.get_inputs()[0].name: x})

    estimator = pose.PoseEstimator(None, None)
    estimator.backend = Backend()
    estimator.initialized = True

    def person() -> np.ndarray:
        img = Image.new("RGB", (256, 256), (128, 128, 128))
        d = ImageDraw.Draw(img)
        d.ellipse((112, 20, 144, 56), fill=(230, 200, 170))
        d.rectangle((108, 56, 148, 140), fill=(40, 60, 160))
        d.line((116, 140, 112, 236), fill=(30, 30, 30), width=14)
        d.line((140, 140, 144, 236), fill=(30, 30, 30), width=14)
        d.line((108, 64, 90, 132), fill=(40, 60, 160), width=10)
        d.line((148, 64, 166, 132), fill=(40, 60, 160), width=10)
        return np.asarray(img)

    upright = asyncio.run(estimator.estimate(person()))
    assert upright is not None and upright[0] == "стоит"
