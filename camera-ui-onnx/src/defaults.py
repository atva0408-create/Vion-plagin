from __future__ import annotations

import os
from dataclasses import dataclass

from camera_ui_ml import Normalize

# flipped to True by the legacy sibling plugin's sync script
LEGACY_RUNTIME = False

model_version = "v1"

# formats of the store's modules this plugin loads (modules.py); the server learns them from the package
# keywords "vion-module-<backend>" in package.json, keep both in step
MODULE_BACKENDS: tuple[str, ...] = ("onnx",)

# ViON models mirror (deploy/models-mirror in VIONN-); VION_MODELS_HOST points to another one
_MODELS_HOST = os.environ.get("VION_MODELS_HOST", "https://models.vionvision.tech").rstrip("/")
MODEL_BASE_URL = f"{_MODELS_HOST}/{model_version}/onnx"
MODEL_LFS_URL = MODEL_BASE_URL

OBJECT_MODELS: dict[str, int] = {
    "yolo-v9-t-320": 320,
    "yolo-v9-s-320": 320,
    "yolo-v9-m-320": 320,
    "yolo-v9-c-320": 320,
}

FACE_DETECTOR_MODELS: dict[str, int] = {
    "yolo-v9-t-320-faces": 320,
    "yolo-v9-s-320-faces": 320,
    "yolo-v9-m-320-faces": 320,
    "yolo-v9-t-640-faces": 640,
    "yolo-v9-s-640-faces": 640,
    "yolo-v9-m-640-faces": 640,
}

LPD_DETECTOR_MODELS: dict[str, int] = {
    "yolo-v9-t-256-license-plates": 256,
    "yolo-v9-t-384-license-plates": 384,
    "yolo-v9-t-416-license-plates": 416,
    "yolo-v9-t-512-license-plates": 512,
    "yolo-v9-t-640-license-plates": 640,
    "yolo-v9-s-608-license-plates": 608,
}

CLIP_VISION_MODELS: dict[str, int] = {
    "clip-vit-base-patch32-vision": 224,
    "clip-vit-base-patch32-datacomp-vision": 224,
    # multilingual (Russian and ~100 more languages): queries need no translation
    "siglip-base-patch16-256-multilingual-vision": 256,
}

CLIP_TEXT_MODELS: dict[str, int] = {
    "clip-vit-base-patch32-text": 77,
    "clip-vit-base-patch32-datacomp-text": 77,
    "siglip-base-patch16-256-multilingual-text": 64,
}


@dataclass(frozen=True)
class FaceEmbedderSpec:
    """How a recognition head wants its crop. The key it is stored under names
    the vector space, which is what the NVR keys enrolled faces by, so it
    changes whenever the preprocessing changes, not only the weights."""

    model: str
    size: int
    normalize: Normalize
    aligned: bool


FACE_EMBEDDERS: dict[str, FaceEmbedderSpec] = {
    # the suffixes name the crop, not the weights: both heads see a padded face
    # box now, where they used to get the detector's tight box, and that alone
    # makes the vectors incomparable to the ones already stored
    "facenet-inceptionresnetv1-512-padded": FaceEmbedderSpec(
        "facenet-inceptionresnetv1-512", 160, "facenet", False
    ),
    "arcface-r100-512-aligned": FaceEmbedderSpec("arcface-r100-512", 112, "arcface", True),
}

FACE_EMBEDDER_MODELS: list[str] = list(FACE_EMBEDDERS)

FACE_LANDMARK_MODEL = "yunet-256-face-landmarks"
FACE_LANDMARK_INPUT_SIZE = 256

# the padded face crop the server sends; the landmark model takes it from there
FACE_EMBEDDER_CROP_SIZE = 256

OCR_MODELS: list[str] = [
    "cct-xs-v2-global",
    "cct-s-v2-global",
]

DEFAULT_OBJECT_MODEL = "yolo-v9-s-320"

DEFAULT_FACE_DETECTOR = "yolo-v9-s-320-faces"
DEFAULT_FACE_EMBEDDER = "arcface-r100-512-aligned"

DEFAULT_LPD_DETECTOR = "yolo-v9-t-384-license-plates"
DEFAULT_OCR = "cct-xs-v2-global"

DEFAULT_CLIP_VISION = "clip-vit-base-patch32-vision"
DEFAULT_CLIP_TEXT = "clip-vit-base-patch32-text"
DEFAULT_CLIP_EMBEDDER = "clip-vit-base-patch32"

OCR_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_"
OCR_PAD_CHAR = "_"
OCR_MAX_SLOTS = 10
OCR_INPUT_WIDTH = 128
OCR_INPUT_HEIGHT = 64

CLIP_EMBEDDING_DIM = 512

# "auto" -> CUDA on Linux/Windows x86_64, CPU otherwise.
# "tensorrt" -> NVIDIA TensorRT EP (CUDA + CPU fallback); builds/caches an engine on first run.
EXECUTION_PROVIDERS = ["auto", "cpu", "cuda", "tensorrt"]
DEFAULT_EXECUTION_PROVIDER = "auto"

DEFAULT_OPTION = "default"


def resolve_model(name: str | None, fallback: str) -> str:
    return fallback if not name or name == DEFAULT_OPTION else name


def clip_family(vision_model: str) -> str:
    return vision_model.removesuffix("-vision")


CLIP_SCORE_BANDS: dict[str, list[float]] = {
    "clip-vit-base-patch32": [0.15, 0.38],
    "clip-vit-base-patch32-datacomp": [0.10, 0.26],
    # SigLIP cosines are lower (sigmoid loss, bias ~ -12.9, scale ~ 117: p=0.5 at ~0.11)
    "siglip-base-patch16-256-multilingual": [0.03, 0.15],
}

CLIP_MODEL_LABELS: dict[str, str] = {
    "clip-vit-base-patch32-vision": "CLIP ViT-B/32 (английские запросы)",
    "clip-vit-base-patch32-datacomp-vision": "CLIP ViT-B/32 DataComp (английские запросы)",
    "siglip-base-patch16-256-multilingual-vision": "SigLIP мультиязычная (запросы на русском)",
}


def clip_score_band(family: str) -> list[float]:
    return CLIP_SCORE_BANDS.get(family, CLIP_SCORE_BANDS["clip-vit-base-patch32"])


def clip_text_for(vision_model: str) -> str:
    return f"{clip_family(vision_model)}-text"
