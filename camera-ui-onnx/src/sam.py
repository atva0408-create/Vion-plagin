"""SAM 2.1 (Hiera tiny) on the CPU, only when asked: the outline of a thing marked on a picture by a box or by points,
and whether a thing is there at all. The recorder asks it to follow a thing the person marked on a frame of the
archive (when it went, where it was carried): a question of minutes, never a task in the background, so the model
is loaded by the first question and leaves memory when nobody asked for a while.

The CPU whatever the plugin's provider: the encoder needs more than 1.2 GB of a video card's memory, and on a card of
4 GB beside the live models it did not fit (bench, GTX 1050 Ti, 2026-10-14; 1.9 s a picture on its CPU). The same file
in the ONNX and OpenVINO plugins: ONNX Runtime where it is installed, OpenVINO's CPU otherwise (2.0 and 2.4 s an
encoded picture on a desktop CPU with 4 threads, the same outlines).
"""

from __future__ import annotations

import asyncio
import os
import time
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

import numpy as np
from PIL import Image

from textfind import _Loaded

if TYPE_CHECKING:
    from camera_ui_ml.model_manager import BaseModelManager
    from camera_ui_sdk import LoggerService

SAM_MODEL = "sam2.1-hiera-tiny"
SAM_FILES = (
    "vision_encoder.onnx",
    "vision_encoder.onnx_data",
    "prompt_encoder_mask_decoder.onnx",
    "prompt_encoder_mask_decoder.onnx_data",
)
SIDE = 1024
MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32).reshape(3, 1, 1)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32).reshape(3, 1, 1)
# a label the prompt encoder takes for no point at all: a box alone is asked with one such point beside it
NO_POINT = -10
# the model leaves memory when nobody asked for this long
IDLE_S = 300
# a quarter of the logical processors, two at least: 2 of the 4 cores of the bench's i5-8300H (4 were all of them, and
# the live models had none left)
THREADS = max(2, (os.cpu_count() or 8) // 4)
# below this the decoder's own estimate of its outline is no outline
MIN_SCORE = 0.3


def model_file(model_name: str) -> str | None:
    """The path of the model on the mirror and in the models folder, or nothing for another model."""
    return f"{SAM_MODEL}/vision_encoder.onnx" if model_name == SAM_MODEL else None


def pixels(image: Image.Image) -> np.ndarray:
    """The picture as the encoder takes it: 1024x1024 (stretched, as the model was trained), normalized, [1, 3, H, W]."""
    rgb = image.convert("RGB").resize((SIDE, SIDE), Image.Resampling.BILINEAR)
    x = np.asarray(rgb, dtype=np.float32).transpose(2, 0, 1) / 255.0
    return ((x - MEAN) / STD)[None].astype(np.float32)


def prompt_inputs(prompt: dict[str, Any]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """A box and points given in shares of the picture, in the encoder's 1024 x 1024: points [1, 1, n, 2] with their
    labels (1 the thing, 0 not it), boxes [1, 1, 4] corner to corner; a box alone gets one point that is none."""
    points = [
        (float(p["x"]) * SIDE, float(p["y"]) * SIDE, 1 if p.get("label", 1) else 0)
        for p in prompt.get("points") or []
    ]
    if not points:
        points = [(0.0, 0.0, NO_POINT)]
    coords = np.array([[[[x, y] for x, y, _ in points]]], dtype=np.float32)
    labels = np.array([[[label for _, _, label in points]]], dtype=np.int64)
    box = prompt.get("box")
    if box:
        x1, y1 = float(box["x"]) * SIDE, float(box["y"]) * SIDE
        x2, y2 = x1 + float(box["width"]) * SIDE, y1 + float(box["height"]) * SIDE
        boxes = np.array([[[x1, y1, x2, y2]]], dtype=np.float32)
    else:
        boxes = np.zeros((1, 0, 4), dtype=np.float32)
    return coords, labels, boxes


def outline(logits: np.ndarray, size: tuple[int, int]) -> dict[str, Any] | None:
    """The outline of one low resolution mask (logits) on a picture of `size`: the box it covers in shares, the mask
    over that box (0-255, more than 127 the thing), its share of the picture; nothing when the mask is empty."""
    width, height = size
    # tanh form of the sigmoid: exp overflows on large logits
    probability = 0.5 * (1.0 + np.tanh(logits.astype(np.float32) / 2.0))
    small = np.clip(probability * 255.0 + 0.5, 0, 255).astype(np.uint8)
    full = np.asarray(Image.fromarray(small).resize((width, height), Image.Resampling.BILINEAR))
    rows = np.flatnonzero((full > 127).any(axis=1))
    cols = np.flatnonzero((full > 127).any(axis=0))
    if not rows.size or not cols.size:
        return None
    y1, y2 = int(rows[0]), int(rows[-1]) + 1
    x1, x2 = int(cols[0]), int(cols[-1]) + 1
    crop = np.ascontiguousarray(full[y1:y2, x1:x2])
    return {
        "box": {"x": x1 / width, "y": y1 / height, "width": (x2 - x1) / width, "height": (y2 - y1) / height},
        "width": x2 - x1,
        "height": y2 - y1,
        "data": crop.tobytes(),
        "area": float((crop > 127).sum()) / (width * height),
    }


Run = Callable[[dict[str, np.ndarray]], list[np.ndarray]]


def runner(path: str) -> Run:
    """A model on the CPU as a function of its inputs by name to its outputs in its order: ONNX Runtime when the plugin
    has it, else OpenVINO (whose compiled model names two of the encoder's outputs by inner tensors: by order, then)."""
    try:
        import onnxruntime as ort
    except ImportError:
        ort = None
    # one kind of separator: OpenVINO 2024.6 (OpenVINO Legacy) found no external data beside a path of both
    path = os.path.normpath(path)
    if ort is not None:
        options = ort.SessionOptions()
        options.intra_op_num_threads = THREADS
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        # without its arena: it kept 2.5 GB while the model was loaded, 0.4 GB without, at the same speed (measured
        # with ONNX Runtime 1.26 and 1.31); the bench has 8 GB and its live models beside it
        options.enable_cpu_mem_arena = False
        session = ort.InferenceSession(path, options, providers=["CPUExecutionProvider"])
        return lambda feeds: list(session.run(None, feeds))
    import openvino as ov

    compiled = ov.Core().compile_model(path, "CPU", {"INFERENCE_NUM_THREADS": THREADS})
    return lambda feeds: [np.asarray(value) for value in compiled(feeds).values()]


class Sam(_Loaded):
    def __init__(self, manager: BaseModelManager, logger: LoggerService, *, base_url: str) -> None:
        super().__init__()
        self.manager = manager
        self.logger = logger
        self.base_url = base_url
        self.encoder: Run | None = None
        self.decoder: Run | None = None
        self.last_used = time.monotonic()
        # outlines under way: the model is not closed under them
        self.busy = 0
        # one picture at a time: a call the recorder gave up on (30 s) still runs when it asks again, and two encodings
        # at once doubled the memory and halved the speed of both
        self._one = asyncio.Lock()

    async def _load(self) -> None:
        started = time.monotonic()
        self.logger.log(f"Loading the outliner: {SAM_MODEL}...")
        for name in SAM_FILES:
            await self.manager._download(f"{self.base_url}/{SAM_MODEL}/{name}", f"{SAM_MODEL}/{name}")  # noqa: SLF001
        folder = os.path.join(self.manager.model_path, SAM_MODEL)
        self.encoder = await asyncio.to_thread(runner, os.path.join(folder, "vision_encoder.onnx"))
        self.decoder = await asyncio.to_thread(
            runner, os.path.join(folder, "prompt_encoder_mask_decoder.onnx")
        )
        self.initialized = True
        self.logger.success(f"Loaded the outliner in {time.monotonic() - started:.1f} s (CPU)")

    async def segment(self, image: Image.Image, prompts: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """The thing each prompt marks on one picture: its outline when there is one, the decoder's estimate of it
        (`score`) and whether a thing is there at all (`present`, the model's own judgement of an occluded or gone
        thing). The picture is encoded once (1.8 s of the 1.9 s on the bench's CPU), the prompts are cheap."""
        self.last_used = time.monotonic()
        self.busy += 1
        try:
            async with self._one:
                return await self._segment(image, prompts)
        finally:
            self.busy -= 1
            self.last_used = time.monotonic()

    def idle(self, now: float) -> bool:
        return self.busy == 0 and now - self.last_used >= IDLE_S

    async def _segment(self, image: Image.Image, prompts: list[dict[str, Any]]) -> list[dict[str, Any]]:
        assert self.encoder is not None and self.decoder is not None
        x = await asyncio.to_thread(pixels, image)
        embeddings = await asyncio.to_thread(self.encoder, {"pixel_values": x})
        answers: list[dict[str, Any]] = []
        for prompt in prompts:
            coords, labels, boxes = prompt_inputs(prompt)
            feeds = {
                "input_points": coords,
                "input_labels": labels,
                "input_boxes": boxes,
                "image_embeddings.0": embeddings[0],
                "image_embeddings.1": embeddings[1],
                "image_embeddings.2": embeddings[2],
            }
            iou, masks, present = await asyncio.to_thread(self.decoder, feeds)
            best = int(np.argmax(iou[0, 0]))
            score = float(iou[0, 0, best])
            found = outline(masks[0, 0, best], image.size) if score >= MIN_SCORE else None
            answers.append(
                {
                    "score": score,
                    "present": bool(present[0, 0, 0] > 0),
                    **({"mask": found} if found is not None else {}),
                }
            )
        return answers

    def close(self) -> None:
        self.encoder = None
        self.decoder = None
        self.initialized = False
        self._init_task = None
