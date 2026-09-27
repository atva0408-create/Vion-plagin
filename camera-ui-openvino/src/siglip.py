"""Multilingual SigLIP for semantic search (queries in Russian and ~100 more languages).

Same interface as camera_ui_ml's ClipEncoder, so the plugin treats it as one more CLIP family:
- the text tower takes ``input_ids`` only, padded to 64 tokens (how SigLIP was trained);
- the tokenizer is SentencePiece, the image preprocessing (resize, rescale, normalise) is done here
  from ``preprocessor_config.json``, without torch/torchvision;
- the processor files live next to the towers: ``<family>/{preprocessor_config.json,…}``.

Kept identical in camera-ui-onnx and camera-ui-openvino.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from typing import TYPE_CHECKING, Any

import numpy as np
from camera_ui_ml.detectors.clip import ClipEncoder
from PIL import Image

if TYPE_CHECKING:
    from camera_ui_ml import BaseModelManager
    from camera_ui_sdk import LoggerService

TEXT_TOKENS = 64
PROCESSOR_FILES = ("preprocessor_config.json", "tokenizer_config.json", "spiece.model")


def is_siglip(family: str) -> bool:
    return family.startswith("siglip")


class SiglipPreprocessor:
    def __init__(self, folder: str) -> None:
        from transformers import AutoTokenizer

        with open(os.path.join(folder, "preprocessor_config.json"), encoding="utf-8") as handle:
            config: dict[str, Any] = json.load(handle)
        size = config.get("size") or {}
        self.width = int(size.get("width", size.get("shortest_edge", 256)))
        self.height = int(size.get("height", size.get("shortest_edge", 256)))
        self.resample = int(config.get("resample", Image.Resampling.BICUBIC))
        self.rescale = float(config.get("rescale_factor", 1 / 255)) if config.get("do_rescale", True) else 1.0
        normalize = config.get("do_normalize", True)
        self.mean = np.asarray(
            config.get("image_mean", [0.5, 0.5, 0.5]) if normalize else [0, 0, 0], dtype=np.float32
        )
        self.std = np.asarray(
            config.get("image_std", [0.5, 0.5, 0.5]) if normalize else [1, 1, 1], dtype=np.float32
        )
        self.tokenizer = AutoTokenizer.from_pretrained(folder)

    def pixels(self, image: Any) -> np.ndarray:
        pil = image if isinstance(image, Image.Image) else Image.fromarray(np.asarray(image, dtype=np.uint8))
        pil = pil.convert("RGB").resize((self.width, self.height), resample=self.resample)
        array = np.asarray(pil, dtype=np.float32) * self.rescale
        array = (array - self.mean) / self.std
        return array.transpose(2, 0, 1)[None].astype(np.float32)

    def input_ids(self, text: str) -> np.ndarray:
        tokens = self.tokenizer(
            [text], padding="max_length", max_length=TEXT_TOKENS, truncation=True, return_tensors="np"
        )
        return np.asarray(tokens["input_ids"], dtype=np.int64)


async def ensure_processor(manager: BaseModelManager, base_url: str, family: str) -> str:
    """Downloads the family's processor files next to its towers; returns their folder."""
    for name in PROCESSOR_FILES:
        await manager._download(f"{base_url}/{family}/{name}", f"{family}/{name}")  # noqa: SLF001
    return os.path.join(manager.model_path, family)


def _unit(vector: np.ndarray) -> list[float]:
    flat = np.asarray(vector, dtype=np.float32).reshape(-1)
    norm = float(np.linalg.norm(flat))
    return [float(v) for v in (flat / norm if norm > 0 else flat)]


class SiglipEncoder(ClipEncoder):
    def __init__(
        self, manager: BaseModelManager, logger: LoggerService, *, embedding_model: str, base_url: str
    ) -> None:
        super().__init__(manager, logger, embedding_model=embedding_model)
        self.base_url = base_url

    async def embed_image(self, image: Any) -> list[float]:
        if not self._ready():
            return []
        assert self.vision is not None
        pixels = await asyncio.to_thread(self.processor.pixels, image)
        outputs = await self.vision.infer([pixels])
        return _unit(outputs[0])

    async def embed_text(self, text: str) -> list[float]:
        if not self._ready():
            return []
        assert self.text is not None
        ids = await asyncio.to_thread(self.processor.input_ids, text)
        outputs = await self.text.infer([ids])
        return _unit(outputs[0])

    async def _do_initialize(self, vision_model: str, text_model: str) -> None:
        try:
            self.logger.log(f"Loading SigLIP: {vision_model} + {text_model}...")
            started = time.monotonic()
            self.vision = await self.manager.ensure_backend(vision_model)
            self.text = await self.manager.ensure_backend(text_model)
            folder = await ensure_processor(self.manager, self.base_url, self.embedding_model)
            self.processor = await asyncio.to_thread(SiglipPreprocessor, folder)
            if self.closed:
                return
            self.load_ms = round((time.monotonic() - started) * 1000)
            self.vision_model = vision_model
            self.text_model = text_model
            self.initialized = True
            self.logger.success(f"Loaded SigLIP: {vision_model} + {text_model}")
        except Exception as error:
            self.logger.error(f"Failed to initialize SigLIP encoder: {error}")
            raise
        finally:
            self._init_task = None
