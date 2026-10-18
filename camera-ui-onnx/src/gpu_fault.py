"""When the GPU stops working for this process.

A CUDA error of this kind (an illegal memory access, a failed launch: NVIDIA's Xid 31 on the bench, 2026-10-18) leaves
the CUDA context of the process unusable: every later call of every model fails the same way. The plugin stayed so
until it was restarted by hand, 3.5 hours without detection on three cameras and without the search index. Only a new
process gets a working context: the plugin ends and the server starts it again. A GPU that keeps failing would restart
it for good, so after LIMIT failures within WINDOW_S the models go to the CPU (main.py, _resolve_provider_lists).
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from collections.abc import Callable
from typing import Any

# cudaErrorIllegalAddress 700, HardwareStackError 714, IllegalInstruction 715, MisalignedAddress 716,
# InvalidAddressSpace 717, InvalidPc 718, LaunchFailure 719: «the process is left in an inconsistent state and any
# further CUDA work will return the same error» (CUDA runtime API). An allocation that failed is none of these: the
# next call can succeed
_STICKY = re.compile(r"CUDA failure (?:700|71[4-9])\b|illegal memory access|unspecified launch failure")

LIMIT = 3
WINDOW_S = 60 * 60


def is_device_lost(error: BaseException) -> bool:
    return bool(_STICKY.search(str(error)))


class GpuFaults:
    """The times the GPU was lost, kept beside the plugin's storage over its restarts."""

    def __init__(self, path: str, now: Callable[[], float] = time.time) -> None:
        self._path = path
        self._now = now

    def recent(self) -> list[float]:
        try:
            with open(self._path, encoding="utf-8") as file:
                times = json.load(file)
        except (OSError, ValueError):
            return []
        since = self._now() - WINDOW_S
        return (
            [t for t in times if isinstance(t, int | float) and t > since] if isinstance(times, list) else []
        )

    def record(self) -> None:
        times = [*self.recent(), self._now()]
        try:
            part = f"{self._path}.part"
            with open(part, "w", encoding="utf-8") as file:
                json.dump(times, file)
            os.replace(part, self._path)
        except OSError:
            # a storage that cannot be written: the restart happens all the same, only the count is lost
            pass

    def too_many(self) -> bool:
        return len(self.recent()) >= LIMIT


class DeviceLoss:
    """Called with the error of the first call that lost the GPU: counts it, says so and ends the process, once."""

    def __init__(self, faults: GpuFaults, logger: Any, exit_process: Callable[[], None]) -> None:
        self._faults = faults
        self._logger = logger
        self._exit_process = exit_process
        self._lock = threading.Lock()
        self._lost = False

    def __call__(self, error: BaseException) -> None:
        with self._lock:
            if self._lost:
                return
            self._lost = True
        self._faults.record()
        self._logger.error(
            f"Видеокарта перестала работать в этом процессе ({error}): все модели на ней отвечают ошибкой. "
            "Плагин перезапускается, чтобы получить её заново"
        )
        self._exit_process()


def exit_soon(delay_s: float = 1.0) -> None:
    """Ends the process after the log line is out; the server starts the plugin again."""
    timer = threading.Timer(delay_s, os._exit, args=(1,))
    timer.daemon = True
    timer.start()
