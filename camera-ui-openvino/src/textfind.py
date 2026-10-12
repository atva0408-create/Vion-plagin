"""Words in the language of the platform for models that understand English only, and words found in pictures. Kept
identical in camera-ui-onnx and camera-ui-openvino (the legacy plugins copy them).

The search by description is asked in the language of the person (Russian above all), and CLIP ViT-B/32, the default
model of both plugins, understands English only: a query in Russian found nothing. A query is put into English by
opus-mt (Marian, ONNX encoder and decoder; 0.2-0.3 s a query): from Russian whenever it has Cyrillic, whatever the
platform speaks, else from the language of the platform the search comes from, when a translator knows it.

The search in pictures shows where in the picture of an event the thing asked for is («красная сумка», «человек с
велосипедом»): OWL-ViT B/32 boxes the query, put into English the same way. Chosen on the bench (2026-10-12, public
COCO pictures, i5-8300H busy with four cameras): OWL-ViT fp32 takes 2.8-4.3 s a picture; its quantized copy is as slow
and far less sure of small things (a stop sign 0.06 against 0.40, a TV remote 0.04 against 0.17); OWLv2 took 23 s a
picture and ran out of memory. Its model (≈600 MB) loads when first asked for and leaves memory when nobody asks for a
while (main.py); a translator (≈110 MB) stays.

The models are ONNX, on the mirror under v1/onnx (OpenVINO reads them as they are): model_file names their paths.
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import re
import time
from typing import TYPE_CHECKING, Any

import numpy as np
from PIL import Image

if TYPE_CHECKING:
    from camera_ui_ml import BaseModelManager, InferenceBackend
    from camera_ui_sdk import LoggerService

OWL_MODEL = "owlvit-base-patch32"
OWL_FILES = ("tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "vocab.json", "merges.txt")
# the languages a query is put into English from, and their translators
TRANSLATORS = {"ru": "opus-mt-ru-en", "de": "opus-mt-de-en"}
TRANSLATOR_FILES = (
    "source.spm",
    "target.spm",
    "vocab.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "config.json",
)

OWL_SIZE = 768
OWL_TOKENS = 16
CLIP_MEAN = np.array([0.48145466, 0.4578275, 0.40821073], dtype=np.float32)
CLIP_STD = np.array([0.26862954, 0.26130258, 0.27577711], dtype=np.float32)
# a box is said from this score; from FOUND_SCORE it is taken for the thing (OWL-ViT's own examples use 0.1)
MIN_SCORE = 0.05
FOUND_SCORE = 0.1
BOXES_A_PICTURE = 3
# two boxes overlapping more than this are one thing
SAME_THING = 0.3
# the crop of a find: its box and this much around it, at most this many pixels a side
CROP_MARGIN = 0.15
CROP_SIDE = 320
MAX_TOKENS = 24
# the finder's model leaves memory when nobody asked for this long
IDLE_S = 300
# a search by description waits this long for a translator still loading (a call to a plugin ends after 30 s)
CLIP_TRANSLATE_WAIT_S = 15
CYRILLIC = re.compile("[а-яё]", re.IGNORECASE)
# single words a translator puts as nobody would ask a picture («человек» → "human beings")
WORDS = {"ru": {"человек": "person", "люди": "people"}}


def language_of(text: str, platform: str | None) -> str | None:
    """The language a query is put into English from: Russian whenever it has Cyrillic, whatever the platform speaks;
    else the platform's language (a BCP 47 tag) when a translator knows it; nothing for English."""
    if CYRILLIC.search(text):
        return "ru"
    language = (platform or "").split("-")[0].lower()
    return language if language in TRANSLATORS else None


def model_file(model_name: str) -> str | None:
    """The path of a model of this module on the mirror and in the models folder, or nothing for another model."""
    if model_name == OWL_MODEL:
        return f"{OWL_MODEL}/{OWL_MODEL}.onnx"
    for family in TRANSLATORS.values():
        if model_name in (f"{family}-encoder", f"{family}-decoder"):
            return f"{family}/{model_name.rpartition('-')[2]}.onnx"
    return None


def tidy(english: str) -> str:
    """The translator's sentence as a query: no closing stop, lower case."""
    return english.strip().rstrip(".!").strip().lower()


