"""Attributes of detected objects ("person · с пакетом": да / нет) by the classifiers trained on ViON Cloud.

The server crops every object whose label is in ``triggerLabels`` and passes the crops here with the
label (``frame["label"]``); each crop goes through the classifiers trained for that label. The answers
become event attributes: type = the attribute ("с пакетом"), label = "с пакетом: да" / "с пакетом: нет".

Kept identical in camera-ui-onnx and camera-ui-openvino (only the plugin type differs).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from camera_ui_ml import InputSpec, frame_to_rgb
from camera_ui_sdk import (
    ClassifierDetection,
    ClassifierDetectorSensor,
    ClassifierResult,
    JsonSchema,
    ModelSpec,
    VideoFrameData,
)

from trained import trained_models, yes_probability

if TYPE_CHECKING:
    from camera_ui_sdk import CameraDevice, LoggerService

# below this the classifier is not sure either way: no attribute is reported
MIN_CONFIDENCE = 0.6
DEFAULT_INPUT = 224


class ViONAttributeSensor(ClassifierDetectorSensor[dict[str, Any]]):
    def __init__(
        self, plugin: Any, camera: CameraDevice, logger: LoggerService, name: str = "ViON: признаки"
    ) -> None:
        super().__init__(name)
        self._camera = camera
        self._plugin = plugin
        self._logger = logger
        self._labels: list[str] = []
        self._failed: set[str] = set()

    @property
    def storage_schema(self) -> list[JsonSchema]:
        return []

    @property
    def modelSpec(self) -> ModelSpec:
        # only what works on this camera: a module the owner turned on elsewhere triggers nothing here
        self._labels = trained_models.trigger_labels(self._camera.id)
        size = max(
            (int(e.get("imgsz") or DEFAULT_INPUT) for e in trained_models.attributes(self._camera.id)),
            default=DEFAULT_INPUT,
        )
        return {
            "input": {"width": size, "height": size, "format": "rgb"},
            # no classifier published: nothing triggers this sensor
            "triggerLabels": self._labels,  # type: ignore[typeddict-item]
        }

    def refresh(self) -> None:
        """Called by the plugin when the manifest changed: new classes of objects to classify."""
        if trained_models.trigger_labels(self._camera.id) != self._labels:
            self.updateModelSpec()

    async def detectClassifications(self, frames: list[VideoFrameData]) -> list[ClassifierResult]:
        entries = trained_models.attributes(self._camera.id)
        results: list[ClassifierResult] = []
        for frame in frames:
            label = frame.get("label")
            wanted = [e for e in entries if e["label"] == label] if label else []
            detections: list[ClassifierDetection] = []
            if wanted:
                rgb = frame_to_rgb(frame["data"], frame["width"], frame["height"], frame["format"])
                for entry in wanted:
                    answer = await self._classify(entry, rgb)
                    if answer is None:
                        continue
                    confidence = max(answer, 1.0 - answer)
                    if confidence < MIN_CONFIDENCE:
                        continue
                    name = str(entry["attribute"])
                    detections.append(
                        {
                            "label": label,  # type: ignore[typeddict-item]
                            "confidence": confidence,
                            "box": {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0},
                            "attribute": name,
                            "subAttribute": f"{name}: {'да' if answer >= 0.5 else 'нет'}",
                        }
                    )
            results.append({"detected": bool(detections), "detections": detections})
        return results

    async def _classify(self, entry: dict[str, Any], rgb: Any) -> float | None:
        """P("yes") for one crop, None when the classifier cannot run (logged once)."""
        try:
            backend = await self._plugin.get_attribute_backend(entry)
            size = int(entry.get("imgsz") or DEFAULT_INPUT)
            outputs = await backend.run(rgb, InputSpec(size, size, layout="nchw", normalize="unit"))
            return yes_probability(outputs[0], entry.get("classes"))
        except Exception as error:
            if entry["id"] not in self._failed:
                self._failed.add(entry["id"])
                self._logger.error(f"Классификатор признака «{entry['attribute']}» не запустился: {error}")
            return None

    async def destroy(self) -> None:
        pass
