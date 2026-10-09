from __future__ import annotations

from typing import TYPE_CHECKING

from camera_ui_ml import model_runtime
from camera_ui_sdk import (
    ModelSpec,
    PersonEmbedderSensor,
    PersonEmbeddingResult,
    VideoFrameData,
)

from defaults import PERSON_EMBEDDER_HEIGHT, PERSON_EMBEDDER_MODEL, PERSON_EMBEDDER_WIDTH
from reid import embed_persons

if TYPE_CHECKING:
    from camera_ui_sdk import LoggerService

    from main import ONNXPlugin


class ONNXPersonEmbedderSensor(PersonEmbedderSensor):
    def __init__(self, plugin: ONNXPlugin, logger: LoggerService, name: str = "ONNX Person Embedder") -> None:
        super().__init__(name)
        self._plugin = plugin
        self._logger = logger

    @property
    def modelSpec(self) -> ModelSpec:
        return {
            "input": {"width": PERSON_EMBEDDER_WIDTH, "height": PERSON_EMBEDDER_HEIGHT, "format": "rgb"},
            "triggerLabels": ["person"],
            "embeddingModel": PERSON_EMBEDDER_MODEL,
            **model_runtime((self._plugin.person_embedders.get(PERSON_EMBEDDER_MODEL), "embed")),
        }

    async def embedPersons(self, frames: list[VideoFrameData]) -> list[PersonEmbeddingResult]:
        embedder = self._plugin.person_embedders.get(PERSON_EMBEDDER_MODEL)
        if embedder is None or not embedder.initialized:
            # loaded on the first person a camera with Person Re-ID sees, not at start in every plugin process: the
            # crops of the first moments go without a vector
            self._plugin.prepare_person_embedder()
            return [{"embedding": [], "embeddingModel": PERSON_EMBEDDER_MODEL} for _ in frames]

        return await embed_persons(embedder, frames, PERSON_EMBEDDER_MODEL)

    async def destroy(self) -> None:
        pass

    async def on_start(self) -> None:
        self.updateModelSpec()