def input_names(backend: Any) -> list[str] | None:
    """The names of a model's inputs in its order: ONNX's backend keeps them, OpenVINO's compiled model has them."""
    names = getattr(backend, "_input_names", None)
    if names:
        return list(names)
    compiled = getattr(backend, "_compiled", None)
    if compiled is not None:
        return [port.get_any_name() for port in compiled.inputs]
    return None


def ordered(backend: Any, named: dict[str, Any]) -> list[Any]:
    """The inputs in the order of the model's own (both backends feed a list by position)."""
    names = input_names(backend) or list(named)
    return [named[name] for name in names]


def pixels(image: Image.Image) -> np.ndarray:
    """OWL-ViT's input: the picture stretched to a square of OWL_SIZE (bicubic), CLIP's mean and deviation."""
    x = (
        np.asarray(
            image.convert("RGB").resize((OWL_SIZE, OWL_SIZE), Image.Resampling.BICUBIC), dtype=np.float32
        )
        / 255
    )
    return ((x - CLIP_MEAN) / CLIP_STD).transpose(2, 0, 1)[None].astype(np.float32)


def boxes_of(logits: np.ndarray, pred_boxes: np.ndarray) -> list[dict[str, float]]:
    """The best boxes of one query in one picture: OWL's logits (one per patch) and boxes (cx, cy, w, h of the square,
    which is the picture stretched), as shares of the picture from MIN_SCORE, overlapping ones taken once."""
    scores = 1 / (1 + np.exp(-np.asarray(logits, dtype=np.float64)))
    found: list[dict[str, float]] = []
    for index in np.argsort(-scores):
        score = float(scores[index])
        if score < MIN_SCORE or len(found) == BOXES_A_PICTURE:
            break
        cx, cy, w, h = (float(v) for v in pred_boxes[index])
        x0, y0 = max(0.0, cx - w / 2), max(0.0, cy - h / 2)
        x1, y1 = min(1.0, cx + w / 2), min(1.0, cy + h / 2)
        if x1 <= x0 or y1 <= y0:
            continue
        box = {"x": x0, "y": y0, "width": x1 - x0, "height": y1 - y0, "score": round(score, 3)}
        if all(iou(box, other) <= SAME_THING for other in found):
            found.append(box)
    return found


def iou(a: dict[str, float], b: dict[str, float]) -> float:
    ix = max(0.0, min(a["x"] + a["width"], b["x"] + b["width"]) - max(a["x"], b["x"]))
    iy = max(0.0, min(a["y"] + a["height"], b["y"] + b["height"]) - max(a["y"], b["y"]))
    inter = ix * iy
    union = a["width"] * a["height"] + b["width"] * b["height"] - inter
    return inter / union if union > 0 else 0.0


def crop_of(image: Image.Image, box: dict[str, float]) -> bytes:
    """A JPEG of the find with some of what is around it, to be seen on a card."""
    width, height = image.size
    mx, my = box["width"] * CROP_MARGIN, box["height"] * CROP_MARGIN
    # rounded, not floored: 0.43 of 1000 is 430.00000000000006
    left = max(0, round((box["x"] - mx) * width))
    top = max(0, round((box["y"] - my) * height))
    right = min(width, round((box["x"] + box["width"] + mx) * width))
    bottom = min(height, round((box["y"] + box["height"] + my) * height))
    piece = image.convert("RGB").crop((left, top, max(right, left + 1), max(bottom, top + 1)))
    piece.thumbnail((CROP_SIDE, CROP_SIDE), Image.Resampling.BILINEAR)
    out = io.BytesIO()
    piece.save(out, format="JPEG", quality=85)
    return out.getvalue()


class _Loaded:
    """Something loaded once, by whoever asks first; a failed load is tried again by the next."""

    def __init__(self) -> None:
        self.initialized = False
        self._init_task: asyncio.Task[None] | None = None

    async def initialize(self) -> None:
        if self.initialized:
            return
        if self._init_task is None:
            self._init_task = asyncio.create_task(self._load())
        task = self._init_task
        try:
            await task
        finally:
            if self._init_task is task and task.done() and task.exception() is not None:
                self._init_task = None

    @property
    def loading(self) -> bool:
        return self._init_task is not None and not self._init_task.done()

    async def _load(self) -> None:
        raise NotImplementedError


