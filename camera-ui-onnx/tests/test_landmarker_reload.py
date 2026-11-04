"""The face landmark model goes with the others when the models are reloaded (review 2026-11-04).

Changing the execution provider or downloading the models again reloads every model but this one: _reload_models did
not load it again and _close_all did not close it, so it went on running on the old provider (and on the model file
just removed) until the plugin restarted. The real methods of every ML plugin with faces are run here, extracted from
the plugin class, with stand-ins for the models.

    python -m pytest camera-ui-onnx/tests/test_landmarker_reload.py
"""

from __future__ import annotations

import ast
import asyncio
import types
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[2]
PLUGINS = ["onnx", "openvino", "ncnn", "coreml", "onnx-legacy", "openvino-legacy"]
METHODS = {
    "_reload_models",
    "_close_all",
    "get_face_landmarker",
    "get_face_embedder",
    "_load_failed",
    "_load_succeeded",
}


class Model:
    """A loaded model: what it was made with (the provider of the moment) and whether it was closed."""

    made = 0

    def __init__(self, manager: Any, _logger: Any, **_options: Any) -> None:
        Model.made += 1
        self.provider = manager.provider
        self.closed = False

    async def initialize(self, _name: str) -> None:
        return None

    async def close(self) -> None:
        self.closed = True


def load_plugin(name: str) -> Any:
    path = ROOT / f"camera-ui-{name}" / "src" / "main.py"
    if not path.exists():
        # the legacy plugins get src/ from scripts/sync.mjs (it is not in git)
        pytest.skip(f"{path} not synced: node camera-ui-{name}/scripts/sync.mjs")
    tree = ast.parse(path.read_text(encoding="utf-8"))
    cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name.endswith("Plugin"))
    cls.bases = []
    cls.decorator_list = []
    cls.body = [
        node
        for node in cls.body
        if isinstance(node, ast.AsyncFunctionDef | ast.FunctionDef) and node.name in METHODS
    ]
    globals_: dict[str, Any] = {
        "asyncio": asyncio,
        "LandmarkDetector": Model,
        "FACE_LANDMARK_MODEL": "face-landmarks",
        "is_module": lambda _: False,
    }
    module = ast.Module(
        body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), cls],
        type_ignores=[],
    )
    exec(compile(ast.fix_missing_locations(module), str(path), "exec"), globals_)
    plugin = object.__new__(globals_[cls.name])
    plugin.logger = types.SimpleNamespace(
        error=lambda _: None, log=lambda _: None, warn=lambda _: None, success=lambda _: None
    )
    plugin.model_manager = types.SimpleNamespace(provider="CPU", reset=lambda: None)
    for collection in (
        "object_detectors",
        "face_detectors",
        "face_embedders",
        "face_landmarkers",
        "plate_detectors",
        "ocr_models",
        "clip_encoders",
        "person_embedders",
        "segmenters",
        "pose_estimators",
        "attribute_backends",
        "_sensors",
        "_failed_models",
        "_load_states",
    ):
        setattr(plugin, collection, {})
    # the parts of _close_all in ONNX and OpenVINO that are not models of a kind
    plugin._models_generation = 0
    plugin._modules_version = 0
    plugin.text_finder = None
    plugin.outliner = None
    plugin.translators = types.SimpleNamespace(close=lambda: None)
    plugin._load_failed = lambda *_: None
    plugin._load_succeeded = lambda *_: None
    return plugin


@pytest.fixture(params=PLUGINS)
def plugin(request: pytest.FixtureRequest) -> Any:
    return load_plugin(request.param)


def test_a_reload_closes_the_landmark_model_and_loads_it_again_on_the_new_provider(plugin: Any) -> None:
    async def run() -> None:
        old = await plugin.get_face_landmarker()
        assert old.provider == "CPU"
        # the execution provider changed: every model is loaded again
        plugin.model_manager.provider = "CUDA"
        await plugin._reload_models()
        new = plugin.face_landmarkers["face-landmarks"]
        assert old.closed, "the model on the old provider is closed"
        assert new is not old and new.provider == "CUDA"
        assert not new.closed

    asyncio.run(run())


def test_a_reload_loads_no_landmark_model_that_was_never_used(plugin: Any) -> None:
    async def run() -> None:
        made = Model.made
        await plugin._reload_models()
        assert plugin.face_landmarkers == {}
        assert Model.made == made

    asyncio.run(run())


def test_closing_all_closes_and_forgets_the_landmark_model(plugin: Any) -> None:
    async def run() -> None:
        model = await plugin.get_face_landmarker()
        await plugin._close_all()
        assert model.closed
        assert plugin.face_landmarkers == {}

    asyncio.run(run())
