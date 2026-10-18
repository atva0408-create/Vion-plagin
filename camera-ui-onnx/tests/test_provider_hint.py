"""What the ONNX plugins say when a model cannot get the GPU and goes to the CPU (model_manager.py, _create_session).

On the bench the GPU was full (two processes of ONNX Legacy, every model twice): the object detector got «Failed to
allocate memory» from CUDA and went to the CPU, and the plugin said «Для распознавания на CUDA этому плагину нужны
библиотеки CUDA 12…»: a wrong cause, a wrong thing to do. Memory that ran out is said as such, per model; the advice on
the CUDA libraries stays for an accelerated provider that does not start.

    python -m pytest camera-ui-onnx/tests/test_provider_hint.py
"""

from __future__ import annotations

import ast
import types
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
CUDA = [("CUDAExecutionProvider", {"device_id": 0}), "CPUExecutionProvider"]
OOM = (
    "[ONNXRuntimeError] : 1 : FAIL : Exception during initialization: /onnxruntime_src/onnxruntime/core/framework/"
    "bfc_arena.cc:358 void* onnxruntime::BFCArena::AllocateRawInternal(size_t, bool, onnxruntime::Stream*) Failed to "
    "allocate memory for requested buffer of size 147456"
)
NO_LIBS = (
    "[ONNXRuntimeError] : 1 : FAIL : Failed to load library libonnxruntime_providers_cuda.so with error: "
    "libcublasLt.so.12: cannot open shared object file: No such file or directory"
)


class Logger:
    def __init__(self) -> None:
        self.lines: list[str] = []

    def __getattr__(self, _level: str) -> Any:
        return lambda message: self.lines.append(str(message))


def _manager(error: str) -> Any:
    path = ROOT / "camera-ui-onnx" / "src" / "model_manager.py"
    tree = ast.parse(path.read_text(encoding="utf-8"))
    cls = next(
        node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "OnnxModelManager"
    )
    cls.bases = []
    cls.body = [
        node for node in cls.body if isinstance(node, ast.FunctionDef) and node.name not in {"__init__"}
    ]
    helpers = [
        node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "_out_of_memory"
    ]
    module = ast.Module(
        body=[
            ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0),
            *helpers,
            cls,
        ],
        type_ignores=[],
    )
    ast.fix_missing_locations(module)

    def session(path: str, providers: Any = None, **_: Any) -> Any:
        raise RuntimeError(error)

    namespace: dict[str, Any] = {
        "Any": Any,
        "os": __import__("os"),
        "LEGACY_RUNTIME": True,
        "ort": types.SimpleNamespace(InferenceSession=session, __version__="1.22.0"),
    }
    exec(compile(module, str(path), "exec"), namespace)
    manager = namespace["OnnxModelManager"].__new__(namespace["OnnxModelManager"])
    manager.logger = Logger()
    manager._hinted_legacy = False
    manager._create_cpu_session = lambda path: f"cpu:{path}"
    return manager


def test_memory_that_ran_out_is_said_as_such_per_model_without_the_cuda_libraries() -> None:
    manager = _manager(OOM)
    assert (
        manager._create_session("/models/yolo-v9-s-320.onnx", list(CUDA)) == "cpu:/models/yolo-v9-s-320.onnx"
    )
    assert (
        manager._create_session("/models/arcface-r100-512.onnx", list(CUDA))
        == "cpu:/models/arcface-r100-512.onnx"
    )
    said = "\n".join(manager.logger.lines)
    assert "CUDA 12" not in said and "CUDA 13" not in said, said
    assert said.count("памяти видеокарты") == 2, said
    assert "yolo-v9-s-320" in said and "arcface-r100-512" in said


def test_a_provider_that_does_not_start_still_gets_the_advice_on_its_libraries_once() -> None:
    manager = _manager(NO_LIBS)
    manager._create_session("/models/a.onnx", list(CUDA))
    manager._create_session("/models/b.onnx", list(CUDA))
    said = "\n".join(manager.logger.lines)
    assert said.count("библиотеки CUDA 12") == 1, said