class Translator(_Loaded):
    """One language into English (opus-mt-<language>-en)."""

    def __init__(
        self, manager: BaseModelManager, logger: LoggerService, *, base_url: str, language: str
    ) -> None:
        super().__init__()
        self.manager = manager
        self.logger = logger
        self.base_url = base_url
        self.language = language
        self.family = TRANSLATORS[language]
        self.encoder: InferenceBackend | None = None
        self.decoder: InferenceBackend | None = None
        self.tokenizer: Any = None
        self.config: dict[str, Any] = {}

    async def _load(self) -> None:
        from transformers import AutoTokenizer

        started = time.monotonic()
        self.logger.log(f"Loading the translator {self.family}...")
        for name in TRANSLATOR_FILES:
            await self.manager._download(f"{self.base_url}/{self.family}/{name}", f"{self.family}/{name}")  # noqa: SLF001
        self.encoder = await self.manager.ensure_backend(f"{self.family}-encoder")
        self.decoder = await self.manager.ensure_backend(f"{self.family}-decoder")
        folder = os.path.join(self.manager.model_path, self.family)
        self.tokenizer = await asyncio.to_thread(AutoTokenizer.from_pretrained, folder)
        with open(os.path.join(folder, "config.json"), encoding="utf-8") as handle:
            self.config = json.load(handle)
        self.initialized = True
        self.logger.success(f"Loaded the translator {self.family} in {time.monotonic() - started:.1f} s")

    async def english(self, text: str) -> str:
        """Greedy, the decoder given its whole output each step: a query is a few words."""
        known = WORDS.get(self.language, {}).get(text.lower())
        if known:
            return known
        assert self.encoder is not None and self.decoder is not None
        encoded = await asyncio.to_thread(self.tokenizer, text, return_tensors="np")
        ids = np.asarray(encoded["input_ids"], dtype=np.int64)
        mask = np.asarray(encoded["attention_mask"], dtype=np.int64)
        hidden = (
            await self.encoder.infer(ordered(self.encoder, {"input_ids": ids, "attention_mask": mask}))
        )[0]
        config = self.config
        out = [int(config["decoder_start_token_id"])]
        for _ in range(MAX_TOKENS):
            named = {
                "input_ids": np.array([out], dtype=np.int64),
                "encoder_hidden_states": hidden,
                "encoder_attention_mask": mask,
            }
            logits = np.array(
                (await self.decoder.infer(ordered(self.decoder, named)))[0][0, -1], dtype=np.float32
            )
            # the pad token opens every output and closes nothing
            logits[int(config["pad_token_id"])] = -np.inf
            token = int(logits.argmax())
            if token == int(config["eos_token_id"]):
                break
            out.append(token)
        return tidy(self.tokenizer.decode(out[1:], skip_special_tokens=True))


class Translators:
    """The translators of a plugin, one a language, loaded when first needed and kept."""

    def __init__(self, manager: BaseModelManager, logger: LoggerService, *, base_url: str) -> None:
        self.manager = manager
        self.logger = logger
        self.base_url = base_url
        self.by_language: dict[str, Translator] = {}

    def of(self, language: str) -> Translator:
        translator = self.by_language.get(language)
        if translator is None:
            translator = Translator(self.manager, self.logger, base_url=self.base_url, language=language)
            self.by_language[language] = translator
        return translator

    def ready(self, language: str | None) -> bool:
        return language is None or self.of(language).initialized

    def load(self, language: str | None) -> asyncio.Task[None] | None:
        """Loads the translator of `language` in the background (nothing to load for English)."""
        if language is None or self.of(language).initialized:
            return None
        return asyncio.ensure_future(self.of(language).initialize())

    async def english(self, text: str, platform: str | None, *, wait: float | None = None) -> str:
        """`text` in English. A translator not loaded yet is waited for `wait` seconds at most (a call may take only so
        long; nothing is the whole load): past it the query goes as it is, the translator loading on."""
        query = text.strip()
        language = language_of(query, platform)
        if language is None:
            return query
        translator = self.of(language)
        if not translator.initialized:
            load = asyncio.ensure_future(translator.initialize())
            if wait is None:
                await load
            else:
                try:
                    await asyncio.wait_for(asyncio.shield(load), wait)
                except TimeoutError:
                    self.logger.log(
                        f"The translator {translator.family} still loads: «{query}» searched as it is"
                    )
                    return query
        return await translator.english(query)

    def close(self) -> None:
        for translator in self.by_language.values():
            for backend in (translator.encoder, translator.decoder):
                if backend is not None:
                    backend.close()
            forget = getattr(self.manager, "forget", None)
            if forget is not None:
                for name in (f"{translator.family}-encoder", f"{translator.family}-decoder"):
                    forget(name)
        self.by_language.clear()


