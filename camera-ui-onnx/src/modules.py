"""Modules of the ViON store: models packed as data (no code) that the owner adds on the "Modules" tab of the
store. The ViON server downloads them into VION_MODULES_DIR and lists the installed ones in ``installed.json``
(server/src/manager/moduleManager.ts). The plugin re-reads the list while it runs: an added module becomes one more
model choice, a removed one falls back to the default, both without a restart.

Kept identical in camera-ui-onnx and camera-ui-openvino (the legacy plugins copy them). What differs per plugin is
which model formats it loads, ``MODULE_BACKENDS`` in its defaults.py.
"""

from __future__ import annotations

import json
import os
import time
from typing import Any

MODULE_PREFIX = "vion-module-"
# installed.json changes when the owner adds or removes a module: a look at its mtime every few seconds is plenty
_CHECK_EVERY_S = 5.0
# the files a backend's model is made of, by extension (server/src/api/schemas/modules.schema.ts BACKEND_FILES)
BACKEND_FILES: dict[str, tuple[str, ...]] = {"onnx": (".onnx",), "openvino": (".xml", ".bin")}


def is_module(model_name: str | None) -> bool:
    return bool(model_name) and str(model_name).startswith(MODULE_PREFIX)


def module_name(entry: dict[str, Any]) -> str:
    return f"{MODULE_PREFIX}{entry['id']}"


class InstalledModules:
    def __init__(self, directory: str | None = None) -> None:
        self.dir = os.environ.get("VION_MODULES_DIR", "") if directory is None else directory
        self._checked = -_CHECK_EVERY_S
        self._mtime: float | None = None
        self._installed: list[dict[str, Any]] = []
        self.version = 0
        """bumps whenever the list of installed modules changes"""

    def installed(self) -> list[dict[str, Any]]:
        now = time.monotonic()
        if not self.dir or now - self._checked < _CHECK_EVERY_S:
            return self._installed
        self._checked = now
        path = os.path.join(self.dir, "installed.json")
        try:
            mtime = os.stat(path).st_mtime
        except OSError:
            if self._installed:
                self._installed = []
                self._mtime = None
                self.version += 1
            return self._installed
        if mtime != self._mtime:
            try:
                with open(path, encoding="utf-8") as handle:
                    data = json.load(handle)
            except (OSError, ValueError):
                return self._installed  # being replaced right now: keep the previous list
            self._mtime = mtime
            modules = data.get("modules") if isinstance(data, dict) else None
            self._installed = [m for m in modules or [] if isinstance(m, dict) and m.get("id")]
            self.version += 1
        return self._installed

    def files(self, entry: dict[str, Any], backends: tuple[str, ...]) -> tuple[str, dict[str, str]] | None:
        """The first backend of ``backends`` whose files are all on disk: (backend, {extension: path})."""
        raw = entry.get("files")
        offered: dict[str, Any] = raw if isinstance(raw, dict) else {}
        for backend in backends:
            paths: dict[str, str] = {}
            for file in offered.get(backend) or []:
                path = str(file.get("path", "")) if isinstance(file, dict) else ""
                extension = os.path.splitext(path)[1]
                if extension in BACKEND_FILES.get(backend, ()):
                    paths[extension] = path
            needed = BACKEND_FILES.get(backend, ())
            if needed and all(ext in paths and os.path.isfile(paths[ext]) for ext in needed):
                return backend, paths
        return None

    def detectors(self, backends: tuple[str, ...]) -> list[dict[str, Any]]:
        """Installed detector modules this plugin can load, in the order they were installed."""
        return [m for m in self.installed() if m.get("task") == "detector" and self.files(m, backends)]

    def entry(self, name: str, backends: tuple[str, ...]) -> dict[str, Any] | None:
        """The installed entry of a ``vion-module-<id>`` model name, when this plugin can load it."""
        if not is_module(name):
            return None
        module_id = name[len(MODULE_PREFIX) :]
        for entry in self.detectors(backends):
            if entry.get("id") == module_id:
                return entry
        return None

    def paths(self, name: str, backends: tuple[str, ...]) -> tuple[str, dict[str, str]]:
        entry = self.entry(name, backends)
        found = self.files(entry, backends) if entry else None
        if not found:
            raise FileNotFoundError(f"module {name} is not installed for {', '.join(backends)}")
        return found

    def choices(self, backends: tuple[str, ...], language: str = "ru") -> dict[str, str]:
        """Model names of the installed detector modules with their titles, for the model setting."""
        result: dict[str, str] = {}
        for entry in self.detectors(backends):
            raw = entry.get("name")
            names: dict[str, Any] = raw if isinstance(raw, dict) else {}
            title = names.get(language) or names.get("en") or entry["id"]
            result[module_name(entry)] = str(title)
        return result


installed_modules = InstalledModules()


def usable_choice(
    requested: str | None, backends: tuple[str, ...], default_option: str = "default"
) -> str | None:
    """The stored model choice, or the default when it names a module that was removed in the store."""
    if is_module(requested) and not installed_modules.entry(str(requested), backends):
        return default_option
    return requested
