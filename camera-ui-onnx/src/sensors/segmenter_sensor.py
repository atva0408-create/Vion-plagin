from __future__ import annotations

from typing import TYPE_CHECKING, TypedDict

from camera_ui_ml import model_runtime, reset_stored_settings
from camera_ui_sdk import (
    JsonSchema,
    ModelSpec,
    SegmentationFrame,
    SegmentationResult,
    SegmenterSensor,
)

from defaults import DEFAULT_OPTION, DEFAULT_SEGMENTATION_MODEL, SEGMENTATION_MODELS, resolve_model
from reid import segment_objects

if TYPE_CHECKING:
    from camera_ui_sdk import LoggerService

    from main import ONNXPlugin


class SegmenterStorageValues(TypedDict):
    model: str


class ONNXSegmenterSensor(SegmenterSensor["SegmenterStorageValues"]):
    def __init__(self, plugin: ONNXPlugin, logger: LoggerService, name: str = "ONNX Segmenter") -> None:
        super().__init__(name)
        self._plugin = plugin
        self._logger = logger

    @property
    def storage_schema(self) -> list[JsonSchema]:
        return [
            {
                "type": "string",
                "key": "model",
                "title": "Модель",
                "description": "Модель, обводящая людей, транспорт и животных",
                "group": "Сегментация",
                "enum": [DEFAULT_OPTION, *SEGMENTATION_MODELS],
                "enumLabels": {DEFAULT_OPTION: "По умолчанию"},
                "store": True,
                "defaultValue": DEFAULT_OPTION,
                "required": True,
                "onSet": self._on_change_model,
            },
            {
                "type": "button",
                "key": "reset_defaults",
                "title": "Сбросить настройки",
                "description": "Сбросить все настройки к значениям по умолчанию",
                "group": "Сегментация",
                "color": "danger",
                "onSet": self._reset_settings,
            },
        ]

    @property
    def modelSpec(self) -> ModelSpec:
        size = SEGMENTATION_MODELS.get(self._model(), 320)
        return {
            "input": {"width": size, "height": size, "format": "rgb"},
            "triggerLabels": ["person", "vehicle", "animal"],
            **model_runtime((self._plugin.segmenters.get(self._model()), "segment")),
        }

    async def segmentObjects(self, frames: list[SegmentationFrame]) -> list[SegmentationResult]:
        model = self._model()
        segmenter = self._plugin.segmenters.get(model)
        if segmenter is None or not segmenter.initialized:
            # loaded when it is first needed, not at start in every plugin process
            self._plugin.prepare_segmenter(model)
            return [{} for _ in frames]
        return await segment_objects(segmenter, frames)

    async def destroy(self) -> None:
        pass

    async def on_start(self) -> None:
        self.updateModelSpec()

    async def _on_change_model(self, new_model: str, _old_model: str) -> None:
        if new_model != _old_model:
            # the new model loads when it is first needed
            self.updateModelSpec()
            self._logger.log(
                f"Модель сегментации изменена на {resolve_model(new_model, DEFAULT_SEGMENTATION_MODEL)}"
            )

    async def _reset_settings(self) -> None:
        await reset_stored_settings(self.storage)
        self._logger.log("Настройки сброшены к значениям по умолчанию")

    def _model(self) -> str:
        return resolve_model(self.storage.values.get("model"), DEFAULT_SEGMENTATION_MODEL)
