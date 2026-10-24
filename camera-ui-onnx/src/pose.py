"""The posture of a person («поза»: стоит, сидит, лежит) from the 17 body keypoints of RTMPose-t.

The server crops every person box to the attribute sensor's square input (expanded, not stretched); the square is
fitted into the model's 192x256 with bars above and below, which leaves a standing person about the size mmpose gives
it (its box grown by a quarter). The model takes raw 0-255 RGB: its normalization is in the graph (the mirror's
rtmpose-t-256x192 is OpenMMLab's RTMPose-t body7 with the mean and std folded in, as VION's re-ID model).

The posture is a rule on the keypoints, not a model: the torso lying flat is lying, an upright torso with the thighs
out is sitting, an upright torso over upright thighs is standing; too few keypoints seen says nothing.

Kept identical in camera-ui-onnx and camera-ui-openvino (the legacy plugins copy it).
"""

from __future__ import annotations

import math

import numpy as np
from camera_ui_ml.backend import InputSpec
from camera_ui_ml.detectors.base import BaseDetector

POSE_MODEL = "rtmpose-t-256x192"
INPUT_WIDTH = 192
INPUT_HEIGHT = 256
# SimCC bins per pixel of the input
SPLIT = 2.0
# a keypoint counts from this score
MIN_POINT = 0.3
# the torso this far from the vertical lies; the thigh this far out of it sits (degrees)
LYING_TORSO = 60.0
SITTING_THIGH = 55.0
UPRIGHT_TORSO = 45.0

SHOULDERS = (5, 6)
HIPS = (11, 12)
KNEES = (13, 14)

POSTURES = ("стоит", "сидит", "лежит")


def fit_to_input(rgb: np.ndarray) -> np.ndarray:
    """The crop fitted whole into 192x256, centred, black bars around: no stretching of the person."""
    height, width = rgb.shape[:2]
    scale = min(INPUT_WIDTH / width, INPUT_HEIGHT / height)
    new_w = max(1, round(width * scale))
    new_h = max(1, round(height * scale))
    from PIL import Image

    resized = np.asarray(Image.fromarray(rgb, mode="RGB").resize((new_w, new_h), Image.Resampling.BILINEAR))
    canvas = np.zeros((INPUT_HEIGHT, INPUT_WIDTH, 3), dtype=np.uint8)
    top = (INPUT_HEIGHT - new_h) // 2
    left = (INPUT_WIDTH - new_w) // 2
    canvas[top : top + new_h, left : left + new_w] = resized
    return canvas


def decode(simcc_x: np.ndarray, simcc_y: np.ndarray) -> list[tuple[float, float, float]]:
    """The keypoints (x, y in the model's input, score) of one person from the SimCC outputs."""
    xs = np.asarray(simcc_x).reshape(-1, np.asarray(simcc_x).shape[-1])
    ys = np.asarray(simcc_y).reshape(-1, np.asarray(simcc_y).shape[-1])
    points = []
    for row_x, row_y in zip(xs, ys, strict=True):
        points.append(
            (
                float(row_x.argmax()) / SPLIT,
                float(row_y.argmax()) / SPLIT,
                float(min(row_x.max(), row_y.max())),
            )
        )
    return points


def _middle(
    points: list[tuple[float, float, float]], pair: tuple[int, int]
) -> tuple[float, float, float] | None:
    seen = [points[i] for i in pair if points[i][2] >= MIN_POINT]
    if not seen:
        return None
    return (
        sum(p[0] for p in seen) / len(seen),
        sum(p[1] for p in seen) / len(seen),
        sum(p[2] for p in seen) / len(seen),
    )


def _from_vertical(a: tuple[float, ...], b: tuple[float, ...]) -> float:
    return math.degrees(math.atan2(abs(b[0] - a[0]), abs(b[1] - a[1]) + 1e-6))


def posture(points: list[tuple[float, float, float]]) -> tuple[str, float] | None:
    """The posture and how sure of it (the mean score of the keypoints it rests on); None when too little is seen."""
    if len(points) < 17:
        return None
    shoulders = _middle(points, SHOULDERS)
    hips = _middle(points, HIPS)
    knees = _middle(points, KNEES)
    if shoulders is None:
        return None
    if hips is None:
        # a person lying is often seen without the hips (measured on the bench: both under 0.25 turned one way):
        # the line of the shoulders to the knees lying flat is lying too; upright it tells standing from sitting not
        if knees is not None and _from_vertical(shoulders, knees) >= LYING_TORSO:
            return "лежит", (shoulders[2] + knees[2]) / 2
        return None
    torso = _from_vertical(shoulders, hips)
    if torso >= LYING_TORSO:
        return "лежит", (shoulders[2] + hips[2]) / 2
    if knees is None:
        return None
    if torso > UPRIGHT_TORSO:
        # bent over, crouching: neither of the three
        return None
    sure = (shoulders[2] + hips[2] + knees[2]) / 3
    # the knees above the hips sit whatever the thigh's angle: measured on the bench, never so in a standing person
    # (knees 24-38 px below the hips), and a seated child at a computer with the thigh at 55° had them 13 px above
    if _from_vertical(hips, knees) >= SITTING_THIGH or knees[1] < hips[1]:
        return "сидит", sure
    return "стоит", sure


class PoseEstimator(BaseDetector):
    """The posture of the person of a crop by RTMPose-t; loaded when the first person of a camera with it on is seen."""

    name = "pose model"

    async def estimate(self, rgb: np.ndarray) -> tuple[str, float] | None:
        if not self._ready() or rgb.size == 0:
            return None
        assert self.backend is not None
        # the graph takes raw 0-255 RGB and normalizes inside
        spec = InputSpec(INPUT_WIDTH, INPUT_HEIGHT, layout="nchw", normalize="none")
        outputs = await self.backend.run(fit_to_input(rgb), spec)
        return posture(decode(outputs[0], outputs[1]))
