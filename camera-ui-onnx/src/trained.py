"""Models trained on ViON Cloud: the detector fine-tuned on the owners' checked frames and the attribute
classifiers ("person · с пакетом": yes / no).

The ViON server downloads the published ones into VION_TRAINED_MODELS_DIR and keeps ``manifest.json``
there (server/src/manager/trainedModels.ts). The plugin reads the manifest while it runs, so a new model
takes over without a restart and an empty manifest puts the cameras back on the stock models.

Kept identical in camera-ui-onnx and camera-ui-openvino.
"""

from __future__ import annotations

import json
import os
import time
from typing import Any

TRAINED_PREFIX = "vion-trained-"
# the manifest changes a few times a week at most: checking its mtime every few seconds is plenty
_CHECK_EVERY_S = 5.0
# labels an upstream object detector emits that can trigger a classifier (SDK DetectionLabel)
TRIGGER_LABELS = ("person", "vehicle", "animal")


def is_trained(model_name: str) -> bool:
    return model_name.startswith(TRAINED_PREFIX)


def model_name(entry: dict[str, Any]) -> str:
    return f"{TRAINED_PREFIX}{entry['id']}"


class TrainedModels:
    def __init__(self, directory: str | None = None) -> None:
        self.dir = os.environ.get("VION_TRAINED_MODELS_DIR", "") if directory is None else directory
        self._checked = -_CHECK_EVERY_S
        self._mtime: float | None = None
        self._manifest: dict[str, Any] = {}
        self.version = 0
        """bumps whenever the manifest content changes"""

    def manifest(self) -> dict[str, Any]:
        now = time.monotonic()
        if not self.dir or now - self._checked < _CHECK_EVERY_S:
            return self._manifest
        self._checked = now
        path = os.path.join(self.dir, "manifest.json")
        try:
            mtime = os.stat(path).st_mtime
        except OSError:
            if self._manifest:
                self._manifest = {}
                self._mtime = None
                self.version += 1
            return self._manifest
        if mtime != self._mtime:
            try:
                with open(path, encoding="utf-8") as handle:
                    data = json.load(handle)
            except (OSError, ValueError):
                return self._manifest  # being replaced right now: keep the previous one
            self._mtime = mtime
            self._manifest = data if isinstance(data, dict) else {}
            self.version += 1
        return self._manifest

    def detector(self) -> dict[str, Any] | None:
        entry = self.manifest().get("detector")
        return entry if _usable(entry) else None

    def detector_name(self) -> str | None:
        entry = self.detector()
        return model_name(entry) if entry else None

    def attributes(self) -> list[dict[str, Any]]:
        entries = self.manifest().get("attributes") or []
        return [e for e in entries if _usable(e) and e.get("label") and e.get("attribute")]

    def trigger_labels(self) -> list[str]:
        return sorted({e["label"] for e in self.attributes() if e["label"] in TRIGGER_LABELS})

    def entry(self, name: str) -> dict[str, Any] | None:
        """The manifest entry of a ``vion-trained-<id>`` model name."""
        if not is_trained(name):
            return None
        model_id = name[len(TRAINED_PREFIX) :]
        manifest = self.manifest()
        for entry in [manifest.get("detector"), *(manifest.get("attributes") or [])]:
            if _usable(entry) and entry.get("id") == model_id:
                return entry
        return None

    def path(self, name: str) -> str:
        entry = self.entry(name)
        if not entry:
            raise FileNotFoundError(f"trained model {name} is not in the manifest")
        return str(entry["path"])


def _usable(entry: Any) -> bool:
    return isinstance(entry, dict) and bool(entry.get("id")) and os.path.isfile(str(entry.get("path", "")))


trained_models = TrainedModels()


def resolve_object_model(requested: str | None, fallback: str, default_option: str = "default") -> str:
    """ "По умолчанию" means the ViON-trained detector when one is published, else the stock one."""
    if not requested or requested == default_option:
        return trained_models.detector_name() or fallback
    return requested


def yes_probability(output: Any, classes: list[str] | None) -> float:
    """P("yes") of a yes/no classifier output (probabilities, or logits from another exporter)."""
    import numpy as np

    values = np.asarray(output, dtype=np.float32).reshape(-1)
    if values.size < 2:
        return float(values[0]) if values.size else 0.0
    if values.min() < 0 or values.max() > 1 or abs(float(values.sum()) - 1.0) > 0.05:
        exp = np.exp(values - values.max())
        values = exp / exp.sum()
    index = classes.index("yes") if classes and "yes" in classes else 1
    return float(values[index])
