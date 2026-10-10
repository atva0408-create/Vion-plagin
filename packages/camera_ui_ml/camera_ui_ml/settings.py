from __future__ import annotations

from typing import Any, cast

from camera_ui_sdk import DeviceStorage


async def reset_stored_settings(storage: DeviceStorage[Any]) -> None:
    # a save fails with its onSet's words (a default model that does not load): the settings after it are reset all
    # the same, and every failure is said at the end
    failures: list[str] = []
    for schema in storage.schemas:
        entry = cast("dict[str, Any]", schema)
        if entry.get("store") and "defaultValue" in entry:
            try:
                await storage.setValue(entry["key"], entry["defaultValue"])
            except Exception as error:
                failures.append(str(error))
    if failures:
        raise Exception("; ".join(failures))
