"""Run the real ONNX/OpenVINO reload methods with deferred, failing model loads.

The methods are extracted from the plugin class so this fault injection suite does not need a GPU,
download models or import either native inference runtime.
"""

from __future__ import annotations

import ast
import asyncio
import types
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[2]
NAME = "vion-module-bikes"


class Models:
    def __init__(self) -> None:
        self.current: dict[str, Any] | None = {"id": "bikes", "version": "1", "labels": ["bicycle"]}
        self.reports: list[tuple[str, str | None]] = []
        self.version = 1

    def installed(self) -> list[dict[str, Any]]:
        return [self.current] if self.current else []

    def report(self, entry: dict[str, Any], error: str | None = None) -> bool:
        self.reports.append((entry["version"], error))
        return True

    def entry(self, _name: str, _backends: tuple[str, ...]) -> dict[str, Any] | None:
        return self.current

    def files(self, entry: dict[str, Any], _backends: tuple[str, ...]) -> object:
        return entry["version"]


class Detector:
    def __init__(self, manager: Any, _logger: Any, **_options: Any) -> None:
        self.manager = manager
        self.closed = False
        self.initialized = False
        self.labels: dict[int, str] = {}
        self.version: str | None = None
        manager.created.append(self)

    async def initialize(self, name: str) -> None:
        if self.initialized:
            return
        self.version = self.manager.loads.setdefault(name, self.manager.models.current["version"])
        gate = self.manager.gates.get(self.version, self.manager.gate)
        if gate is not None:
            await gate.wait()
        if self.manager.fail or self.version in self.manager.fail_versions:
            self.manager.loads.pop(name, None)
            raise RuntimeError("model cannot be loaded")
        self.initialized = True

    async def close(self) -> None:
        self.closed = True


@pytest.fixture(params=["onnx", "openvino", "onnx-legacy", "openvino-legacy"])
def plugin(request: pytest.FixtureRequest) -> Any:
    path = ROOT / f"camera-ui-{request.param}" / "src" / "main.py"
    if not path.exists():
        # the legacy plugins get src/ from scripts/sync.mjs (it is not in git)
        pytest.skip(f"{path} not synced: node camera-ui-{request.param}/scripts/sync.mjs")
    tree = ast.parse(path.read_text(encoding="utf-8"))
    cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name.endswith("Plugin"))
    methods = {
        "get_object_detector",
        "_initialize_object_detector",
        "_module_signature",
        "_reload_module_detector",
        "_close_all",
        "_report_module",
        "model_failed",
        "check_modules",
        "prepare_object_detector",
        "_object_load_failed",
        "_reload_models",
        "load_state",
        "_load_failed",
        "_load_succeeded",
        "_refresh_model_specs",
    }
    cls.bases = []
    cls.decorator_list = []
    cls.body = [
        node
        for node in cls.body
        if isinstance(node, ast.AsyncFunctionDef | ast.FunctionDef) and node.name in methods
    ]
    models = Models()
    globals_: dict[str, Any] = {
        "asyncio": asyncio,
        "time": __import__("time"),
        "BoxDetector": Detector,
        "installed_modules": models,
        "MODULE_BACKENDS": (request.param,),
        "is_module": lambda name: str(name).startswith("vion-module-"),
        "is_trained": lambda _: False,
        "OBJECT_LABELS": {0: "person"},
    }
    module = ast.Module(
        body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), cls],
        type_ignores=[],
    )
    exec(compile(ast.fix_missing_locations(module), str(path), "exec"), globals_)
    instance = object.__new__(globals_[cls.name])
    instance.logger = types.SimpleNamespace(error=lambda _: None, success=lambda _: None, warn=lambda _: None)
    loads: dict[str, str] = {}
    instance.model_manager = types.SimpleNamespace(
        models=models,
        gate=None,
        gates={},
        fail=False,
        fail_versions=set(),
        created=[],
        loads=loads,
        forget=lambda name: loads.pop(name, None),
        reset=lambda: None,
    )
    instance.object_detectors = {}
    instance._module_files = {}
    instance._failed_models = {}
    instance._failed_module_files = {}
    instance._load_errors = {}
    instance._preparing = set()
    instance._module_reloading = set()
    instance._models_generation = 0
    instance._modules_version = models.version
    instance._sensors = {}
    for key in [
        "face_detectors",
        "plate_detectors",
        "face_embedders",
        "clip_encoders",
        "ocr_models",
        "person_embedders",
        "segmenters",
        "attribute_backends",
    ]:
        setattr(instance, key, {})
    return instance


