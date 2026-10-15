"""The picture try-out of the object detectors (``testObjectDetection``) takes the threshold it is asked for.

«Обвести объект» on the Xiaomi found no one where a boy lay on the bed: the model scored him 0.16-0.46 in 4 of 15
frames (the bench, 2026-10-15 23:21-23:26), and every plugin dropped whatever is under 0.5 before answering, so the
outline could not ask for less. The real ``testObjectDetection`` of the detector plugins runs here on a fake
detector; without a threshold in the request the plugin's own stays, as for every other try-out.

    python -m pytest camera-ui-onnx/tests/test_test_detection_threshold.py
"""

from __future__ import annotations

import ast
import asyncio
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[2]
# the legacy plugins are built from these two sources (their src/ is a copy, not in git)
PLUGINS = ["onnx", "openvino"]


class Detector:
    initialized = True
    labels = {0: "person"}

    def __init__(self) -> None:
        self.thresholds: list[float | None] = []

    async def detect_single(self, _image: bytes, _metadata: Any, threshold: float | None = None) -> list[Any]:
        self.thresholds.append(threshold)
        return [(0, 0.46, {"x": 0.07, "y": 0.38, "width": 0.35, "height": 0.22})]


@pytest.fixture(params=PLUGINS)
def plugin(request: pytest.FixtureRequest) -> Any:
    path = ROOT / f"camera-ui-{request.param}" / "src" / "main.py"
    tree = ast.parse(path.read_text(encoding="utf-8"))
    method = next(
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "testObjectDetection"
    )
    helpers = [
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef | ast.Assign)
        and _defines(node, {"tryout_threshold", "TRYOUT_THRESHOLD_MIN"})
    ]
    cls = ast.ClassDef(name="Plugin", bases=[], keywords=[], body=[method], decorator_list=[], type_params=[])
    module = ast.Module(
        body=[
            ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0),
            *helpers,
            cls,
        ],
        type_ignores=[],
    )
    namespace: dict[str, Any] = {
        "Any": Any,
        "usable_choice": lambda value, _backends, default: value or default,
        "MODULE_BACKENDS": {},
        "DEFAULT_OPTION": "default",
        "DEFAULT_OBJECT_MODEL": "yolo-v9-s-320",
        "resolve_object_model": lambda requested, default, option: (
            default if requested == option else requested
        ),
    }
    exec(compile(ast.fix_missing_locations(module), str(path), "exec"), namespace)
    instance = object.__new__(namespace["Plugin"])
    instance.detector = Detector()

    async def get_object_detector(_name: str) -> Detector:
        return instance.detector

    instance.get_object_detector = get_object_detector
    return instance


def _defines(node: ast.stmt, names: set[str]) -> bool:
    if isinstance(node, ast.FunctionDef):
        return node.name in names
    return any(isinstance(target, ast.Name) and target.id in names for target in node.targets)  # type: ignore[union-attr]


def detect(plugin: Any, config: dict[str, Any]) -> list[Any]:
    plugin.detector.thresholds.clear()
    asyncio.run(plugin.testObjectDetection(b"png", {"width": 2304, "height": 1296}, config))
    return plugin.detector.thresholds


def test_the_threshold_asked_for_is_the_one_the_model_keeps(plugin: Any) -> None:
    assert detect(plugin, {"threshold": 0.25}) == [0.25]


def test_without_one_the_plugin_keeps_its_own(plugin: Any) -> None:
    assert detect(plugin, {}) == [None]


def test_a_threshold_out_of_reason_is_held_to_its_bounds(plugin: Any) -> None:
    # a picture of only noise boxes, or a try-out that can find nothing
    assert detect(plugin, {"threshold": 0}) == [0.05]
    assert detect(plugin, {"threshold": 7}) == [1.0]
    assert detect(plugin, {"threshold": "much"}) == [None]
    assert detect(plugin, {"threshold": True}) == [None]
