"""A classifier version given out no more is unloaded (ViON audit 2026-10-23, ML3).

Every new version of a question (a module's next training) came with a new name: the old one stayed loaded in
attribute_backends for the life of the process, one more model in memory with every version. The detectors given out no
more were already dropped when the manifest changed; the classifiers now are too. The real methods of the ONNX and
OpenVINO plugins run here on fakes.

    python -m pytest camera-ui-onnx/tests/test_attribute_backends.py
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest
from test_load_state import _class_of, _compile

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(params=["onnx", "openvino", "onnx-legacy", "openvino-legacy"])
def engine(request: pytest.FixtureRequest) -> str:
    if not (ROOT / f"camera-ui-{request.param}" / "src" / "main.py").exists():
        pytest.skip(f"camera-ui-{request.param} not synced: node camera-ui-{request.param}/scripts/sync.mjs")
    return str(request.param)


class Manifest:
    def __init__(self, given: set[str]) -> None:
        self.version = 1
        self.given = given

    def manifest(self) -> dict[str, Any]:
        return {}

    def entry(self, name: str) -> dict[str, Any] | None:
        return {"id": name} if name in self.given else None


class Backend:
    def __init__(self) -> None:
        self.closed = False

    def close(self) -> None:
        self.closed = True


class Recorder:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def forget(self, name: str) -> None:
        self.calls.append(name)

    def log(self, message: str) -> None:
        self.calls.append(message)


def plugin_of(engine: str, manifest: Manifest) -> Any:
    cls, path = _class_of(
        ROOT / f"camera-ui-{engine}" / "src" / "main.py",
        "Plugin",
        {"check_trained_models", "_drop_trained_detector", "_drop_attribute_backend"},
    )
    namespace: dict[str, Any] = {
        "trained_models": manifest,
        "is_trained": lambda _name: True,
        "asyncio": asyncio,
        "Any": Any,
    }
    plugin = object.__new__(_compile(cls, path, namespace))
    plugin._trained_version = 0
    plugin._sensors = {}
    plugin.object_detectors = {}
    plugin._failed_models = {}
    plugin.model_manager = Recorder()
    plugin.logger = Recorder()
    return plugin


def test_a_classifier_given_out_no_more_is_unloaded(engine: str) -> None:
    manifest = Manifest(given={"vion-attr-kid-v2"})
    plugin = plugin_of(engine, manifest)
    old, current = Backend(), Backend()
    plugin.attribute_backends = {"vion-attr-kid-v1": old, "vion-attr-kid-v2": current}

    plugin.check_trained_models()

    assert plugin.attribute_backends == {"vion-attr-kid-v2": current}
    assert old.closed and not current.closed
    assert "vion-attr-kid-v1" in plugin.model_manager.calls, (
        "the next ensure_backend of that name loads it again"
    )


def test_nothing_is_unloaded_while_the_manifest_is_the_same(engine: str) -> None:
    manifest = Manifest(given=set())
    plugin = plugin_of(engine, manifest)
    plugin._trained_version = manifest.version
    kept = Backend()
    plugin.attribute_backends = {"vion-attr-kid-v1": kept}

    plugin.check_trained_models()

    assert plugin.attribute_backends == {"vion-attr-kid-v1": kept}
    assert not kept.closed
