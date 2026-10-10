"""The «Сбросить» of the ML sensors' settings: every stored setting back to its default.

The plugin runtime now fails a save with its onSet's words: a default model that does not load must not leave the
settings after it unreset. settings.py is loaded alone: the package's __init__ asks for a newer camera_ui_sdk than a
development machine may have.

    python -m pytest packages/camera_ui_ml/tests/test_settings.py
"""

from __future__ import annotations

import asyncio
import importlib.util
from pathlib import Path
from typing import Any

import pytest

_spec = importlib.util.spec_from_file_location(
    "camera_ui_ml_settings", Path(__file__).resolve().parents[1] / "camera_ui_ml" / "settings.py"
)
assert _spec and _spec.loader
_settings = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_settings)
reset_stored_settings = _settings.reset_stored_settings


class Storage:
    """The plugin runtime's storage as the reset sees it: a save fails with its onSet's words (`key: message`)."""

    def __init__(self, schemas: list[dict[str, Any]], failing: dict[str, str]) -> None:
        self.schemas = schemas
        self.failing = failing
        self.values: dict[str, Any] = {}

    async def setValue(self, key: str, value: Any) -> None:
        self.values[key] = value
        if key in self.failing:
            raise Exception(f"{key}: {self.failing[key]}")


def schemas() -> list[dict[str, Any]]:
    return [
        {"key": "model", "store": True, "defaultValue": "default"},
        {"key": "confidence", "store": True, "defaultValue": 0.5},
        {"key": "reset", "store": False},
        {"key": "classes", "store": True, "defaultValue": ["person"]},
    ]


def test_resets_every_stored_setting_to_its_default():
    storage = Storage(schemas(), {})
    asyncio.run(reset_stored_settings(storage))  # type: ignore[arg-type]
    assert storage.values == {"model": "default", "confidence": 0.5, "classes": ["person"]}


def test_a_default_model_that_does_not_load_leaves_no_setting_unreset():
    storage = Storage(schemas(), {"model": "the mirror did not answer"})
    with pytest.raises(Exception, match="model: the mirror did not answer"):
        asyncio.run(reset_stored_settings(storage))  # type: ignore[arg-type]
    assert storage.values == {"model": "default", "confidence": 0.5, "classes": ["person"]}


def test_every_failure_is_said():
    storage = Storage(schemas(), {"model": "no model", "classes": "no labels"})
    with pytest.raises(Exception, match="model: no model; classes: no labels"):
        asyncio.run(reset_stored_settings(storage))  # type: ignore[arg-type]
