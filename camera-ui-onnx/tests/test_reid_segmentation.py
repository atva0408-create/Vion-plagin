"""People who look alike and outlines of objects in the detection plugins (src/reid.py and its sensors, kept identical in
the ONNX and OpenVINO plugins; the legacy plugins copy them).

The models load when they are first needed, never at start: every camera of every ML plugin process gets these sensors,
and a model each in every process once hung the 8 GB bench.

    python3 -m pytest camera-ui-onnx/tests/test_reid_segmentation.py
"""

from __future__ import annotations

import asyncio
import io
import os
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
ONNX_SRC = ROOT / "camera-ui-onnx" / "src"
OPENVINO_SRC = ROOT / "camera-ui-openvino" / "src"
SDK = os.environ.get("CAMERA_UI_SDK_PYTHON")
if SDK:
    sys.path.insert(0, SDK)
sys.path.insert(0, str(ONNX_SRC))

import reid  # noqa: E402
from sensors.person_embedder_sensor import ONNXPersonEmbedderSensor  # noqa: E402
from sensors.segmenter_sensor import ONNXSegmenterSensor  # noqa: E402


class Logger:
    def __init__(self) -> None:
        self.lines: list[str] = []

    def log(self, *args: Any) -> None:
        self.lines.append(" ".join(map(str, args)))

    success = error = warn = debug = log


class Backend:
    """Records what the model was given and answers with fixed outputs."""

    def __init__(self, outputs: list[Any], input_size: tuple[int, int] = (320, 320)) -> None:
        self.outputs = outputs
        self.input_size = input_size
        self.calls: list[tuple[tuple[int, ...], Any, Any]] = []

    async def run(self, rgb: Any, spec: Any) -> list[Any]:
        self.calls.append((rgb.shape, spec, rgb.max()))
        return self.outputs

    def close(self) -> None:
        pass


def ready(detector: Any, backend: Backend) -> Any:
    detector.backend = backend
    detector.initialized = True
    return detector


def jpeg(width: int, height: int) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (width, height), (200, 10, 10)).save(out, format="JPEG")
    return out.getvalue()


def test_the_plugins_carry_the_same_files() -> None:
    assert (ONNX_SRC / "reid.py").read_bytes() == (OPENVINO_SRC / "reid.py").read_bytes()
    for name in ("sensors/person_embedder_sensor.py", "sensors/segmenter_sensor.py"):
        # the same code under other names; the formatter wraps the longer names differently
        onnx = "".join((ONNX_SRC / name).read_text(encoding="utf-8").split())
        openvino = "".join((OPENVINO_SRC / name).read_text(encoding="utf-8").split())
        assert onnx == openvino.replace("OpenVino", "ONNX"), name


# ------------------------------------------------------------------ the person embedder


def test_a_person_is_stretched_to_the_model_and_given_raw_pixels() -> None:
    backend = Backend([np.array([[3.0, 4.0]])])
    embedder = ready(reid.PersonEmbedder(None, Logger()), backend)  # type: ignore[arg-type]
    crop = np.full((90, 30, 3), 255, dtype=np.uint8)  # a tall tight box
    vector = asyncio.run(embedder.embed(crop))
    shape, spec, brightest = backend.calls[0]
    assert shape == (256, 128, 3), "stretched to 128x256, never padded"
    assert (spec.width, spec.height, spec.normalize) == (128, 256, "none"), "the graph normalizes the pixels itself"
    assert brightest == 255
    assert vector == pytest.approx([0.6, 0.8]), "unit length"


def test_nobody_to_embed_is_an_empty_vector() -> None:
    embedder = reid.PersonEmbedder(None, Logger())  # type: ignore[arg-type]
    assert asyncio.run(embedder.embed(np.zeros((10, 10, 3), dtype=np.uint8))) == [], "not loaded"
    backend = Backend([np.array([[1.0, 0.0]])])
    ready(embedder, backend)
    results = asyncio.run(reid.embed_person_images(embedder, [b"not a picture", jpeg(40, 100)], "reid-test"))
    assert results[0] == {"embedding": [], "embeddingModel": "reid-test"}, "an unreadable picture"
    assert results[1]["embedding"] == pytest.approx([1.0, 0.0]) and len(backend.calls) == 1, "the others still are"


