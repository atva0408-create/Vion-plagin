"""What the ONNX and OpenVINO plugins tell the server of a model a sensor has not loaded (modelSpec `loadState`).

Re-ID loads with the first person a camera sees, so its page said «Не работает: модель ещё не загружена» on every
camera: an engine names a model only once it is loaded, and «not needed yet» looked like «failed». The sensors now
say which: `pending` (the server shows «Подключено») or `failed` with the reason. The real methods of both plugins run
here on fake models.

    python -m pytest camera-ui-onnx/tests/test_load_state.py
"""

from __future__ import annotations

import ast
import asyncio
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[2]
REID = "osnet-x0-25-msmt17"
MODULE = "vion-module-bikes"
DEFAULT = "yolo-v9-s-320"


def _class_of(path: Path, suffix: str, keep: set[str]) -> tuple[ast.ClassDef, Path]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name.endswith(suffix))
    cls.bases = []
    cls.decorator_list = []
    cls.body = [
        node
        for node in cls.body
        if isinstance(node, ast.AsyncFunctionDef | ast.FunctionDef) and node.name in keep
    ]
    return cls, path


def _compile(cls: ast.ClassDef, path: Path, namespace: dict[str, Any]) -> type:
    module = ast.Module(
        body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), cls],
        type_ignores=[],
    )
    exec(compile(ast.fix_missing_locations(module), str(path), "exec"), namespace)
    return namespace[cls.name]


class Embedder:
    """PersonEmbedder that fails while `fail` says so."""

    fail: str | None = None

    def __init__(self, *_args: Any, **_kwargs: Any) -> None:
        self.initialized = False

    async def initialize(self, _name: str) -> None:
        if Embedder.fail is not None:
            raise RuntimeError(Embedder.fail)
        self.initialized = True


class Sensor:
    def __init__(self) -> None:
        self.updates = 0

    def updateModelSpec(self) -> None:
        self.updates += 1


@pytest.fixture(params=["onnx", "openvino", "onnx-legacy", "openvino-legacy"])
def engine(request: pytest.FixtureRequest) -> str:
    if not (ROOT / f"camera-ui-{request.param}" / "src" / "main.py").exists():
        # the legacy plugins get src/ from scripts/sync.mjs (it is not in git)
        pytest.skip(f"camera-ui-{request.param} not synced: node camera-ui-{request.param}/scripts/sync.mjs")
    return str(request.param)


def plugin_of(engine: str) -> Any:
    cls, path = _class_of(
        ROOT / f"camera-ui-{engine}" / "src" / "main.py",
        "Plugin",
        {"load_state", "_load_failed", "_load_succeeded", "_refresh_model_specs", "get_person_embedder"},
    )
    namespace: dict[str, Any] = {
        "PersonEmbedder": Embedder,
        "PERSON_EMBEDDER_MODEL": REID,
        "PERSON_EMBEDDER_WIDTH": 128,
        "PERSON_EMBEDDER_HEIGHT": 256,
        "Mapping": dict,
        "Any": Any,
    }
    plugin = object.__new__(_compile(cls, path, namespace))
    plugin.model_manager = None
    plugin.logger = None
    plugin.person_embedders = {}
    plugin._load_errors = {}
    plugin.sensor = Sensor()
    plugin._sensors = {"lift": {"personEmbedder": plugin.sensor}}
    return plugin


def test_a_model_not_needed_yet_is_pending(engine: str) -> None:
    plugin = plugin_of(engine)
    assert plugin.load_state({}, REID) == {"loadModel": REID, "loadState": "pending"}
    # loaded: nothing to say beyond what is loaded
    runtime = {"models": [{"name": REID, "role": "embed"}], "runtime": "onnxruntime"}
    assert plugin.load_state(runtime, REID) == runtime


def test_a_failed_load_says_why_once_and_is_forgotten_when_it_loads(engine: str) -> None:
    plugin = plugin_of(engine)
    Embedder.fail = "no such file"
    try:
        for _ in range(3):
            with pytest.raises(RuntimeError):
                asyncio.run(plugin.get_person_embedder())
        assert plugin.load_state({}, REID) == {
            "loadModel": REID,
            "loadState": "failed",
            "loadError": "no such file",
        }
        # the server hears of it once, not on every frame that asks again
        assert plugin.sensor.updates == 1
        # another reason is news
        Embedder.fail = "out of memory"
        with pytest.raises(RuntimeError):
            asyncio.run(plugin.get_person_embedder())
        assert plugin.load_state({}, REID)["loadError"] == "out of memory"
        assert plugin.sensor.updates == 2
        Embedder.fail = None
        asyncio.run(plugin.get_person_embedder())
        assert plugin.load_state({}, REID) == {"loadModel": REID, "loadState": "pending"}
        assert plugin.sensor.updates == 3
        # loaded once more: nothing new to tell
        asyncio.run(plugin.get_person_embedder())
        assert plugin.sensor.updates == 3
    finally:
        Embedder.fail = None