class TextFinder(_Loaded):
    def __init__(
        self, manager: BaseModelManager, logger: LoggerService, *, base_url: str, translators: Translators
    ) -> None:
        super().__init__()
        self.manager = manager
        self.logger = logger
        self.base_url = base_url
        self.translators = translators
        self.owl: InferenceBackend | None = None
        self.owl_tokenizer: Any = None
        self.last_used = time.monotonic()
        # finds under way: the model is not closed under them
        self.busy = 0

    async def _load(self) -> None:
        from transformers import AutoTokenizer

        started = time.monotonic()
        self.logger.log(f"Loading the text finder: {OWL_MODEL}...")
        for name in OWL_FILES:
            await self.manager._download(f"{self.base_url}/{OWL_MODEL}/{name}", f"{OWL_MODEL}/{name}")  # noqa: SLF001
        self.owl = await self.manager.ensure_backend(OWL_MODEL)
        folder = os.path.join(self.manager.model_path, OWL_MODEL)
        self.owl_tokenizer = await asyncio.to_thread(AutoTokenizer.from_pretrained, folder)
        self.initialized = True
        self.logger.success(f"Loaded the text finder in {time.monotonic() - started:.1f} s")

    async def find(self, text: str, images: list[Image.Image], platform: str | None = None) -> dict[str, Any]:
        """Where `text` is in each picture: the query as asked of OWL, and per picture its boxes (best first) with the
        crop of the best one when it is taken for the thing."""
        self.last_used = time.monotonic()
        self.busy += 1
        try:
            return await self._find(text, images, platform)
        finally:
            self.busy -= 1
            self.last_used = time.monotonic()

    def idle(self, now: float) -> bool:
        return self.busy == 0 and now - self.last_used >= IDLE_S

    async def _find(self, text: str, images: list[Image.Image], platform: str | None) -> dict[str, Any]:
        assert self.owl is not None
        query = await self.translators.english(text, platform)
        tokens = await asyncio.to_thread(
            self.owl_tokenizer,
            [f"a photo of {query}"],
            padding="max_length",
            max_length=OWL_TOKENS,
            truncation=True,
            return_tensors="np",
        )
        ids = np.asarray(tokens["input_ids"], dtype=np.int64)
        mask = np.asarray(tokens["attention_mask"], dtype=np.int64)
        pictures: list[dict[str, Any]] = []
        for image in images:
            x = await asyncio.to_thread(pixels, image)
            outputs = await self.owl.infer(
                ordered(self.owl, {"input_ids": ids, "pixel_values": x, "attention_mask": mask})
            )
            # logits [1, patches, queries], pred_boxes [1, patches, 4]: the outputs come in the model's order
            boxes = boxes_of(outputs[0][0][:, 0], outputs[1][0])
            found = bool(boxes) and boxes[0]["score"] >= FOUND_SCORE
            pictures.append(
                {
                    "boxes": boxes,
                    **({"crop": await asyncio.to_thread(crop_of, image, boxes[0])} if found else {}),
                }
            )
        return {"query": query, "foundScore": FOUND_SCORE, "pictures": pictures}

    def close(self) -> None:
        """Out of memory: the model closed, the manager to load it anew when asked again (the translators stay)."""
        if self.owl is not None:
            self.owl.close()
        forget = getattr(self.manager, "forget", None)
        if forget is not None:
            forget(OWL_MODEL)
        self.owl = None
        self.initialized = False
        self._init_task = None
