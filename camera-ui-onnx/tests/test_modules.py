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
import shutil
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


def module_entry(
    directory: Path,
    module_id: str,
    backends: tuple[str, ...] = ("onnx",),
    version: str = "1.0.0",
    size: int = 32,
) -> dict[str, Any]:
    files: dict[str, list[dict[str, Any]]] = {}
    for backend in backends:
        folder = directory / module_id / version / "light" / backend
        folder.mkdir(parents=True, exist_ok=True)
        names = ["model.onnx"] if backend == "onnx" else ["model.xml", "model.bin"]
        files[backend] = []
        for name in names:
            (folder / name).write_bytes(tiny_onnx(size) if name.endswith(".onnx") else b"ir")
            files[backend].append({"name": name, "path": str(folder / name), "sha256": "0" * 64, "size": 1})
    return {
        "id": module_id,
        "version": version,
        "task": "detector",
        "name": {"ru": "Велосипеды", "en": "Bicycles", "de": "Fahrräder"},
        "labels": ["bicycle", "scooter"],
        "input": {"width": size, "height": size},
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


def test_a_replaced_list_is_seen_even_when_its_mtime_did_not_change(tmp_path: Path, store: Any):
    write_installed(tmp_path, [module_entry(tmp_path, "bikes")])
    assert list(fresh(store).choices(("onnx",))) == ["vion-module-bikes"]
    mtime_ns = (tmp_path / "installed.json").stat().st_mtime_ns

    # the server replaced the file within the clock's resolution: same mtime, another file
    write_installed(tmp_path, [module_entry(tmp_path, "bikes"), module_entry(tmp_path, "cats")])
    os.utime(tmp_path / "installed.json", ns=(mtime_ns, mtime_ns))
    assert (tmp_path / "installed.json").stat().st_mtime_ns == mtime_ns
    assert sorted(fresh(store).choices(("onnx",))) == ["vion-module-bikes", "vion-module-cats"]


def test_an_installed_detector_is_one_more_model(tmp_path: Path, store: Any):
    write_installed(tmp_path, [module_entry(tmp_path, "bikes")])
    assert store.choices(("onnx",)) == {"vion-module-bikes": "Велосипеды"}
    backend, paths = store.paths("vion-module-bikes", ("onnx",))
    assert backend == "onnx"
    assert paths[".onnx"] == str(tmp_path / "bikes" / "1.0.0" / "light" / "onnx" / "model.onnx")
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
        "model": ("", str(Path(installed_modules.dir) / "bikes" / "1.0.0" / "light" / "onnx" / "model.onnx"))
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
    ir = tmp_path / "ir" / "1.0.0" / "light" / "openvino"
    assert manager.model_files("vion-module-ir") == {
        "xml": ("", str(ir / "model.xml")),
        "bin": ("", str(ir / "model.bin")),
    }
    graph = str(tmp_path / "graph" / "1.0.0" / "light" / "onnx" / "model.onnx")
    assert manager.model_files("vion-module-graph") == {"xml": ("", graph), "bin": ("", graph)}


def onnx_plugin(monkeypatch: pytest.MonkeyPatch) -> types.ModuleType:
    """main.py of the ONNX plugin, imported afresh (the plugins share module names); CLIP is not needed here."""
    pytest.importorskip("onnxruntime")
    pytest.importorskip("aiohttp")
    if not SDK.is_dir():
        pytest.skip(f"camera_ui_sdk (python) not found at {SDK}")
    # CLIP is unrelated to module updates; do not load its optional torch stack in these tests.
    monkeypatch.setitem(sys.modules, "transformers", types.SimpleNamespace(CLIPProcessor=object))
    for name in ("main", "model_manager", "defaults", "modules", "trained", "inference"):
        monkeypatch.delitem(sys.modules, name, raising=False)
    monkeypatch.syspath_prepend(str(ONNX_SRC))
    monkeypatch.syspath_prepend(str(SDK))
    monkeypatch.syspath_prepend(str(ROOT / "packages" / "camera_ui_ml"))
    import main  # type: ignore[import-not-found]

    return main


def test_two_modules_with_the_same_file_name_keep_their_own_optimized_copy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """Every module ships a model.onnx: the cache of optimized graphs must not hand one module the other's graph."""
    main = onnx_plugin(monkeypatch)
    import model_manager  # type: ignore[import-not-found]
    from modules import installed_modules  # type: ignore[import-not-found]

    installed_modules.dir = str(tmp_path / "modules")
    installed_modules._checked = float("-inf")
    os.makedirs(installed_modules.dir)
    directory = Path(installed_modules.dir)
    write_installed(
        directory, [module_entry(directory, "bikes", size=32), module_entry(directory, "cats", size=64)]
    )

    logger = types.SimpleNamespace(log=print, warn=print, error=print, debug=print, success=print)
    manager = model_manager.OnnxModelManager(
        str(tmp_path / "storage"), logger, lambda: [["CPUExecutionProvider"]]
    )

    async def sizes() -> list[Any]:
        result = []
        for name in ("vion-module-bikes", "vion-module-cats"):
            detector = main.BoxDetector(manager, logger, name="object detector", multiclass=True)
            await detector.initialize(name)
            result.append(detector.backend._input_size)  # type: ignore[union-attr]
            await detector.close()
        return result

    assert asyncio.run(sizes()) == [(32, 32), (64, 64)]
    # a second start reads the optimized copies: still each module its own graph
    manager.reset()
    assert asyncio.run(sizes()) == [(32, 32), (64, 64)]


def test_an_updated_module_is_loaded_again_without_a_restart(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """An update keeps the model name vion-module-<id>: the plugin sees other files and swaps the detector."""
    main = onnx_plugin(monkeypatch)
    import model_manager  # type: ignore[import-not-found]
    from modules import installed_modules  # type: ignore[import-not-found]

    installed_modules.dir = str(tmp_path / "modules")
    installed_modules._checked = float("-inf")
    os.makedirs(installed_modules.dir)
    directory = Path(installed_modules.dir)
    write_installed(directory, [module_entry(directory, "bikes", version="1.0.0", size=32)])

    logger = types.SimpleNamespace(log=print, warn=print, error=print, debug=print, success=print)
    plugin = object.__new__(main.ONNXPlugin)
    plugin.logger = logger
    plugin.model_manager = model_manager.OnnxModelManager(
        str(tmp_path / "storage"), logger, lambda: [["CPUExecutionProvider"]]
    )
    plugin.object_detectors = {}
    plugin._sensors = {}
    plugin._failed_models = {}
    plugin._module_files = {}
    plugin._module_reloading = set()
    plugin._models_generation = 0
    plugin._modules_version = -1

    async def scenario() -> None:
        old = await plugin.get_object_detector("vion-module-bikes")
        assert old.backend._input_size == (32, 32)
        plugin.check_modules()
        await asyncio.sleep(0)
        assert plugin.object_detectors["vion-module-bikes"] is old  # nothing changed, nothing reloaded

        # the server installs 1.1.0 and removes the files of 1.0.0
        write_installed(directory, [module_entry(directory, "bikes", version="1.1.0", size=64)])
        shutil.rmtree(directory / "bikes" / "1.0.0")
        installed_modules._checked = float("-inf")
        plugin.check_modules()
        for _ in range(100):
            new = plugin.object_detectors.get("vion-module-bikes")
            if new is not None and new is not old and new.initialized:
                break
            await asyncio.sleep(0.01)
        assert new is not old and new.backend._input_size == (64, 64)
        assert new.labels == {0: "bicycle", 1: "scooter"}
        assert old.closed

    asyncio.run(scenario())


def test_an_invalid_updated_graph_keeps_the_loaded_cpu_model(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    main = onnx_plugin(monkeypatch)
    import model_manager  # type: ignore[import-not-found]
    from modules import installed_modules  # type: ignore[import-not-found]

    directory = tmp_path / "modules"
    directory.mkdir()
    installed_modules.dir = str(directory)
    installed_modules._checked = float("-inf")
    write_installed(directory, [module_entry(directory, "bikes")])
    logger = types.SimpleNamespace(log=print, warn=print, error=print, debug=print, success=print)
    plugin = object.__new__(main.ONNXPlugin)
    plugin.logger = logger
    plugin.model_manager = model_manager.OnnxModelManager(
        str(tmp_path / "storage"), logger, lambda: [["CPUExecutionProvider"]]
    )
    plugin.object_detectors = {}
    plugin._sensors = {}
    plugin._failed_models = {}
    plugin._module_files = {}
    plugin._module_reloading = set()
    plugin._models_generation = 0

    async def scenario() -> None:
        old = await plugin.get_object_detector("vion-module-bikes")
        updated = module_entry(directory, "bikes", version="1.1.0")
        Path(updated["files"]["onnx"][0]["path"]).write_bytes(b"invalid ONNX graph")
        write_installed(directory, [updated])
        installed_modules._checked = float("-inf")
        await plugin._reload_module_detector("vion-module-bikes")
        assert await plugin.get_object_detector("vion-module-bikes") is old
        assert old.initialized and not old.closed
        assert old.backend._input_size == (32, 32)
        assert plugin._module_files["vion-module-bikes"][0] == "1.0.0"
        await old.close()

    asyncio.run(scenario())


def test_the_report_tells_the_server_what_loaded_and_what_did_not(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setenv("PLUGIN_NAME", "@vionvision/camera-ui-onnx")
    store = modules.InstalledModules(str(tmp_path))
    assert store.report({"id": "bikes", "version": "1.0.0", "tier": "light"})
    assert store.report({"id": "cats", "version": "2.0.0", "tier": "heavy"}, "invalid graph")
    # a newer version that failed is kept apart from the one that loaded
    assert store.report({"id": "bikes", "version": "1.1.0", "tier": "light"}, "x" * 500)
    files = list((tmp_path / ".engines").iterdir())
    assert [f.name for f in files] == ["vionvision_camera-ui-onnx.json"]
    data = json.loads(files[0].read_text(encoding="utf-8"))
    assert data["plugin"] == "@vionvision/camera-ui-onnx"
    assert data["modules"]["cats"]["failed"] == {
        **data["modules"]["cats"]["failed"],
        "version": "2.0.0",
        "tier": "heavy",
        "error": "invalid graph",
    }
    assert "loaded" not in data["modules"]["cats"]
    # a newer version that failed keeps the one that loaded known: the server's way back
    assert data["modules"]["bikes"]["loaded"]["version"] == "1.0.0"
    assert data["modules"]["bikes"]["failed"]["version"] == "1.1.0"
    assert len(data["modules"]["bikes"]["failed"]["error"]) == 300
    # the same version loading after all clears its failure
    assert store.report({"id": "bikes", "version": "1.1.0", "tier": "light"})
    data = json.loads(files[0].read_text(encoding="utf-8"))
    assert (
        data["modules"]["bikes"]["loaded"]["version"] == "1.1.0" and "failed" not in data["modules"]["bikes"]
    )
    # nothing left behind of the atomic write
    assert not [p for p in (tmp_path / ".engines").iterdir() if p.name.endswith(".tmp")]


def test_a_report_that_cannot_be_written_says_so(tmp_path: Path):
    blocked = tmp_path / "blocked"
    blocked.write_text("a file where the folder of the reports would go", encoding="utf-8")
    store = modules.InstalledModules(str(blocked))
    assert store.report({"id": "bikes", "version": "1.0.0"}) is False
    # no modules folder (a remote worker): nothing to tell, nothing failed
    assert modules.InstalledModules("").report({"id": "bikes", "version": "1.0.0"}) is True