def test_frames_from_the_server_are_embedded() -> None:
    backend = Backend([np.array([[0.0, 2.0]])])
    embedder = ready(reid.PersonEmbedder(None, Logger()), backend)  # type: ignore[arg-type]
    frame = {"id": "f", "data": bytes(20 * 50 * 3), "width": 20, "height": 50, "format": "rgb"}
    assert asyncio.run(reid.embed_persons(embedder, [frame], "reid-test")) == [  # type: ignore[list-item]
        {"embedding": pytest.approx([0.0, 1.0]), "embeddingModel": "reid-test"}
    ]


# ------------------------------------------------------------------ the segmenter


def outputs(*candidates: tuple[float, float, float, float, float, float]) -> list[Any]:
    """YOLO segmentation outputs for one class: (cx, cy, w, h, score, coefficient) each, in input pixels."""
    # a real model has thousands of candidates and 32 mask coefficients: empty candidates and a second, unused
    # coefficient keep both above the size where squeezing would mistake one output for the other
    filler = [(0.0, 0.0, 1.0, 1.0, 0.0, 0.0)] * 10
    table = np.array([(*c, 0.0) for c in (*candidates, *filler)], dtype=np.float32).T  # channels first: 7 x N
    proto = np.stack([np.ones((8, 8)), np.zeros((8, 8))]).astype(np.float32)
    # the runtimes order and batch the outputs differently: the shapes tell them apart
    return [proto[None], table[None]]


BOX = {"x": 0.25, "y": 0.25, "width": 0.5, "height": 0.5}


def test_the_candidate_that_overlaps_the_box_is_outlined() -> None:
    out = outputs((40, 40, 40, 40, 0.9, 5.0), (160, 160, 160, 160, 0.9, 5.0))
    mask = reid.decode_mask(out, BOX, (320, 320))
    assert mask is not None
    assert mask["box"] == {"x": 0.25, "y": 0.25, "width": 0.5, "height": 0.5}
    assert (mask["width"], mask["height"]) == (160, 160)
    data = np.frombuffer(mask["data"], dtype=np.uint8)
    assert data.size == 160 * 160 and data.min() > 240, "the inside of the object, sure"


def test_nothing_is_outlined_without_a_fitting_candidate() -> None:
    far = outputs((40, 40, 40, 40, 0.9, 5.0))
    assert reid.decode_mask(far, BOX, (320, 320)) is None, "no overlap with the box"
    unsure = outputs((160, 160, 160, 160, 0.1, 5.0))
    assert reid.decode_mask(unsure, BOX, (320, 320)) is None, "a candidate under the score"
    small = outputs((100, 100, 30, 30, 0.9, 5.0))
    assert reid.decode_mask(small, BOX, (320, 320)) is None, "under the overlap of 0.3"
    assert reid.decode_mask([np.ones((6, 2))], BOX, (320, 320)) is None, "no mask prototypes"


def test_pictures_and_frames_are_outlined_and_bad_ones_skipped() -> None:
    backend = Backend(outputs((160, 160, 160, 160, 0.9, 5.0)))
    segmenter = ready(reid.Segmenter(None, Logger()), backend)  # type: ignore[arg-type]
    results = asyncio.run(
        reid.segment_images(segmenter, [{"image": b"junk", "box": BOX}, {"image": jpeg(100, 100), "box": BOX}])  # type: ignore[list-item]
    )
    assert results[0] == {} and "mask" in results[1]
    frame = {"id": "f", "data": bytes(64 * 64 * 3), "width": 64, "height": 64, "format": "rgb", "box": BOX}
    assert "mask" in asyncio.run(reid.segment_objects(segmenter, [frame]))[0]  # type: ignore[list-item]
    assert backend.calls[0][0] == (320, 320, 3), "resized to the model's input"


# ------------------------------------------------------------------ loading when needed


class Plugin:
    """What the sensors use of the plugin."""

    def __init__(self) -> None:
        self.person_embedders: dict[str, Any] = {}
        self.segmenters: dict[str, Any] = {}
        self.prepared: list[str] = []

    def prepare_person_embedder(self) -> None:
        self.prepared.append("person")

    def prepare_segmenter(self, model_name: str) -> None:
        self.prepared.append(model_name)


def frames(n: int) -> list[Any]:
    return [{"id": str(i), "data": bytes(4 * 8 * 3), "width": 4, "height": 8, "format": "rgb"} for i in range(n)]


