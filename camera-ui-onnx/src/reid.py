"""People who look alike (person re-ID) and outlines of objects (segmentation), kept identical in the ONNX and OpenVINO
plugins (the legacy plugins copy them).

Upstream ships these helpers in camera-ui-ml 1.2.16 and later; the bundles install 1.2.15 from PyPI, whose newer
versions also change detection thresholds and face alignment that ViON's detection is tuned to. Everything below uses
only what 1.2.15 has.
"""

from __future__ import annotations

import math
from typing import TYPE_CHECKING, Any

import numpy as np
from camera_ui_ml.backend import InputSpec, NDArray, Outputs
from camera_ui_ml.detectors.base import BaseDetector
from camera_ui_ml.model_manager import BaseModelManager
from camera_ui_ml.parsing import channels_first, l2_normalize
from camera_ui_ml.preprocess import decode_image, frame_to_rgb
from camera_ui_sdk import BoundingBox, LoggerService
from PIL import Image

if TYPE_CHECKING:
    from camera_ui_sdk import (
        ObjectMask,
        PersonEmbeddingResult,
        SegmentationFrame,
        SegmentationImage,
        SegmentationResult,
        VideoFrameData,
    )

# a candidate of the segmentation model counts from this score, and is the object asked for from this overlap
MIN_SCORE = 0.25
MIN_IOU = 0.3


class PersonEmbedder(BaseDetector):
    """A vector of a person's clothes and build from the tight crop of their box (not who they are)."""

    def __init__(
        self,
        manager: BaseModelManager,
        logger: LoggerService,
        *,
        width: int = 128,
        height: int = 256,
        name: str = "person embedder",
    ) -> None:
        super().__init__(manager, logger)
        self.name = name
        self.input_size = (width, height)

    @property
    def _spec(self) -> InputSpec:
        # the re-ID graph takes raw 0-255 RGB and normalizes inside
        return InputSpec(self.input_size[0], self.input_size[1], layout="nchw", normalize="none")

    async def embed(self, rgb: NDArray) -> list[float]:
        if not self._ready() or rgb.size == 0:
            return []
        assert self.backend is not None

        width, height = self.input_size
        if rgb.shape[1] != width or rgb.shape[0] != height:
            # stretched, never padded: the model was measured on the tight box, resized bilinear
            rgb = np.asarray(
                Image.fromarray(rgb, mode="RGB").resize((width, height), Image.Resampling.BILINEAR)
            )
        outputs = await self.backend.run(rgb, self._spec)
        return [float(value) for value in l2_normalize(outputs[0])]


class Segmenter(BaseDetector):
    """The outline of the object in a box: the model's candidate that overlaps the box best, as a mask."""

    def __init__(
        self,
        manager: BaseModelManager,
        logger: LoggerService,
        *,
        size: tuple[int, int] = (320, 320),
        name: str = "segmenter",
    ) -> None:
        super().__init__(manager, logger)
        self.name = name
        self.input_size = size

    async def _configure(self, model_name: str) -> None:
        assert self.backend is not None
        width, height = self.backend.input_size
        if width > 0 and height > 0:
            self.input_size = (width, height)

    @property
    def _spec(self) -> InputSpec:
        return InputSpec(self.input_size[0], self.input_size[1], layout="nchw", normalize="unit")

    async def segment(self, rgb: NDArray, box: BoundingBox) -> ObjectMask | None:
        """Outline the object at ``box`` (normalized to ``rgb``); the mask box is normalized the same way."""
        if not self._ready() or rgb.size == 0:
            return None
        assert self.backend is not None

        width, height = self.input_size
        if rgb.shape[1] != width or rgb.shape[0] != height:
            # bilinear, as measured; PIL's bicubic default cost up to 3 points of mask IoU
            rgb = np.asarray(
                Image.fromarray(rgb, mode="RGB").resize((width, height), Image.Resampling.BILINEAR)
            )
        outputs = await self.backend.run(rgb, self._spec)
        return decode_mask(outputs, box, self.input_size)


def decode_mask(outputs: Outputs, box: BoundingBox, size: tuple[int, int]) -> ObjectMask | None:
    split = _split(outputs)
    if split is None:
        return None
    candidates, protos = split
    coefficients = protos.shape[0]
    classes = candidates.shape[0] - 4 - coefficients
    if classes < 1:
        return None

    width, height = size
    scores = candidates[4 : 4 + classes].max(axis=0)
    cx, cy, w, h = (candidates[i] / scale for i, scale in enumerate((width, height, width, height)))
    left, top, right, bottom = cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2

    overlap_x = np.minimum(right, box["x"] + box["width"]) - np.maximum(left, box["x"])
    overlap_y = np.minimum(bottom, box["y"] + box["height"]) - np.maximum(top, box["y"])
    inter = np.clip(overlap_x, 0, None) * np.clip(overlap_y, 0, None)
    union = w * h + box["width"] * box["height"] - inter
    iou = np.where((scores > MIN_SCORE) & (union > 0), inter / np.maximum(union, 1e-9), 0.0)
    best = int(np.argmax(iou))
    if iou[best] < MIN_IOU:
        return None

    x1 = min(max(math.floor(left[best] * width), 0), width)
    y1 = min(max(math.floor(top[best] * height), 0), height)
    x2 = min(max(math.ceil(right[best] * width), 0), width)
    y2 = min(max(math.ceil(bottom[best] * height), 0), height)
    if x2 <= x1 or y2 <= y1:
        return None

    logits = candidates[4 + classes :, best] @ protos.reshape(coefficients, -1)
    # tanh form of the sigmoid, exp overflows on large logits
    probability = 0.5 * (1.0 + np.tanh(logits / 2.0))
    small = (
        np.clip(probability * 255.0 + 0.5, 0, 255).astype(np.uint8).reshape(protos.shape[1], protos.shape[2])
    )
    full = np.asarray(Image.fromarray(small).resize((width, height), Image.Resampling.BILINEAR))
    crop = np.ascontiguousarray(full[y1:y2, x1:x2])

    return {
        "box": {"x": x1 / width, "y": y1 / height, "width": (x2 - x1) / width, "height": (y2 - y1) / height},
        "width": x2 - x1,
        "height": y2 - y1,
        "data": crop.tobytes(),
    }