async def settle() -> None:
    for _ in range(5):
        await asyncio.sleep(0)


def test_failed_update_keeps_the_working_detector(plugin: Any) -> None:
    async def scenario() -> None:
        old = await plugin.get_object_detector(NAME)
        signature = plugin._module_files[NAME]
        plugin.model_manager.models.current = {"version": "2", "labels": ["scooter"]}
        plugin.model_manager.fail = True
        await plugin._reload_module_detector(NAME)
        assert plugin.object_detectors[NAME] is old
        assert not old.closed
        assert plugin._module_files[NAME] == signature
        assert plugin.model_manager.created[-1].closed, "the failed candidate is released"

    asyncio.run(scenario())


def test_working_detector_stays_available_until_replacement_is_ready(plugin: Any) -> None:
    async def scenario() -> None:
        old = await plugin.get_object_detector(NAME)
        plugin.model_manager.models.current = {"version": "2", "labels": ["scooter"]}
        plugin.model_manager.gate = asyncio.Event()
        refreshes: list[bool] = []
        plugin._sensors = {
            "camera": {
                "object": types.SimpleNamespace(
                    _active_model=NAME, updateModelSpec=lambda: refreshes.append(True)
                )
            }
        }
        task = asyncio.create_task(plugin._reload_module_detector(NAME))
        await settle()
        assert plugin.object_detectors[NAME] is old
        assert await plugin.get_object_detector(NAME) is old
        assert not old.closed
        plugin.model_manager.gate.set()
        await task
        new = plugin.object_detectors[NAME]
        assert new is not old and new.initialized and not new.closed
        assert new.labels == {0: "scooter"}
        assert old.closed
        assert refreshes == [True], "frames follow the replacement model's input size"

    asyncio.run(scenario())


def test_duplicate_updates_do_not_build_two_replacements(plugin: Any) -> None:
    async def scenario() -> None:
        await plugin.get_object_detector(NAME)
        plugin.model_manager.models.current = {"version": "2", "labels": ["scooter"]}
        plugin.model_manager.gate = asyncio.Event()
        tasks = [asyncio.create_task(plugin._reload_module_detector(NAME)) for _ in range(2)]
        await settle()
        assert len(plugin.model_manager.created) == 2, "one original and one candidate"
        plugin.model_manager.gate.set()
        await asyncio.gather(*tasks)
        assert not plugin.object_detectors[NAME].closed

    asyncio.run(scenario())


def test_newer_update_supersedes_a_pending_candidate(plugin: Any) -> None:
    async def scenario() -> None:
        old = await plugin.get_object_detector(NAME)
        plugin.model_manager.models.current = {"version": "2", "labels": ["scooter"]}
        plugin.model_manager.gate = asyncio.Event()
        task = asyncio.create_task(plugin._reload_module_detector(NAME))
        await settle()
        candidate = plugin.model_manager.created[-1]
        plugin.model_manager.models.current = {"version": "3", "labels": ["motorcycle"]}
        plugin.model_manager.gate.set()
        await task
        assert candidate.closed, "the obsolete candidate never becomes active"
        assert plugin.object_detectors[NAME].version == "3"
        assert plugin.object_detectors[NAME].labels == {0: "motorcycle"}
        assert old.closed

    asyncio.run(scenario())


def test_shutdown_during_update_does_not_revive_a_detector(plugin: Any) -> None:
    async def scenario() -> None:
        await plugin.get_object_detector(NAME)
        plugin.model_manager.models.current = {"version": "2", "labels": ["scooter"]}
        plugin.model_manager.gate = asyncio.Event()
        task = asyncio.create_task(plugin._reload_module_detector(NAME))
        await settle()
        candidate = plugin.model_manager.created[-1]
        await plugin._close_all()
        plugin.model_manager.gate.set()
        await task
        assert plugin.object_detectors == {}
        assert candidate.closed

    asyncio.run(scenario())


