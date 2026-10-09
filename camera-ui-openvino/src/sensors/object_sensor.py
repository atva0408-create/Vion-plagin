from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, TypedDict

from camera_ui_ml import detect_objects, model_runtime, reset_stored_settings
from camera_ui_sdk import (
    JsonSchema,
    ObjectDetectorSensor,
    ObjectModelSpec,
    ObjectResult,
    VideoFrameData,
)

from defaults import DEFAULT_OBJECT_MODEL, DEFAULT_OPTION, MODULE_BACKENDS, OBJECT_MODELS
from modules import installed_modules, usable_choice
from trained import model_name, resolve_object_model, trained_models

if TYPE_CHECKING:
    from camera_ui_sdk import CameraDevice, LoggerService

    from main import OpenVinoPlugin


class ObjectStorageValues(TypedDict):
    model: str


class OpenVinoObjectSensor(ObjectDetectorSensor["ObjectStorageValues"]):
    def __init__(
        self,
        plugin: OpenVinoPlugin,
        camera: CameraDevice,
        logger: LoggerService,
        name: str = "OpenVino Object",
    ) -> None:
        super().__init__(name)
        self._camera = camera
        self._plugin = plugin
        self._logger = logger
        self._active_model: str | None = None

    @property
    def storage_schema(self) -> list[JsonSchema]:
        return [
            self._model_schema(),
            {
                "type": "button",
                "key": "reset_defaults",
                "title": "Сбросить настройки",
                "description": "Сбросить все настройки к значениям по умолчанию",
                "group": "Обнаружение объектов",
                "color": "danger",
                "onSet": self._reset_settings,
            },
        ]

    def _model_schema(self) -> JsonSchema:
        # the stock models, then the modules added in the store (their titles from the passport)
        modules = installed_modules.choices(MODULE_BACKENDS)
        return {
            "type": "string",
            "key": "model",
            "title": "Модель",
            "description": "Модель YOLO для обнаружения объектов. «По умолчанию» — модель, обученная ViON на ваших кадрах, если она опубликована, иначе стандартная.",
            "group": "Обнаружение объектов",
            "enum": [DEFAULT_OPTION, *OBJECT_MODELS, *modules],
            "enumLabels": modules,
            "store": True,
            "defaultValue": DEFAULT_OPTION,
            "required": True,
            "onSet": self._on_change_model,
        }

    def refresh_model_choices(self) -> None:
        """A module was added or removed in the store: the model setting offers what is installed now."""
        if getattr(self, "_storage", None) is None:
            return  # not registered yet: the schema is built with the current list when it is
        task = asyncio.ensure_future(self.storage.changeSchema("model", dict(self._model_schema())))
        task.add_done_callback(self._schema_changed)

    def _schema_changed(self, task: asyncio.Future[None]) -> None:
        if not task.cancelled() and task.exception():
            self._logger.error(f"Список моделей не обновлён: {task.exception()}")

    def _wanted_model(self) -> str:
        # a module removed in the store leaves the camera on the default model, not on a missing file
        requested = usable_choice(self.storage.values.get("model"), MODULE_BACKENDS, DEFAULT_OPTION)
        return resolve_object_model(requested, DEFAULT_OBJECT_MODEL, DEFAULT_OPTION)

    @property
    def modelSpec(self) -> ObjectModelSpec:
        detector = self._plugin.object_detectors.get(self._active_model or self._wanted_model())
        width, height = detector.input_size if detector is not None and detector.initialized else (320, 320)
        return {
            "input": {"width": width, "height": height, "format": "rgb"},
            **model_runtime((detector, "detect")),
        }

    async def detectObjects(self, frame: VideoFrameData) -> ObjectResult:
        self._plugin.check_trained_models()
        wanted = self._wanted_model()
        detector = self._plugin.object_detectors.get(wanted)
        if detector is None or not detector.initialized:
            # a newly published model loads in the background; the current one keeps detecting
            self._plugin.prepare_object_detector(wanted)
            detector = self._plugin.object_detectors.get(self._active_model) if self._active_model else None
        elif wanted != self._active_model:
            previous = self._active_model
            self._active_model = wanted
            self.updateModelSpec()
            if previous:
                self._logger.log(f"Модель объектов: {previous} → {wanted}")
        if detector is None or not detector.initialized:
            return {"detected": False, "detections": []}
        confidences = self._camera_confidences(0.5)
        result = await detect_objects(detector, frame, confidences)
        # the detectors of the object modules the owner turned on for this camera add their own classes
        for entry in trained_models.module_detectors(self._camera.id):
            name = model_name(entry)
            extra = self._plugin.object_detectors.get(name)
            if extra is None or not extra.initialized:
                self._plugin.prepare_object_detector(name)
                continue
            found = await detect_objects(extra, frame, confidences)
            result["detections"].extend(found["detections"])
        result["detected"] = bool(result["detections"])
        return result

    async def destroy(self) -> None:
        pass

    async def on_start(self) -> None:
        model_name = self._wanted_model()
        try:
            await self._plugin.get_object_detector(model_name)
        except Exception as error:
            if model_name == DEFAULT_OBJECT_MODEL:
                raise
            # a broken trained model or module must not leave the camera without detection
            self._logger.error(f"Модель {model_name} не загрузилась ({error}), используется стандартная")
            model_name = DEFAULT_OBJECT_MODEL
            await self._plugin.get_object_detector(model_name)
        self._active_model = model_name
        self.updateModelSpec()
        if trained_models.detector_name() == model_name:
            self._logger.log(f"Используется модель, обученная ViON: {model_name}")

    async def _on_change_model(self, new_model: str, _old_model: str) -> None:
        if new_model != _old_model:
            requested = usable_choice(new_model, MODULE_BACKENDS, DEFAULT_OPTION)
            resolved = resolve_object_model(requested, DEFAULT_OBJECT_MODEL, DEFAULT_OPTION)
            await self._plugin.get_object_detector(resolved)
            self._active_model = resolved
            self.updateModelSpec()
            self._logger.log(f"Модель объектов изменена на {resolved}")

    async def _reset_settings(self) -> None:
        await reset_stored_settings(self.storage)
        self._logger.log("Настройки сброшены к значениям по умолчанию")

    def _camera_confidences(self, fallback: float) -> dict[str, float] | float:
        per_label = self._camera.detectionSettings["object"].get("confidences")
        if per_label:
            return {label: float(value) for label, value in per_label.items()}
        return fallback