def test_a_person_sensor_loads_nothing_at_start_and_starts_the_load_on_the_first_person() -> None:
    plugin = Plugin()
    sensor = ONNXPersonEmbedderSensor(plugin, Logger())  # type: ignore[arg-type]
    specs: list[int] = []
    sensor.updateModelSpec = lambda: specs.append(1)  # type: ignore[method-assign]
    asyncio.run(sensor.on_start())
    assert plugin.prepared == [] and specs == [1], "nothing loads when a camera gets the sensor"

    results = asyncio.run(sensor.embedPersons(frames(2)))
    assert results == [{"embedding": [], "embeddingModel": "person-reid-256"}] * 2, "the first crops go without"
    assert plugin.prepared == ["person"]

    plugin.person_embedders["person-reid-256"] = ready(
        reid.PersonEmbedder(None, Logger()),  # type: ignore[arg-type]
        Backend([np.array([[1.0, 1.0]])]),
    )
    vectors = asyncio.run(sensor.embedPersons(frames(1)))
    assert vectors[0]["embedding"] == pytest.approx([2**-0.5, 2**-0.5]) and plugin.prepared == ["person"]


def test_a_segmenter_sensor_loads_nothing_at_start_nor_when_its_model_is_changed() -> None:
    plugin = Plugin()
    sensor = ONNXSegmenterSensor(plugin, Logger())  # type: ignore[arg-type]
    sensor.updateModelSpec = lambda: None  # type: ignore[method-assign]

    class Storage:
        values: dict[str, Any] = {}

    sensor._storage = Storage()  # type: ignore[attr-defined]
    type(sensor).storage = property(lambda self: self._storage)  # type: ignore[assignment,method-assign]
    asyncio.run(sensor.on_start())
    asyncio.run(sensor._on_change_model("yolo-v9-t-320-seg", "default"))
    assert plugin.prepared == []
    assert asyncio.run(sensor.segmentObjects(frames(1))) == [{}]  # type: ignore[arg-type]
    assert plugin.prepared == ["yolo-v9-t-320-seg"]
    assert sensor.modelSpec["input"]["width"] == 320


# ------------------------------------------------------------------ the plugin's background load

pytest.importorskip("onnxruntime")
from main import ONNXPlugin  # noqa: E402


class Sensor:
    def __init__(self) -> None:
        self.updates = 0

    def updateModelSpec(self) -> None:
        self.updates += 1


class Host:
    """What _prepare_in_background uses of the plugin."""

    def __init__(self) -> None:
        self._preparing: set[str] = set()
        self._failed_models: dict[str, float] = {}
        self.logger = Logger()
        self.sensor = Sensor()
        self._sensors = {"cam": {"personEmbedder": self.sensor}}


def test_one_load_at_a_time_and_a_failed_one_waits() -> None:
    host = Host()
    loads: list[str] = []

    async def scenario(fail: bool) -> None:
        async def load() -> None:
            loads.append("load")
            await asyncio.sleep(0.01)
            if fail:
                raise RuntimeError("no such model on the mirror")

        for _ in range(3):
            ONNXPlugin._prepare_in_background(host, "person-reid-256", load, "personEmbedder")  # type: ignore[arg-type]
        await asyncio.sleep(0.05)
        ONNXPlugin._prepare_in_background(host, "person-reid-256", load, "personEmbedder")  # type: ignore[arg-type]
        await asyncio.sleep(0.05)

    asyncio.run(scenario(fail=True))
    assert loads == ["load"], "one load for three frames, none again right after it failed"
    assert host._failed_models["person-reid-256"] > time.monotonic() + 500, "tried again in about ten minutes"
    assert any("не загрузилась" in line for line in host.logger.lines), "and the failure is told"
    assert host.sensor.updates == 0

    host._failed_models.clear()
    loads.clear()
    asyncio.run(scenario(fail=False))
    assert loads == ["load", "load"], "after a load the next one is the plugin's (it keeps what it loaded)"
    assert host.sensor.updates == 2, "the sensors tell the server the model runs"


