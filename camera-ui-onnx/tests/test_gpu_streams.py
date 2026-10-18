"""Calls of one CUDA session at the same time (main.py, _cuda_options; inference.py runs two per GPU session).

On the bench (GTX 1050 Ti, onnxruntime-gpu 1.26, cuDNN 9.1) the GPU was lost three times in a day, 2026-10-18: Xid 31
(MMU fault) and Xid 13 (misaligned address), «CUDA failure 700/716», the first failing call in a Conv node of the
object detector. Repeated on a GTX 1660 Ti with the same onnxruntime and cuDNN: with two or three threads calling one
session, answers came back wrong within a minute (detector boxes off by hundreds of pixels, the plate reader's
letters, a plate detector's answer of another shape), and one run of three minutes ended in
CUDNN_STATUS_EXECUTION_FAILED in a Conv and the process gone; the same threads one call at a time: 0 wrong of 28,000.
Each call of a session took a CUDA stream of its own, and buffers of one were used by another. One stream per session
(use_ep_level_unified_stream): 0 wrong of 34,000 calls of seven models, as fast as before (serializing the calls cost
up to 8 %).

    python -m pytest camera-ui-onnx/tests/test_gpu_streams.py
    # on a machine with CUDA, the models of the mirror (models.vionvision.tech/v1/onnx/<name>/<name>.onnx) in a folder:
    VION_GPU_MODELS=<folder> VION_GPU_SECONDS=60 python -m pytest camera-ui-onnx/tests/test_gpu_streams.py
"""

from __future__ import annotations

import ast
import os
import threading
import time
from pathlib import Path
from typing import Any

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[2]
# the models that went wrong first on the 1660 Ti: two object detectors and the plate reader
MODELS = ["yolo-v9-c-320", "yolo-v9-s-320", "cct-xs-v2-global"]
THREADS = 3


def _cuda_options() -> Any:
    path = ROOT / "camera-ui-onnx" / "src" / "main.py"
    tree = ast.parse(path.read_text(encoding="utf-8"))
    cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "ONNXPlugin")
    method = next(
        node for node in cls.body if isinstance(node, ast.FunctionDef) and node.name == "_cuda_options"
    )
    method.decorator_list = []
    module = ast.Module(
        body=[ast.ImportFrom(module="typing", names=[ast.alias(name="Any")], level=0), method],
        type_ignores=[],
    )
    ast.fix_missing_locations(module)
    namespace: dict[str, Any] = {}
    exec(compile(module, str(path), "exec"), namespace)
    return namespace["_cuda_options"]


def test_one_stream_per_session() -> None:
    options = _cuda_options()(0)
    assert options["use_ep_level_unified_stream"] == "1"
    assert options["device_id"] == 0


def _feeds(session: Any, rng: np.random.Generator) -> dict[str, Any]:
    feeds: dict[str, Any] = {}
    for inp in session.get_inputs():
        shape = [dim if isinstance(dim, int) and dim > 0 else 1 for dim in inp.shape]
        if inp.type == "tensor(uint8)":
            feeds[inp.name] = rng.integers(0, 255, shape, dtype=np.uint8)
        else:
            feeds[inp.name] = rng.random(shape, dtype=np.float32)
    return feeds


def _differs(outputs: list[Any], reference: list[Any]) -> bool:
    for out, ref in zip(outputs, reference, strict=True):
        if out.shape != ref.shape:
            return True
        if out.size and float(np.max(np.abs(out.astype(np.float64) - ref.astype(np.float64)))) > 1e-2:
            return True
    return False


def test_calls_at_once_answer_as_alone() -> None:
    folder = os.environ.get("VION_GPU_MODELS")
    if not folder:
        pytest.skip("VION_GPU_MODELS is not set: no models for the GPU run")
    ort = pytest.importorskip("onnxruntime")
    if hasattr(ort, "preload_dlls"):
        ort.preload_dlls()
    if "CUDAExecutionProvider" not in ort.get_available_providers():
        pytest.skip("no CUDA in this onnxruntime")
    seconds = float(os.environ.get("VION_GPU_SECONDS", "60"))

    rng = np.random.default_rng(7)
    models = []
    for name in MODELS:
        session = ort.InferenceSession(
            os.path.join(folder, name, f"{name}.onnx"),
            providers=[("CUDAExecutionProvider", _cuda_options()(0)), "CPUExecutionProvider"],
        )
        assert session.get_providers()[0] == "CUDAExecutionProvider", name
        cases = []
        for _ in range(4):
            feed = _feeds(session, rng)
            cases.append((feed, [np.array(out) for out in session.run(None, feed)]))
        models.append((name, session, cases))

    wrong: list[str] = []
    failed: list[str] = []
    calls = [0]
    lock = threading.Lock()
    stop = time.monotonic() + seconds

    def work(name: str, session: Any, cases: list[Any], seed: int) -> None:
        pick = np.random.default_rng(seed)
        while time.monotonic() < stop and not failed:
            feed, reference = cases[int(pick.integers(len(cases)))]
            try:
                outputs = session.run(None, feed)
            except Exception as error:  # the failure is the finding: kept and the run ends
                with lock:
                    failed.append(f"{name}: {error}")
                return
            with lock:
                calls[0] += 1
                if _differs(outputs, reference):
                    wrong.append(name)

    threads = [
        threading.Thread(target=work, args=(name, session, cases, i * THREADS + k), daemon=True)
        for i, (name, session, cases) in enumerate(models)
        for k in range(THREADS)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert not failed, failed[0]
    assert calls[0] > 1000, f"too few calls to tell: {calls[0]}"
    assert not wrong, f"{len(wrong)} wrong of {calls[0]} calls: {sorted(set(wrong))}"