def test_a_failed_superseded_version_does_not_prevent_loading_the_latest(plugin: Any) -> None:
    async def scenario() -> None:
        old = await plugin.get_object_detector(NAME)
        plugin.model_manager.models.current = {"version": "2", "labels": ["scooter"]}
        plugin.model_manager.fail_versions = {"2"}
        plugin.model_manager.gate = asyncio.Event()
        task = asyncio.create_task(plugin._reload_module_detector(NAME))
        await settle()
        plugin.model_manager.models.current = {"version": "3", "labels": ["motorcycle"]}
        plugin.model_manager.gate.set()
        await task
        assert plugin.object_detectors[NAME].version == "3"
        assert old.closed

    asyncio.run(scenario())


def test_removal_while_loading_drops_the_candidate_and_the_removed_module(plugin: Any) -> None:
    async def scenario() -> None:
        old = await plugin.get_object_detector(NAME)
        plugin.model_manager.models.current = {"version": "2", "labels": ["scooter"]}
        plugin.model_manager.gate = asyncio.Event()
        task = asyncio.create_task(plugin._reload_module_detector(NAME))
        await settle()
        candidate = plugin.model_manager.created[-1]
        plugin.model_manager.models.current = None
        plugin.model_manager.gate.set()
        await task
        assert NAME not in plugin.object_detectors
        assert NAME not in plugin._module_files
        assert old.closed and candidate.closed

    asyncio.run(scenario())


def test_cancellation_keeps_the_old_detector_and_allows_another_update(plugin: Any) -> None:
    async def scenario() -> None:
        old = await plugin.get_object_detector(NAME)
        plugin.model_manager.models.current = {"version": "2", "labels": ["scooter"]}
        plugin.model_manager.gate = asyncio.Event()
        task = asyncio.create_task(plugin._reload_module_detector(NAME))
        await settle()
        candidate = plugin.model_manager.created[-1]
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert plugin.object_detectors[NAME] is old and not old.closed
        assert candidate.closed
        plugin.model_manager.gate.set()
        await plugin._reload_module_detector(NAME)
        assert plugin.object_detectors[NAME] is not old

    asyncio.run(scenario())


def test_the_server_hears_which_version_loaded_and_which_did_not(plugin: Any) -> None:
    async def scenario() -> None:
        await plugin.get_object_detector(NAME)
        plugin.model_manager.fail_versions.add("2")
        plugin.model_manager.models.current = {"id": "bikes", "version": "2", "labels": ["bicycle"]}
        await plugin._reload_module_detector(NAME)
        assert plugin.model_manager.models.reports == [("1", None), ("2", "model cannot be loaded")]
        # the working version still serves, as the server is told it loaded
        assert plugin.object_detectors[NAME].version == "1"

    asyncio.run(scenario())


def test_a_change_of_the_installed_modules_retries_a_module_that_failed(plugin: Any) -> None:
    models = plugin.model_manager.models
    plugin._object_load_failed(NAME, plugin._module_signature(NAME))
    plugin._object_load_failed("yolo-v9-s-320", None)
    assert plugin.model_failed(NAME)
    # the same files read again (the recheck after a reload of all models): the camera stays on the standard model
    models.version += 1
    plugin.check_modules()
    assert plugin.model_failed(NAME)
    # a rollback or a fixed version is tried at once, not after the wait; other models keep theirs
    models.current = {"id": "bikes", "version": "0", "labels": ["bicycle"]}
    models.version += 1
    plugin.check_modules()
    assert not plugin.model_failed(NAME)
    assert plugin.model_failed("yolo-v9-s-320")