def test_a_sensor_of_two_models_names_the_one_that_failed(engine: str) -> None:
    plugin = plugin_of(engine)
    plugin._load_failed("cct-xs-v2-global", RuntimeError("x" * 500))
    state = plugin.load_state({}, "yolo-v9-t-384-license-plates", "cct-xs-v2-global")
    assert state["loadModel"] == "cct-xs-v2-global" and state["loadState"] == "failed"
    assert len(state["loadError"]) == 300
    # an error without words is named by its type
    plugin._load_failed("other", TimeoutError())
    assert plugin.load_state({}, "other")["loadError"] == "TimeoutError"


def _object_sensor(engine: str, plugin: Any) -> Any:
    cls, path = _class_of(
        ROOT / f"camera-ui-{engine}" / "src" / "sensors" / "object_sensor.py", "ObjectSensor", {"modelSpec"}
    )
    # keep @property: the sensor's own code reads it as an attribute
    namespace: dict[str, Any] = {
        "model_runtime": lambda *loaded: (
            {
                "models": [
                    {"name": holder.name}
                    for holder, _role in loaded
                    if holder is not None and holder.initialized
                ]
            }
            if any(holder is not None and holder.initialized for holder, _role in loaded)
            else {}
        ),
    }
    for node in cls.body:
        if node.name == "modelSpec":
            node.decorator_list = [ast.Name(id="property", ctx=ast.Load())]
    sensor = object.__new__(_compile(cls, path, namespace))
    sensor._plugin = plugin
    sensor._active_model = None
    sensor._wanted = MODULE
    sensor._wanted_model = lambda: sensor._wanted
    return sensor


class Detector:
    def __init__(self, name: str, initialized: bool = True) -> None:
        self.name = name
        self.initialized = initialized
        self.input_size = (320, 320)


def test_the_object_sensor_tells_a_module_that_loads_from_one_that_failed(engine: str) -> None:
    plugin = plugin_of(engine)
    plugin.object_detectors = {DEFAULT: Detector(DEFAULT)}
    sensor = _object_sensor(engine, plugin)
    # the module loads in the background while the standard model detects
    sensor._active_model = DEFAULT
    spec = sensor.modelSpec
    assert spec["models"] == [{"name": DEFAULT}]
    assert (spec["loadModel"], spec["loadState"]) == (MODULE, "pending")
    # its load failed: the camera goes on with the standard model, the server hears why
    plugin._load_failed(MODULE, RuntimeError("invalid graph"))
    spec = sensor.modelSpec
    assert (spec["loadModel"], spec["loadState"], spec["loadError"]) == (MODULE, "failed", "invalid graph")
    # loaded: no word on loading
    plugin.object_detectors[MODULE] = Detector(MODULE)
    sensor._active_model = MODULE
    spec = sensor.modelSpec
    assert spec["models"] == [{"name": MODULE}] and "loadState" not in spec


GETTERS = [
    "get_face_detector",
    "get_face_embedder",
    "get_face_landmarker",
    "get_person_embedder",
    "get_segmenter",
    "get_plate_detector",
    "get_ocr",
    "get_clip_encoder",
    "_initialize_object_detector",
]
SENSORS = [
    "face_sensor.py",
    "face_embedder_sensor.py",
    "lpd_sensor.py",
    "clip_sensor.py",
    "person_embedder_sensor.py",
    "segmenter_sensor.py",
    "object_sensor.py",
]


def _calls(node: ast.AST, name: str) -> bool:
    return any(
        isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute) and call.func.attr == name
        for call in ast.walk(node)
    )


def test_every_model_a_sensor_loads_tells_its_failure_and_its_load(engine: str) -> None:
    tree = ast.parse((ROOT / f"camera-ui-{engine}" / "src" / "main.py").read_text(encoding="utf-8"))
    methods = {
        node.name: node for node in ast.walk(tree) if isinstance(node, ast.AsyncFunctionDef | ast.FunctionDef)
    }
    # a getter left out would show its failure as «Подключено»
    missing = [
        name
        for name in GETTERS
        if not (_calls(methods[name], "_load_failed") and _calls(methods[name], "_load_succeeded"))
    ]
    assert missing == []


@pytest.mark.parametrize("sensor_file", SENSORS)
def test_every_sensor_of_a_model_says_how_its_model_loads(engine: str, sensor_file: str) -> None:
    tree = ast.parse(
        (ROOT / f"camera-ui-{engine}" / "src" / "sensors" / sensor_file).read_text(encoding="utf-8")
    )
    spec = next(
        node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef) and node.name == "modelSpec"
    )
    assert _calls(spec, "load_state")
