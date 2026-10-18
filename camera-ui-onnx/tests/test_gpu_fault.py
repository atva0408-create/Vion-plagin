"""The ONNX plugins when the GPU stops working for their process (src/gpu_fault.py).

On the bench a CUDA fault (Xid 31, «CUDA failure 700: an illegal memory access») left ONNX Legacy answering every model
call with that error for 3.5 hours: no detection on three cameras, no search index, until a restart by hand. The first
call that loses the GPU now ends the process, which the server starts again; a GPU that keeps failing sends the models to
the CPU instead of restarting the plugin for good. The real methods of the plugin run here on fakes.

    python -m pytest camera-ui-onnx/tests/test_gpu_fault.py
"""

from __future__ import annotations

import ast
import importlib.util
import threading
import types
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[2]
# ONNX Legacy runs the same sources (camera-ui-onnx-legacy/scripts/sync.mjs copies src at build)
PLUGINS = ["onnx"]
BENCH_ERROR = (
    "[ONNXRuntimeError] : 1 : FAIL : CUDA failure 700: an illegal memory access was encountered ; GPU=0 ; "
    "hostname=artem-HP-Pavilion-Notebook ; file=/onnxruntime_src/onnxruntime/core/providers/cuda/cuda_execution_provider.cc"
    " ; line=534 ; expr=cudaStreamSynchronize(static_cast<cudaStream_t>(stream_));"
)
OOM_ERROR = (
    "[ONNXRuntimeError] : 1 : FAIL : Exception during initialization: /onnxruntime_src/onnxruntime/core/framework/"
    "bfc_arena.cc:358 void* onnxruntime::BFCArena::AllocateRawInternal(size_t, bool, onnxruntime::Stream*) Failed to "
    "allocate memory for requested buffer of size 147456"
)


def _gpu_fault(plugin: str) -> types.ModuleType:
    path = ROOT / f"camera-ui-{plugin}" / "src" / "gpu_fault.py"
    spec = importlib.util.spec_from_file_location(f"gpu_fault_{plugin.replace('-', '_')}", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _method(plugin: str, file: str, cls_suffix: str, names: set[str], namespace: dict[str, Any]) -> type:
    path = ROOT / f"camera-ui-{plugin}" / "src" / file
    tree = ast.parse(path.read_text(encoding="utf-8"))
    cls = next(
        node for node in tree.body if isinstance(node, ast.ClassDef) and node.name.endswith(cls_suffix)
    )
    cls.bases = []
    cls.decorator_list = []
    cls.body = [
        node
        for node in cls.body
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef) and node.name in names
    ]
    missing = names - {node.name for node in cls.body}
    assert not missing, f"{path}: no {missing}"
    module = ast.Module(
        body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), cls],
        type_ignores=[],
    )
    ast.fix_missing_locations(module)
    exec(compile(module, str(path), "exec"), namespace)
    return namespace[cls.name]


class Clock:
    def __init__(self) -> None:
        self.t = 1_000_000.0

    def __call__(self) -> float:
        return self.t


class Logger:
    def __init__(self) -> None:
        self.lines: list[tuple[str, str]] = []

    def __getattr__(self, level: str) -> Any:
        return lambda message: self.lines.append((level, str(message)))


@pytest.fixture(params=PLUGINS)
def plugin(request: pytest.FixtureRequest) -> str:
    return request.param


def test_the_error_that_loses_the_gpu_is_told_from_one_that_does_not(plugin: str) -> None:
    gf = _gpu_fault(plugin)
    assert gf.is_device_lost(RuntimeError(BENCH_ERROR))
    assert gf.is_device_lost(RuntimeError("CUDA failure 719: unspecified launch failure"))
    assert gf.is_device_lost(RuntimeError("CUDA failure 716: misaligned address"))
    # an allocation that failed, a wrong input: the next call can succeed
    assert not gf.is_device_lost(RuntimeError(OOM_ERROR))
    assert not gf.is_device_lost(RuntimeError("CUDA failure 2: out of memory"))
    assert not gf.is_device_lost(RuntimeError("CUDA failure 7000: something else"))
    assert not gf.is_device_lost(ValueError("Got invalid dimensions for input: images"))