@pytest.mark.parametrize("first", ["rollback", "failed load"])
def test_a_rollback_during_a_failing_load_is_loaded_at_once(plugin: Any, first: str) -> None:
    async def scenario() -> None:
        m = plugin.model_manager
        await plugin.get_object_detector(NAME)
        # the update to v2 does not load, v1 goes on serving
        m.models.current = {"id": "bikes", "version": "2", "labels": ["bicycle"]}
        m.fail_versions.add("2")
        m.models.version += 1
        plugin.check_modules()
        await settle()
        assert plugin.object_detectors[NAME].version == "1"
        # «Скачать модели заново»: v2 is loaded for good, does not load, and nothing serves the module
        m.loads.clear()
        await plugin._reload_models()
        plugin.check_modules()
        # its wait over, the camera's next frame loads it again in the background, slowly
        plugin._failed_models.clear()
        m.gates = {"1": asyncio.Event(), "2": asyncio.Event()}
        plugin.prepare_object_detector(NAME)
        await settle()
        # the owner presses «Вернуть v1» while that load runs: v1 loads next to it at once
        m.models.current = {"id": "bikes", "version": "1", "labels": ["bicycle"]}
        m.models.version += 1
        plugin.check_modules()
        await settle()
        for version in ("1", "2") if first == "rollback" else ("2", "1"):
            m.gates[version].set()
            await settle()
        detector = plugin.object_detectors[NAME]
        assert detector.version == "1" and detector.initialized and not detector.closed
        assert plugin._module_files[NAME] == plugin._module_signature(NAME)
        # the failure of the version gone back from holds nothing back
        assert not plugin.model_failed(NAME)

    asyncio.run(scenario())


def test_a_load_that_ends_after_its_replacement_leaves_it_in_service(plugin: Any) -> None:
    async def scenario() -> None:
        m = plugin.model_manager
        m.gates = {"1": asyncio.Event(), "2": asyncio.Event()}
        plugin.prepare_object_detector(NAME)
        await settle()
        # an update while v1 loads: v2 is loaded next to it, and ready first
        m.models.current = {"id": "bikes", "version": "2", "labels": ["scooter"]}
        m.models.version += 1
        plugin.check_modules()
        await settle()
        m.gates["2"].set()
        await settle()
        m.gates["1"].set()
        await settle()
        assert plugin.object_detectors[NAME].version == "2"
        # v2 is what serves, so going back to v1 is a change the next check acts on
        assert plugin._module_files[NAME] == plugin._module_signature(NAME)

    asyncio.run(scenario())


def test_a_change_of_another_module_does_not_load_a_loading_one_twice(plugin: Any) -> None:
    async def scenario() -> None:
        m = plugin.model_manager
        m.gates = {"1": asyncio.Event()}
        plugin.prepare_object_detector(NAME)
        await settle()
        # another module added: installed.json changed, this module's files did not
        m.models.version += 1
        plugin.check_modules()
        await settle()
        m.gates["1"].set()
        await settle()
        assert len(m.created) == 1
        assert plugin.object_detectors[NAME].initialized

    asyncio.run(scenario())


def test_a_module_that_fails_in_a_reload_of_all_models_waits_like_a_failed_load(plugin: Any) -> None:
    async def scenario() -> None:
        m = plugin.model_manager
        await plugin.get_object_detector(NAME)
        m.models.current = {"id": "bikes", "version": "2", "labels": ["bicycle"]}
        m.fail_versions.add("2")
        m.models.version += 1
        plugin.check_modules()
        await settle()
        # «Скачать модели заново»: v2 is loaded for good, and does not load
        m.loads.clear()
        await plugin._reload_models()
        assert NAME not in plugin.object_detectors and NAME not in plugin._module_files
        # the camera goes on with the standard model at once, also after the recheck that follows the reload
        assert plugin.model_failed(NAME)
        plugin.check_modules()
        assert plugin.model_failed(NAME)

    asyncio.run(scenario())


def test_a_reload_of_all_models_checks_the_modules_again(plugin: Any) -> None:
    async def scenario() -> None:
        await plugin.get_object_detector(NAME)
        await plugin._close_all()
        # the next check compares every module, so an update that came during the reload is not missed
        assert plugin._modules_version == -1

    asyncio.run(scenario())
