"""The object sensor of the ONNX and OpenVINO plugins when the camera's model fails to load.

A broken module version after a reload of the models (a changed provider, «Скачать модели заново») left the camera
with no detector at all: every frame answered «nothing found» until the next try ten minutes later. The real
``detectObjects`` of both sensors runs here on fake detectors: the standard model detects meanwhile, as on start.

    python -m pytest camera-ui-onnx/tests/test_object_fallback.py
"""

from __future__ import annotations

import ast
import asyncio
import types
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[2]
DEFAULT = "yolo-v9-s-320"
MODULE = "vion-module-bikes"


class Detector:
    def __init__(self, label: str, initialized: bool = True) -> None:
        self.label = label
        self.initialized = initialized


class Plugin:
    def __init__(self) -> None:
        self.object_detectors: dict[str, Detector] = {}
        self.failed: set[str] = set()
        self.prepared: list[str] = []

    def check_trained_models(self) -> None:
        pass

    def prepare_object_detector(self, name: str) -> None:
        self.prepared.append(name)

    def model_failed(self, name: str) -> bool:
        return name in self.failed


async def detect_objects(detector: Detector, _frame: Any, _confidences: Any) -> dict[str, Any]:
    return {"detected": True, "detections": [{"label": detector.label}]}


@pytest.fixture(params=["onnx", "openvino"])
def sensor(request: pytest.FixtureRequest) -> Any:
    path = ROOT / f"camera-ui-{request.param}" / "src" / "sensors" / "object_sensor.py"
    tree = ast.parse(path.read_text(encoding="utf-8"))
    cls = next(
        node for node in tree.body if isinstance(node, ast.ClassDef) and node.name.endswith("ObjectSensor")
    )
    cls.bases = []
    cls.decorator_list = []
    cls.body = [
        node for node in cls.body if isinstance(node, ast.AsyncFunctionDef) and node.name == "detectObjects"
    ]
    namespace: dict[str, Any] = {
        "DEFAULT_OBJECT_MODEL": DEFAULT,
        "detect_objects": detect_objects,
        "trained_models": types.SimpleNamespace(module_detectors=lambda _camera: []),
        "model_name": lambda entry: entry,
    }
    module = ast.Module(
        body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), cls],
        type_ignores=[],
    )
    exec(compile(ast.fix_missing_locations(module), str(path), "exec"), namespace)
    instance = object.__new__(namespace[cls.name])
    instance._plugin = Plugin()
    instance._active_model = MODULE
    instance._wanted = MODULE
    instance._wanted_model = lambda: instance._wanted
    instance._camera = types.SimpleNamespace(id="xiaomi")
    instance._camera_confidences = lambda _default: {}
    instance.spec_updates = 0

    def update_model_spec() -> None:
        instance.spec_updates += 1

    instance.updateModelSpec = update_model_spec
    instance.errors = []
    instance._logger = types.SimpleNamespace(log=lambda _m: None, error=instance.errors.append)
    return instance


def test_a_failed_model_leaves_the_camera_on_the_standard_one(sensor: Any) -> None:
    sensor._plugin.failed.add(MODULE)
    sensor._plugin.object_detectors[DEFAULT] = Detector("standard")
    result = asyncio.run(sensor.detectObjects(None))
    assert result["detections"] == [{"label": "standard"}]
    assert sensor._active_model == DEFAULT
    assert sensor.spec_updates == 1
    assert sensor.errors and MODULE in sensor.errors[0]
    # the next frames stay on it without saying it again, and the module is still asked for
    result = asyncio.run(sensor.detectObjects(None))
    assert result["detections"] == [{"label": "standard"}]
    assert len(sensor.errors) == 1
    assert sensor._plugin.prepared.count(MODULE) == 2


def test_the_standard_model_is_loaded_when_it_is_not_there_yet(sensor: Any) -> None:
    sensor._plugin.failed.add(MODULE)
    result = asyncio.run(sensor.detectObjects(None))
    assert result == {"detected": False, "detections": []}
    assert sensor._plugin.prepared == [MODULE, DEFAULT]


def test_a_model_still_loading_is_waited_for_not_replaced(sensor: Any) -> None:
    # not failed: a newly published version is loading in the background
    sensor._plugin.object_detectors[DEFAULT] = Detector("standard")
    result = asyncio.run(sensor.detectObjects(None))
    assert result == {"detected": False, "detections": []}
    assert sensor._active_model == MODULE
    assert sensor._plugin.prepared == [MODULE]


def test_the_camera_goes_back_to_its_model_once_it_loads(sensor: Any) -> None:
    sensor._plugin.failed.add(MODULE)
    sensor._plugin.object_detectors[DEFAULT] = Detector("standard")
    asyncio.run(sensor.detectObjects(None))
    sensor._plugin.failed.clear()
    sensor._plugin.object_detectors[MODULE] = Detector("bikes")
    result = asyncio.run(sensor.detectObjects(None))
    assert result["detections"] == [{"label": "bikes"}]
    assert sensor._active_model == MODULE