def test_the_failures_are_counted_over_restarts_within_the_hour(plugin: str, tmp_path: Path) -> None:
    gf = _gpu_fault(plugin)
    clock = Clock()
    faults = gf.GpuFaults(str(tmp_path / "gpu-faults.json"), now=clock)
    for _ in range(gf.LIMIT - 1):
        faults.record()
        clock.t += 60
    assert not faults.too_many()
    # another process of the plugin, after a restart, reads the same file
    gf.GpuFaults(str(tmp_path / "gpu-faults.json"), now=clock).record()
    assert faults.too_many()
    clock.t += gf.WINDOW_S
    assert not faults.too_many(), "an hour without a failure: the GPU is tried again"
    # a file that cannot be read or written changes nothing else
    (tmp_path / "broken.json").write_text("{not json", encoding="utf-8")
    assert gf.GpuFaults(str(tmp_path / "broken.json"), now=clock).recent() == []
    gf.GpuFaults(str(tmp_path / "no-dir" / "x.json"), now=clock).record()


def test_the_loss_ends_the_process_once_and_says_why(plugin: str, tmp_path: Path) -> None:
    gf = _gpu_fault(plugin)
    faults = gf.GpuFaults(str(tmp_path / "gpu-faults.json"))
    logger = Logger()
    exits: list[int] = []
    lost = gf.DeviceLoss(faults, logger, lambda: exits.append(1))
    threads = [threading.Thread(target=lost, args=(RuntimeError(BENCH_ERROR),)) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert exits == [1], "every model fails at once: one restart"
    assert len(faults.recent()) == 1
    assert [level for level, _ in logger.lines] == ["error"]
    assert "CUDA failure 700" in logger.lines[0][1]


class Session:
    def __init__(self, error: Exception | None = None) -> None:
        self.error = error

    def run(self, _names: Any, _feed: Any) -> list[str]:
        if self.error:
            raise self.error
        return ["boxes"]


def test_a_model_call_that_loses_the_gpu_hands_it_on_and_still_fails(plugin: str) -> None:
    gf = _gpu_fault(plugin)
    backend_cls = _method(
        plugin,
        "inference.py",
        "OnnxBackend",
        {"_run"},
        {"threading": threading, "Any": Any, "Outputs": Any, "is_device_lost": gf.is_device_lost},
    )
    for error, handed in [(RuntimeError(BENCH_ERROR), True), (RuntimeError(OOM_ERROR), False)]:
        seen: list[BaseException] = []
        backend = backend_cls()
        backend._sessions = [Session(error)]
        backend._by_thread = {}
        backend._input_names = ["images"]
        backend._on_device_lost = seen.append
        with pytest.raises(RuntimeError):
            backend._run([0])
        assert seen == ([error] if handed else []), error
    # a call that works is untouched
    backend._sessions = [Session()]
    assert backend._run([0]) == ["boxes"]


def test_a_gpu_that_keeps_failing_sends_the_models_to_the_cpu(plugin: str) -> None:
    namespace: dict[str, Any] = {
        "Any": Any,
        "ProviderList": Any,
        "DEFAULT_EXECUTION_PROVIDER": "auto",
        "GPU_FAULT_LIMIT": _gpu_fault(plugin).LIMIT,
        "os": __import__("os"),
        "platform": types.SimpleNamespace(system=lambda: "Linux", machine=lambda: "x86_64"),
        "ort": types.SimpleNamespace(
            get_available_providers=lambda: ["CUDAExecutionProvider", "CPUExecutionProvider"]
        ),
    }
    plugin_cls = _method(
        plugin, "main.py", "Plugin", {"_resolve_provider_lists", "_device_ids", "_cuda_options"}, namespace
    )
    for too_many, expected in [(False, "CUDAExecutionProvider"), (True, "CPUExecutionProvider")]:
        instance = plugin_cls()
        instance.storage = types.SimpleNamespace(values={"execution_provider": "auto"})
        instance.api = types.SimpleNamespace(storagePath="/tmp")
        instance.logger = Logger()
        instance._warned_provider = None
        instance._warned_gpu_faults = False
        instance.model_manager = types.SimpleNamespace(
            gpu_faults=types.SimpleNamespace(too_many=lambda flag=too_many: flag)
        )
        lists = instance._resolve_provider_lists()
        first = lists[0][0]
        assert (first[0] if isinstance(first, tuple) else first) == expected, too_many
        if too_many:
            instance._resolve_provider_lists()
            assert [level for level, _ in instance.logger.lines] == ["error"], "said once, not at every model"