def _split(outputs: Outputs) -> tuple[NDArray, NDArray] | None:
    # the runtimes name and order the two outputs differently, the shapes tell them apart
    candidates: NDArray | None = None
    protos: NDArray | None = None
    for output in outputs:
        array = np.squeeze(np.asarray(output, dtype=np.float32))
        if array.ndim == 3:
            protos = array
        elif array.ndim == 2:
            candidates = channels_first(array)
    if candidates is None or protos is None:
        return None
    return candidates, protos


async def embed_persons(
    embedder: PersonEmbedder, frames: list[VideoFrameData], space: str
) -> list[PersonEmbeddingResult]:
    crops = [
        frame_to_rgb(bytes(frame["data"]), frame["width"], frame["height"], frame.get("format", "rgb"))
        for frame in frames
    ]
    return [{"embedding": await embedder.embed(crop), "embeddingModel": space} for crop in crops]


async def embed_person_images(
    embedder: PersonEmbedder, images: list[bytes], space: str
) -> list[PersonEmbeddingResult]:
    results: list[PersonEmbeddingResult] = []
    for data in images:
        try:
            crop = decode_image(data)
        except Exception:
            # an empty vector says "nobody to embed" in this picture; the others still are
            crop = np.zeros((0, 0, 3), dtype=np.uint8)
        results.append({"embedding": await embedder.embed(crop), "embeddingModel": space})
    return results


def largest_person(
    detections: list[tuple[int, float, BoundingBox]], labels: dict[int, str]
) -> BoundingBox | None:
    """The biggest person of a picture's detections (boxes 0..1): the one a picture of somebody is about."""
    people = [
        box
        for cid, _, box in detections
        if labels.get(cid) == "person" and box["width"] > 0 and box["height"] > 0
    ]
    return max(people, key=lambda box: box["width"] * box["height"], default=None)


def crop_box(rgb: NDArray, box: BoundingBox) -> NDArray:
    """The tight box of a person, no margin: the server cuts the people of the frames the same way."""
    height, width = rgb.shape[:2]
    x1 = min(max(math.floor(box["x"] * width), 0), width)
    y1 = min(max(math.floor(box["y"] * height), 0), height)
    x2 = min(max(math.ceil((box["x"] + box["width"]) * width), 0), width)
    y2 = min(max(math.ceil((box["y"] + box["height"]) * height), 0), height)
    return np.ascontiguousarray(rgb[y1:y2, x1:x2])


async def embed_people_in_pictures(
    embedder: PersonEmbedder, detector: Any, images: list[bytes], space: str
) -> list[PersonEmbeddingResult]:
    """A picture of a scene (a search by picture): the biggest person in it, cut tight, made a vector; nobody found
    is an empty vector."""
    results: list[PersonEmbeddingResult] = []
    for data in images:
        try:
            rgb = decode_image(data)
        except Exception:
            results.append({"embedding": [], "embeddingModel": space})
            continue
        found = await detector.detect_single(data, {"width": rgb.shape[1], "height": rgb.shape[0]})
        box = largest_person(found, detector.labels)
        crop = crop_box(rgb, box) if box is not None else np.zeros((0, 0, 3), dtype=np.uint8)
        results.append({"embedding": await embedder.embed(crop), "embeddingModel": space})
    return results


async def segment_objects(segmenter: Segmenter, frames: list[SegmentationFrame]) -> list[SegmentationResult]:
    results: list[SegmentationResult] = []
    for frame in frames:
        rgb = frame_to_rgb(bytes(frame["data"]), frame["width"], frame["height"], frame.get("format", "rgb"))
        results.append(_segmentation(await segmenter.segment(rgb, frame["box"])))
    return results


async def segment_images(segmenter: Segmenter, images: list[SegmentationImage]) -> list[SegmentationResult]:
    results: list[SegmentationResult] = []
    for item in images:
        try:
            rgb = decode_image(bytes(item["image"]))
        except Exception:
            # an unreadable picture gets no outline, the others still do
            results.append({})
            continue
        results.append(_segmentation(await segmenter.segment(rgb, item["box"])))
    return results


def _segmentation(mask: ObjectMask | None) -> SegmentationResult:
    return {"mask": mask} if mask is not None else {}
