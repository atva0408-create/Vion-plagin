"""Modules of the ViON store as the detection plugins see them (src/modules.py, kept identical in the ONNX and
OpenVINO plugins; the legacy plugins copy them).

The ViON server writes ``installed.json`` (server/src/manager/moduleManager.ts); the plugin offers every detector
module it has the files of as one more object model, loads it through its model manager from the absolute path
without a download, and follows an added or removed module without a restart.

    pip install pytest aiohttp onnxruntime numpy
    python3 -m pytest camera-ui-onnx/tests/test_modules.py
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


modules = load(ONNX_SRC / "modules.py", "store_modules")


def tiny_onnx(size: int = 32) -> bytes:
    """A real ONNX graph (Identity on a 1x3xNxN image) written as protobuf by hand: no onnx package needed."""

    def varint(value: int) -> bytes:
        out = bytearray()
        while True:
            byte = value & 0x7F
            value >>= 7
            out.append(byte | (0x80 if value else 0))
            if not value:
                return bytes(out)

    def field(number: int, payload: bytes | int | str) -> bytes:
        if isinstance(payload, int):
            return varint(number << 3) + varint(payload)
        data = payload.encode() if isinstance(payload, str) else payload
        return varint((number << 3) | 2) + varint(len(data)) + data

    shape = b"".join(field(1, field(1, dim)) for dim in (1, 3, size, size))
    tensor_type = field(1, field(1, 1) + field(2, shape))  # elem_type FLOAT, shape
    value = lambda name: field(1, name) + field(2, tensor_type)  # noqa: E731
    node = field(1, "images") + field(2, "output") + field(3, "identity") + field(4, "Identity")
    graph = field(1, node) + field(2, "module") + field(11, value("images")) + field(12, value("output"))
    return field(1, 8) + field(2, "vion-test") + field(7, graph) + field(8, field(1, "") + field(2, 13))


def write_installed(directory: Path, entries: list[dict[str, Any]]) -> None:
    path = directory / "installed.json"
    tmp = directory / "installed.json.tmp"
    tmp.write_text(json.dumps({"version": 1, "updatedAt": 1, "modules": entries}))
    os.replace(tmp, path)
    # a new mtime even when the test writes twice within the clock's resolution
    stat = path.stat()
    os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000_000))


def module_entry(directory: Path, module_id: str, backends: tuple[str, ...] = ("onnx",)) -> dict[str, Any]:
    files: dict[str, list[dict[str, Any]]] = {}
    for backend in backends:
        folder = directory / module_id / "1.0.0" / backend
        folder.mkdir(parents=True, exist_ok=True)
        names = ["model.onnx"] if backend == "onnx" else ["model.xml", "model.bin"]
        files[backend] = []
        for name in names:
            (folder / name).write_bytes(tiny_onnx() if name.endswith(".onnx") else b"ir")
            files[backend].append({"name": name, "path": str(folder / name), "sha256": "0" * 64, "size": 1})
    return {
        "id": module_id,
        "version": "1.0.0",
        "task": "detector",
        "name": {"ru": "Велосипеды", "en": "Bicycles", "de": "Fahrräder"},
        "labels": ["bicycle", "scooter"],
        "input": {"width": 32, "height": 32},
        "tier": "light",
        "device": "cpu",
        "files": files,
        "license": {"spdx": "Apache-2.0", "url": "https://www.apache.org/licenses/LICENSE-2.0"},
        "installedAt": 1,
    }


@pytest.fixture
def store(tmp_path: Path) -> Any:
    installed = modules.InstalledModules(str(tmp_path))
    # the check every few seconds is the plugin's pace, the test looks right away
    installed._checked = float("-inf")  # type: ignore[attr-defined]
    return installed


def fresh(store: Any) -> Any:
    store._checked = float("-inf")
    return store


def test_the_plugins_carry_the_same_file():
    assert (ONNX_SRC / "modules.py").read_text() == (OPENVINO_SRC / "modules.py").read_text()


def test_an_installed_detector_is_one_more_model(tmp_path: Path, store: Any):
    write_installed(tmp_path, [module_entry(tmp_path, "bikes")])
    assert store.choices(("onnx",)) == {"vion-module-bikes": "Велосипеды"}
    backend, paths = store.paths("vion-module-bikes", ("onnx",))
    assert backend == "onnx"
    assert paths[".onnx"] == str(tmp_path / "bikes" / "1.0.0" / "onnx" / "model.onnx")
    assert store.entry("vion-module-bikes", ("onnx",))["labels"] == ["bicycle", "scooter"]


def test_a_module_without_the_files_of_the_plugin_is_not_offered(tmp_path: Path, store: Any):
    write_installed(tmp_path, [module_entry(tmp_path, "ir-only", ("openvino",))])
    assert store.choices(("onnx",)) == {}
    with pytest.raises(FileNotFoundError):
        store.paths("vion-module-ir-only", ("onnx",))
    # the OpenVINO plugin takes the IR pair first and reads an ONNX graph otherwise
    assert store.paths("vion-module-ir-only", ("openvino", "onnx"))[0] == "openvino"


def test_a_file_missing_on_disk_makes_the_module_unusable(tmp_path: Path, store: Any):
    entry = module_entry(tmp_path, "bikes")
    write_installed(tmp_path, [entry])
    os.remove(entry["files"]["onnx"][0]["path"])
    assert store.choices(("onnx",)) == {}


def test_added_and_removed_modules_are_seen_without_a_restart(tmp_path: Path, store: Any):
    assert store.choices(("onnx",)) == {}
    before = store.version
    write_installed(tmp_path, [module_entry(tmp_path, "bikes")])
    assert list(fresh(store).choices(("onnx",))) == ["vion-module-bikes"]
    assert store.version == before + 1

    write_installed(tmp_path, [])
    assert fresh(store).choices(("onnx",)) == {}
    assert store.version == before + 2


def test_a_list_being_replaced_keeps_the_previous_one(tmp_path: Path, store: Any):
    write_installed(tmp_path, [module_entry(tmp_path, "bikes")])
    assert fresh(store).choices(("onnx",))
    (tmp_path / "installed.json").write_text('{"modules": [')
    assert list(fresh(store).choices(("onnx",))) == ["vion-module-bikes"]


def test_a_removed_module_leaves_the_camera_on_the_default(tmp_path: Path):
    modules.installed_modules.dir = str(tmp_path)
    modules.installed_modules._checked = float("-inf")
    write_installed(tmp_path, [module_entry(tmp_path, "bikes")])
    assert modules.usable_choice("vion-module-bikes", ("onnx",)) == "vion-module-bikes"
    write_installed(tmp_path, [])
    modules.installed_modules._checked = float("-inf")
    assert modules.usable_choice("vion-module-bikes", ("onnx",)) == "default"
    assert modules.usable_choice("yolo-v9-s-320", ("onnx",)) == "yolo-v9-s-320"


def test_the_onnx_plugin_loads_the_module_from_its_path(tmp_path: Path):
    """The model manager of the ONNX plugin takes the absolute path, downloads nothing, and the graph runs."""
    ort = pytest.importorskip("onnxruntime")
    numpy = pytest.importorskip("numpy")
    pytest.importorskip("aiohttp")
    if not SDK.is_dir():
        pytest.skip(f"camera_ui_sdk (python) not found at {SDK}")
    sys.path[:0] = [str(ROOT / "packages" / "camera_ui_ml"), str(SDK), str(ONNX_SRC)]
    try:
        import model_manager  # type: ignore[import-not-found]
        from modules import installed_modules  # type: ignore[import-not-found]
    finally:
        del sys.path[:3]

    installed_modules.dir = str(tmp_path / "modules")
    installed_modules._checked = float("-inf")
    os.makedirs(installed_modules.dir)
    write_installed(Path(installed_modules.dir), [module_entry(Path(installed_modules.dir), "bikes")])

    logger = types.SimpleNamespace(log=print, warn=print, error=print, debug=print, success=print)
    manager = model_manager.OnnxModelManager(
        str(tmp_path / "storage"), logger, lambda: [["CPUExecutionProvider"]]
    )
    files = manager.model_files("vion-module-bikes")
    assert files == {
        "model": ("", str(Path(installed_modules.dir) / "bikes" / "1.0.0" / "onnx" / "model.onnx"))
    }

    # the whole load of the plugin: the download step finds the file, the backend builds from it
    backend = asyncio.run(manager.ensure_backend("vion-module-bikes"))
    assert backend is not None
    assert not (tmp_path / "storage" / "models" / "v1" / "vion-module-bikes").exists()
    session = ort.InferenceSession(files["model"][1], providers=["CPUExecutionProvider"])
    image = numpy.random.rand(1, 3, 32, 32).astype(numpy.float32)
    assert numpy.array_equal(session.run(None, {"images": image})[0], image)


def test_the_openvino_plugin_takes_the_ir_pair_or_the_onnx_graph(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """Which files the OpenVINO model manager hands to the compiler; OpenVINO itself is not needed for that."""
    pytest.importorskip("aiohttp")
    if not SDK.is_dir():
        pytest.skip(f"camera_ui_sdk (python) not found at {SDK}")
    if importlib.util.find_spec("openvino") is None:
        monkeypatch.setitem(sys.modules, "openvino", types.ModuleType("openvino"))
    # the plugins share module names (defaults, modules, trained…): import the OpenVINO ones afresh
    for name in ("model_manager", "defaults", "modules", "trained", "inference"):
        monkeypatch.delitem(sys.modules, name, raising=False)
    monkeypatch.syspath_prepend(str(OPENVINO_SRC))
    monkeypatch.syspath_prepend(str(SDK))
    monkeypatch.syspath_prepend(str(ROOT / "packages" / "camera_ui_ml"))
    if importlib.util.find_spec("inference") is not None:
        monkeypatch.setitem(sys.modules, "inference", types.SimpleNamespace(OpenVinoBackend=object))
    import model_manager  # type: ignore[import-not-found]
    from modules import installed_modules  # type: ignore[import-not-found]

    assert model_manager.MODULE_BACKENDS == ("openvino", "onnx")
    installed_modules.dir = str(tmp_path)
    installed_modules._checked = float("-inf")
    write_installed(
        tmp_path,
        [module_entry(tmp_path, "ir", ("openvino", "onnx")), module_entry(tmp_path, "graph", ("onnx",))],
    )

    manager = object.__new__(model_manager.OpenVinoModelManager)
    ir = tmp_path / "ir" / "1.0.0" / "openvino"
    assert manager.model_files("vion-module-ir") == {
        "xml": ("", str(ir / "model.xml")),
        "bin": ("", str(ir / "model.bin")),
    }
    graph = str(tmp_path / "graph" / "1.0.0" / "onnx" / "model.onnx")
    assert manager.model_files("vion-module-graph") == {"xml": ("", graph), "bin": ("", graph)}
