"""Attributes of detected objects ("person · с пакетом": да / нет) by the classifiers trained on ViON Cloud.

The server crops every object whose label is in ``triggerLabels`` and passes the crops here with the
label (``frame["label"]``); each crop goes through the classifiers trained for that label. The answers
become event attributes: type = the attribute ("с пакетом"), label = "с пакетом: да" / "с пакетом: нет".

With «Поза людей» on (the setting ``pose``) every person crop also gets its posture (pose.py): type "поза",
label "поза: стоит" / "поза: сидит" / "поза: лежит". It lives here, not in a sensor of its own: the server takes one
classifier sensor of a plugin on a camera.

Kept identical in camera-ui-onnx and camera-ui-openvino (only the plugin type differs).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from camera_ui_ml import InputSpec, frame_to_rgb, model_runtime
from camera_ui_sdk import (
    ClassifierDetection,
    ClassifierDetectorSensor,
    ClassifierResult,
    JsonSchema,
    ModelSpec,
    VideoFrameData,
)

from pose import POSE_MODEL
from trained import trained_models, yes_probability

if TYPE_CHECKING:
    from camera_ui_sdk import CameraDevice, LoggerService

# below this the classifier is not sure either way: no attribute is reported
MIN_CONFIDENCE = 0.6
DEFAULT_INPUT = 224
# a person crop of this size keeps the limbs the pose model needs (its input is 192x256)
POSE_INPUT = 256
POSE_LABEL = "person"


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
        return [
            {
                "type": "boolean",
                "key": "pose",
                "title": "Поза людей",
                "description": "Определять, стоит, сидит или лежит человек, по рамкам людей обнаружения объектов. "
                "Ответ добавляется к событию признаком «поза».",
                "group": "Признаки",
                "store": True,
                "defaultValue": False,
                "onSet": self._on_change_pose,
            },
        ]

    def _pose_on(self) -> bool:
        # before the sensor has its settings: off, as stored by default
        if getattr(self, "_storage", None) is None:
            return False
        return self.storage.values.get("pose") is True

    async def _on_change_pose(self, new_value: bool, old_value: bool) -> None:
        if bool(new_value) == bool(old_value):
            return
        self.updateModelSpec()
        if new_value:
            self._plugin.prepare_pose_estimator()
        self._logger.log(f"Поза людей {'включена' if new_value else 'выключена'}")

    def _trigger_labels(self) -> list[str]:
        labels = trained_models.trigger_labels(self._camera.id)
        if self._pose_on() and POSE_LABEL not in labels:
            labels = [*labels, POSE_LABEL]
        return labels

    @property
    def modelSpec(self) -> ModelSpec:
        # only what works on this camera: a module the owner turned on elsewhere triggers nothing here
        self._labels = self._trigger_labels()
        size = max(
            (int(e.get("imgsz") or DEFAULT_INPUT) for e in trained_models.attributes(self._camera.id)),
            default=DEFAULT_INPUT,
        )
        spec: dict[str, Any] = {
            "input": {"width": size, "height": size, "format": "rgb"},
            # no classifier published and the pose off: nothing triggers this sensor
            "triggerLabels": self._labels,
        }
        if self._pose_on():
            spec["input"] = {"width": max(size, POSE_INPUT), "height": max(size, POSE_INPUT), "format": "rgb"}
            # the server shows the pose model loaded, waiting for the first person, or failed with why
            estimator = self._plugin.pose_estimators.get(POSE_MODEL)
            spec.update(self._plugin.load_state(model_runtime((estimator, "pose")), POSE_MODEL))
        return spec  # type: ignore[return-value]

    def refresh(self) -> None:
        """Called by the plugin when the manifest changed: new classes of objects to classify."""
        if self._trigger_labels() != self._labels:
            self.updateModelSpec()

    async def detectClassifications(self, frames: list[VideoFrameData]) -> list[ClassifierResult]:
        entries = trained_models.attributes(self._camera.id)
        pose = self._pose_on()
        results: list[ClassifierResult] = []
        for frame in frames:
            label = frame.get("label")
            wanted = [e for e in entries if e["label"] == label] if label else []
            posed = pose and label == POSE_LABEL
            detections: list[ClassifierDetection] = []
            if wanted or posed:
                rgb = frame_to_rgb(frame["data"], frame["width"], frame["height"], frame["format"])
                if posed:
                    detection = await self._posture(rgb)
                    if detection is not None:
                        detections.append(detection)
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

    async def _posture(self, rgb: Any) -> ClassifierDetection | None:
        """«поза: стоит/сидит/лежит» of one person crop; None while the model loads or when too little is seen."""
        estimator = self._plugin.pose_estimators.get(POSE_MODEL)
        if estimator is None or not estimator.initialized:
            # loaded on the first person, in the background: the crops of the first moments go without a posture
            self._plugin.prepare_pose_estimator()
            return None
        try:
            found = await estimator.estimate(rgb)
        except Exception as error:
            if POSE_MODEL not in self._failed:
                self._failed.add(POSE_MODEL)
                self._logger.error(f"Поза не определилась: {error}")
            self._plugin.pose_failed(error)
            return None
        if found is None:
            return None
        posture, sure = found
        detection: ClassifierDetection = {
            "label": POSE_LABEL,  # type: ignore[typeddict-item]
            "confidence": sure,
            "box": {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0},
            "attribute": "поза",
            "subAttribute": f"поза: {posture}",
        }
        return detection

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
