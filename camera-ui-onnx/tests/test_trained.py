"""Models trained on ViON Cloud as the detection plugins see them (src/trained.py, kept identical in the ONNX and
OpenVINO plugins; the legacy plugins copy them): a module works only on the cameras the ViON server names for it, the
detector of an object module adds its classes next to the camera's own detector, a classifier of before modules works
on every camera (docs/TRAINING_MODULES.md 3.6).

    pip install pytest aiohttp onnxruntime numpy
    python3 -m pytest camera-ui-onnx/tests/test_trained.py
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import sys
import types
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[2]
ONNX_SRC = ROOT / "camera-ui-onnx" / "src"
OPENVINO_SRC = ROOT / "camera-ui-openvino" / "src"
SDK = Path(os.environ.get("CAMERA_UI_SDK_PYTHON", ROOT.parent / "VIONN-" / "externals" / "sdk" / "python"))


def load(path: Path, name: str) -> types.ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module


trained = load(ONNX_SRC / "trained.py", "vion_trained")


def write_manifest(directory: Path, manifest: dict[str, Any]) -> None:
    path = directory / "manifest.json"
    path.write_text(json.dumps(manifest), encoding="utf-8")
    # a new mtime even when the test writes twice within the clock's resolution
    stat = path.stat()
    os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000_000))


def model(directory: Path, model_id: str, **fields: Any) -> dict[str, Any]:
    path = directory / f"{model_id}.onnx"
    path.write_bytes(b"onnx")
    return {"id": model_id, "path": str(path), **fields}


def fresh(models: Any) -> Any:
    models._checked = float("-inf")
    return models


def test_the_plugins_carry_the_same_files():
    for name in ("trained.py", "sensors/attribute_sensor.py"):
        assert (ONNX_SRC / name).read_text(encoding="utf-8") == (OPENVINO_SRC / name).read_text(
            encoding="utf-8"
        ), name


def test_a_classifier_works_on_the_cameras_of_its_module_and_one_of_before_modules_everywhere(tmp_path: Path):
    write_manifest(
        tmp_path,
        {
            "detector": None,
            "attributes": [
                model(tmp_path, "kid", label="person", attribute="играет", cameras=["cam-2"]),
                model(tmp_path, "bag", label="person", attribute="с пакетом"),
                model(tmp_path, "taxi", label="vehicle", attribute="такси", cameras=["cam-3"]),
            ],
        },
    )
    models = fresh(trained.TrainedModels(str(tmp_path)))
    assert [e["id"] for e in models.attributes("cam-2")] == ["kid", "bag"]
    assert [e["id"] for e in fresh(models).attributes("cam-1")] == ["bag"]
    assert [e["id"] for e in fresh(models).attributes()] == ["kid", "bag", "taxi"], (
        "without a camera: every classifier"
    )
    assert fresh(models).trigger_labels("cam-3") == ["person", "vehicle"]
    assert fresh(models).trigger_labels("cam-1") == ["person"]


def test_the_detector_of_an_object_module_works_on_its_cameras_only(tmp_path: Path):
    bikes = model(
        tmp_path,
        "v-bikes",
        kind="object",
        classes=["велосипед"],
        cameras=["cam-1", "cam-4"],
        moduleId="mod_b",
    )
    gone = {
        "id": "v-gone",
        "path": str(tmp_path / "missing.onnx"),
        "kind": "object",
        "classes": ["x"],
        "cameras": ["cam-1"],
    }
    kid = model(tmp_path, "v-kid", kind="attribute", label="person", attribute="играет", cameras=["cam-1"])
    classless = model(tmp_path, "v-odd", kind="object", cameras=["cam-1"])
    write_manifest(
        tmp_path, {"detector": None, "attributes": [kid], "modules": [bikes, gone, kid, classless]}
    )
    models = fresh(trained.TrainedModels(str(tmp_path)))
    assert [e["id"] for e in models.module_detectors("cam-1")] == ["v-bikes"], (
        "a missing file, a classifier or no classes"
    )
    assert fresh(models).module_detectors("cam-2") == []
    # the plugin loads it by its model name, with its classes
    name = trained.model_name(bikes)
    assert fresh(models).entry(name)["classes"] == ["велосипед"]
    assert fresh(models).path(name) == bikes["path"]


def test_a_manifest_of_before_modules_reads_as_it_did(tmp_path: Path):
    write_manifest(
        tmp_path,
        {
            "detector": model(tmp_path, "det", classes=["person"]),
            "attributes": [model(tmp_path, "bag", label="person", attribute="с пакетом")],
        },
    )
    models = fresh(trained.TrainedModels(str(tmp_path)))
    assert models.detector_name() == "vion-trained-det"
    assert [e["id"] for e in fresh(models).attributes("any-camera")] == ["bag"]
    assert fresh(models).module_detectors("any-camera") == []


class FakeDetector:
    def __init__(
        self, labels: dict[int, str], found: list[tuple[int, float, tuple[float, float, float, float]]]
    ) -> None:
        self.labels = labels
        self.found = found
        self.initialized = True
        self.input_size = (320, 320)
        self.calls = 0

    async def detect_frame(self, frame: Any, threshold: float | None = None) -> list[Any]:
        self.calls += 1
        return self.found


def test_the_object_sensor_adds_the_boxes_of_the_modules_of_its_camera(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.syspath_prepend(str(ONNX_SRC))
    monkeypatch.syspath_prepend(str(SDK))
    monkeypatch.syspath_prepend(str(ROOT / "packages" / "camera_ui_ml"))
    for name in ("trained", "defaults", "modules", "sensors.object_sensor"):
        sys.modules.pop(name, None)
    object_sensor = importlib.import_module("sensors.object_sensor")
    trained_module = sys.modules["trained"]
    bikes = model(tmp_path, "v-bikes", kind="object", classes=["велосипед"], cameras=["cam-1"])
    cold = model(tmp_path, "v-cold", kind="object", classes=["коляска"], cameras=["cam-1"])
    write_manifest(tmp_path, {"detector": None, "attributes": [], "modules": [bikes, cold]})
    trained_module.trained_models.dir = str(tmp_path)
    fresh(trained_module.trained_models)

    main = FakeDetector({0: "person"}, [(0, 0.9, (10.0, 10.0, 50.0, 100.0))])
    module = FakeDetector({0: "велосипед"}, [(0, 0.8, (100.0, 120.0, 180.0, 200.0))])
    prepared: list[str] = []
    plugin = types.SimpleNamespace(
        object_detectors={"main": main, "vion-trained-v-bikes": module},
        check_trained_models=lambda: None,
        prepare_object_detector=prepared.append,
    )

    def sensor_for(camera_id: str) -> Any:
        sensor = object_sensor.ONNXObjectSensor(
            plugin, types.SimpleNamespace(id=camera_id), types.SimpleNamespace(log=print, error=print)
        )
        sensor._wanted_model = lambda: "main"
        sensor._active_model = "main"
        sensor._camera_confidences = lambda fallback: fallback
        return sensor

    frame = {"data": b"\0" * (320 * 320 * 3), "width": 320, "height": 320, "format": "rgb"}
    result = asyncio.run(sensor_for("cam-1").detectObjects(frame))
    assert [d["label"] for d in result["detections"]] == ["person", "велосипед"]
    assert result["detected"] is True
    # a module not loaded yet is loaded in the background; the frame goes on without it
    assert prepared == ["vion-trained-v-cold"]

    module.calls = 0
    other = asyncio.run(sensor_for("cam-2").detectObjects(frame))
    assert [d["label"] for d in other["detections"]] == ["person"], "a module ran on a camera it is not on"
    assert module.calls == 0

    # nothing of the camera's own detector, a box of the module: still a detection
    main.found = []
    alone = asyncio.run(sensor_for("cam-1").detectObjects(frame))
    assert [d["label"] for d in alone["detections"]] == ["велосипед"]
    assert alone["detected"] is True


def test_the_attribute_sensor_runs_the_classifiers_of_its_camera(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.syspath_prepend(str(ONNX_SRC))
    monkeypatch.syspath_prepend(str(SDK))
    monkeypatch.syspath_prepend(str(ROOT / "packages" / "camera_ui_ml"))
    for name in ("trained", "sensors.attribute_sensor"):
        sys.modules.pop(name, None)
    attribute_sensor = importlib.import_module("sensors.attribute_sensor")
    trained_module = sys.modules["trained"]
    write_manifest(
        tmp_path,
        {
            "detector": None,
            "attributes": [
                model(tmp_path, "taxi", label="vehicle", attribute="такси", cameras=["cam-2"]),
                model(tmp_path, "bag", label="person", attribute="с пакетом"),
            ],
        },
    )
    trained_module.trained_models.dir = str(tmp_path)
    fresh(trained_module.trained_models)
    asked: list[str] = []

    def sensor_for(camera_id: str) -> Any:
        sensor = attribute_sensor.ViONAttributeSensor(
            None, types.SimpleNamespace(id=camera_id), types.SimpleNamespace(log=print, error=print)
        )

        async def classify(entry: dict[str, Any], rgb: Any) -> float:
            asked.append(f"{camera_id}:{entry['id']}")
            return 0.9

        sensor._classify = classify
        return sensor

    person = {"data": b"\0" * (8 * 8 * 3), "width": 8, "height": 8, "format": "rgb", "label": "person"}
    car = {**person, "label": "vehicle"}
    first = asyncio.run(sensor_for("cam-1").detectClassifications([person, car]))
    assert asked == ["cam-1:bag"], "a classifier ran on a camera its module is not on"
    assert [d["attribute"] for d in first[0]["detections"]] == ["с пакетом"]
    asked.clear()
    asyncio.run(sensor_for("cam-2").detectClassifications([person, car]))
    assert asked == ["cam-2:bag", "cam-2:taxi"]
    # the server crops only the classes a camera's classifiers ask about
    assert sensor_for("cam-1").modelSpec["triggerLabels"] == ["person"]
    assert sensor_for("cam-2").modelSpec["triggerLabels"] == ["person", "vehicle"]