def test_a_persons_request_waits_for_the_first_load() -> None:
    class Asking:
        def __init__(self) -> None:
            self.loaded = 0

        async def get_person_embedder(self) -> Any:
            self.loaded += 1
            return ready(reid.PersonEmbedder(None, Logger()), Backend([np.array([[0.0, 1.0]])]))  # type: ignore[arg-type]

    asking = Asking()
    answer = asyncio.run(ONNXPlugin.embedPersonImages(asking, [jpeg(40, 100)]))  # type: ignore[arg-type]
    assert asking.loaded == 1 and answer[0] is not None and answer[0]["embedding"] == pytest.approx([0.0, 1.0])


# ------------------------------------------------------------------ a search by picture


class Detector:
    """Answers fixed detections (class id, score, box 0..1) and remembers what it was given."""

    labels = {0: "person", 2: "vehicle"}

    def __init__(self, found: list[tuple[int, float, dict[str, float]]]) -> None:
        self.found = found
        self.initialized = True
        self.calls = 0

    async def detect_single(self, data: bytes, metadata: Any) -> list[tuple[int, float, dict[str, float]]]:
        self.calls += 1
        return self.found


SMALL_PERSON = (0, 0.9, {"x": 0.0, "y": 0.0, "width": 0.1, "height": 0.2})
BIG_PERSON = (0, 0.6, {"x": 0.5, "y": 0.25, "width": 0.25, "height": 0.5})
BIG_CAR = (2, 0.99, {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0})


def test_the_biggest_person_of_a_picture_is_cut_tight() -> None:
    assert reid.largest_person([SMALL_PERSON, BIG_CAR, BIG_PERSON], Detector.labels) == BIG_PERSON[2], "not the car, not the surer"
    assert reid.largest_person([BIG_CAR], Detector.labels) is None
    assert reid.largest_person([(0, 0.9, {"x": 0.1, "y": 0.1, "width": 0.0, "height": 0.5})], Detector.labels) is None
    rgb = np.zeros((100, 200, 3), dtype=np.uint8)
    assert reid.crop_box(rgb, BIG_PERSON[2]).shape == (50, 50, 3), "x 100..150, y 25..75 of 200x100"
    assert reid.crop_box(rgb, {"x": 0.9, "y": -0.2, "width": 0.5, "height": 0.5}).shape == (30, 20, 3), "clamped to the picture"


def test_a_picture_is_embedded_by_its_person_or_says_nobody() -> None:
    backend = Backend([np.array([[1.0, 0.0]])])
    embedder = ready(reid.PersonEmbedder(None, Logger()), backend)  # type: ignore[arg-type]
    detector = Detector([BIG_CAR, BIG_PERSON])
    found = asyncio.run(reid.embed_people_in_pictures(embedder, detector, [jpeg(200, 100)], "reid-test"))
    assert found[0]["embedding"] == pytest.approx([1.0, 0.0]) and backend.calls[0][0] == (256, 128, 3)
    nobody = asyncio.run(reid.embed_people_in_pictures(embedder, Detector([BIG_CAR]), [jpeg(200, 100)], "reid-test"))
    assert nobody == [{"embedding": [], "embeddingModel": "reid-test"}] and len(backend.calls) == 1, "no person, no vector"
    junk = asyncio.run(reid.embed_people_in_pictures(embedder, detector, [b"junk"], "reid-test"))
    assert junk == [{"embedding": [], "embeddingModel": "reid-test"}] and detector.calls == 1, "unreadable: not even detected"


def test_the_nvrs_picture_goes_through_the_detector_a_crop_does_not() -> None:
    class Asking:
        def __init__(self) -> None:
            self.detector = Detector([BIG_PERSON])
            self.backend = Backend([np.array([[0.0, 1.0]])])

        async def get_person_embedder(self) -> Any:
            return ready(reid.PersonEmbedder(None, Logger()), self.backend)  # type: ignore[arg-type]

        async def get_object_detector(self, model_name: str) -> Any:
            return self.detector

    asking = Asking()
    asyncio.run(ONNXPlugin.embedPersonImages(asking, [jpeg(200, 100)], {"find": "person"}))  # type: ignore[arg-type]
    assert asking.detector.calls == 1 and asking.backend.calls[0][0] == (256, 128, 3)
    asyncio.run(ONNXPlugin.embedPersonImages(asking, [jpeg(40, 100)]))  # type: ignore[arg-type]
    assert asking.detector.calls == 1, "a picture of one person (the plugin page) is embedded whole"
