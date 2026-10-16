"""The outline of a thing marked on a picture (src/sam.py, kept identical in the ONNX and OpenVINO plugins, and their
outlineMarked): a box and points in shares of the picture as SAM 2.1 takes them, the low resolution mask as an outline
over the picture (the segmenter's form), the model loaded in the background when first asked and out of memory when
nobody asks, a load that failed said to the next call, a picture that cannot be read outlined as nothing. The real
methods run on a fake model; with SAM_MODELS (a folder with SAM 2.1 tiny's vision_encoder.onnx and
prompt_encoder_mask_decoder.onnx and their data, as the mirror has them) and ONNX Runtime or OpenVINO, the real model.

    python -m pytest camera-ui-onnx/tests/test_sam.py
"""

from __future__ import annotations

import ast
import asyncio
import io
import os
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "camera-ui-onnx" / "src"))

import sam  # noqa: E402


def test_the_same_file_in_both_plugins():
    onnx = (ROOT / "camera-ui-onnx" / "src" / "sam.py").read_bytes()
    assert onnx == (ROOT / "camera-ui-openvino" / "src" / "sam.py").read_bytes()


def test_the_model_has_its_path_on_the_mirror():
    assert sam.model_file("sam2.1-hiera-tiny") == "sam2.1-hiera-tiny/vision_encoder.onnx"
    assert sam.model_file("yolo-v9-t-320-seg") is None


# ------------------------------------------------------------------ what the model is given


def test_a_box_in_shares_is_corner_to_corner_in_the_encoders_square_with_a_point_that_is_none():
    coords, labels, boxes = sam.prompt_inputs({"box": {"x": 0.25, "y": 0.5, "width": 0.5, "height": 0.25}})
    assert boxes.shape == (1, 1, 4) and boxes.dtype == np.float32
    assert boxes[0, 0].tolist() == [256.0, 512.0, 768.0, 768.0]
    assert coords.shape == (1, 1, 1, 2) and labels.tolist() == [[[sam.NO_POINT]]]


def test_points_keep_their_labels_and_no_box_is_no_box():
    coords, labels, boxes = sam.prompt_inputs(
        {"points": [{"x": 0.5, "y": 0.5}, {"x": 0.1, "y": 0.9, "label": 0}]}
    )
    assert coords[0, 0].tolist() == [[512.0, 512.0], [pytest.approx(102.4), pytest.approx(921.6)]]
    assert labels.tolist() == [[[1, 0]]] and labels.dtype == np.int64
    assert boxes.shape == (1, 0, 4)


def test_the_picture_is_stretched_to_the_square_and_normalized():
    x = sam.pixels(Image.new("RGB", (640, 360), (255, 255, 255)))
    assert x.shape == (1, 3, 1024, 1024) and x.dtype == np.float32
    assert np.allclose(x[0, :, 0, 0], (1 - sam.MEAN[:, 0, 0]) / sam.STD[:, 0, 0])


# ------------------------------------------------------------------ what comes back


def test_the_mask_is_an_outline_over_the_picture_with_its_box_and_share():
    logits = np.full((256, 256), -8.0, dtype=np.float32)
    logits[64:128, 128:192] = 8.0  # a quarter across, a quarter down: on a 400 x 200 picture 100 x 50 px
    found = sam.outline(logits, (400, 200))
    assert found is not None
    box = found["box"]
    assert (round(box["x"], 2), round(box["y"], 2), round(box["width"], 2), round(box["height"], 2)) == (
        0.5,
        0.25,
        0.25,
        0.25,
    )
    assert (found["width"], found["height"]) == (100, 50)
    data = np.frombuffer(found["data"], np.uint8).reshape(found["height"], found["width"])
    assert (data > 127).mean() > 0.95
    assert abs(found["area"] - 100 * 50 / (400 * 200)) < 0.005


def test_an_empty_mask_is_no_outline():
    assert sam.outline(np.full((256, 256), -5.0, dtype=np.float32), (320, 240)) is None


class Runner:
    """The encoder or the decoder: what `answer` gives, with what it was given."""

    def __init__(self, answer: Any) -> None:
        self.answer = answer
        self.calls: list[dict[str, np.ndarray]] = []

    def __call__(self, feeds: dict[str, np.ndarray]) -> list[np.ndarray]:
        self.calls.append(feeds)
        return self.answer(feeds)


def decoder_of(score: float, present: float, block: tuple[int, int, int, int] | None) -> Runner:
    def answer(_feeds: dict[str, np.ndarray]) -> list[np.ndarray]:
        masks = np.full((1, 1, 3, 256, 256), -8.0, dtype=np.float32)
        if block is not None:
            y1, y2, x1, x2 = block
            masks[0, 0, 2, y1:y2, x1:x2] = 8.0
        # the third of the three outlines is the decoder's best
        return [
            np.array([[[score / 2, score / 3, score]]], np.float32),
            masks,
            np.array([[[present]]], np.float32),
        ]

    return Runner(answer)


def encoder() -> Runner:
    return Runner(
        lambda _f: [
            np.zeros((1, 32, 256, 256), np.float32),
            np.zeros((1, 64, 128, 128), np.float32),
            np.zeros((1, 256, 64, 64), np.float32),
        ]
    )


def loaded(enc: Runner, dec: Runner) -> sam.Sam:
    model = sam.Sam.__new__(sam.Sam)
    sam.Sam.__init__(model, None, None, base_url="")  # type: ignore[arg-type]
    model.encoder, model.decoder, model.initialized = enc, dec, True
    return model


def test_one_encoding_a_picture_and_one_decoding_a_prompt():
    enc, dec = encoder(), decoder_of(0.95, 2.0, (100, 140, 100, 160))
    model = loaded(enc, dec)
    box = {"x": 0.4, "y": 0.4, "width": 0.2, "height": 0.2}
    answers = asyncio.run(
        model.segment(Image.new("RGB", (320, 240)), [{"box": box}, {"points": [{"x": 0.5, "y": 0.5}]}])
    )
    assert len(enc.calls) == 1 and len(dec.calls) == 2
    assert dec.calls[0]["input_boxes"].shape == (1, 1, 4) and dec.calls[1]["input_boxes"].shape == (1, 0, 4)
    assert [a["score"] for a in answers] == pytest.approx([0.95, 0.95])
    assert all(a["present"] for a in answers) and all("mask" in a for a in answers)
    assert not model.busy and not model.idle(time.monotonic()), "just asked: not idle"


def test_one_picture_at_a_time_and_a_share_of_the_cpu():
    # a call the recorder gave up on still runs when it asks again: the two encodings wait for each other
    active = 0
    most = 0

    def slow(_feeds: dict[str, np.ndarray]) -> list[np.ndarray]:
        nonlocal active, most
        active += 1
        most = max(most, active)
        time.sleep(0.05)
        active -= 1
        return encoder().answer(_feeds)

    model = loaded(Runner(slow), decoder_of(0.95, 2.0, (100, 140, 100, 160)))
    box = {"box": {"x": 0.4, "y": 0.4, "width": 0.2, "height": 0.2}}

    async def both() -> None:
        await asyncio.gather(*(model.segment(Image.new("RGB", (64, 64)), [box]) for _ in range(3)))

    asyncio.run(both())
    assert most == 1
    assert 2 <= sam.THREADS <= max(2, (os.cpu_count() or 8) // 4)


def test_a_weak_outline_is_none_and_gone_is_said():
    model = loaded(encoder(), decoder_of(0.1, -3.0, (100, 140, 100, 160)))
    whole = {"box": {"x": 0, "y": 0, "width": 1, "height": 1}}
    answers = asyncio.run(model.segment(Image.new("RGB", (64, 64)), [whole]))
    assert answers == [{"score": pytest.approx(0.1), "present": False}]


# ------------------------------------------------------------------ the plugins' outlineMarked


class FakeSam:
    fail: str | None = None
    made = 0

    def __init__(self, manager: Any, logger: Any, *, base_url: str) -> None:
        FakeSam.made += 1
        self.base_url = base_url
        self.initialized = False
        self.closed = False
        self.asked: list[int] = []
        self.last_used = time.monotonic()

    async def initialize(self) -> None:
        await asyncio.sleep(0.01)
        if FakeSam.fail is not None:
            raise RuntimeError(FakeSam.fail)
        self.initialized = True

    async def segment(self, image: Image.Image, prompts: list[dict[str, Any]]) -> list[dict[str, Any]]:
        self.asked.append(len(prompts))
        self.last_used = time.monotonic()
        return [{"score": 0.9, "present": True} for _ in prompts]

    def idle(self, now: float) -> bool:
        return now - self.last_used >= 0.05

    def close(self) -> None:
        self.closed = True


class Logger:
    def __init__(self) -> None:
        self.said: list[str] = []

    def log(self, text: str) -> None:
        self.said.append(text)

    warn = log
    success = log


PLUGINS = {"onnx": ("camera-ui-onnx", "ONNXPlugin"), "openvino": ("camera-ui-openvino", "OpenVinoPlugin")}


def plugin(which: str) -> Any:
    folder, name = PLUGINS[which]
    path = ROOT / folder / "src" / "main.py"
    tree = ast.parse(path.read_text(encoding="utf-8"))
    cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == name)
    cls.bases = []
    keep = {"outlineMarked", "_load_outliner", "_close_outliner_when_idle"}
    cls.body = [
        node
        for node in cls.body
        if isinstance(node, ast.AsyncFunctionDef | ast.FunctionDef) and node.name in keep
    ]
    module = ast.Module(
        body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), cls],
        type_ignores=[],
    )
    namespace: dict[str, Any] = {
        "asyncio": asyncio,
        "time": time,
        "Any": Any,
        "Image": Image,
        "decode_image": lambda data: np.asarray(Image.open(io.BytesIO(data)).convert("RGB")),
        "OUTLINER_IDLE_S": 0.05,
        "MODEL_BASE_URL": "https://mirror/v1/" + which,
        "TEXTFIND_BASE_URL": "https://mirror/v1/onnx",
        "SAM_MODEL": sam.SAM_MODEL,
        "Sam": FakeSam,
    }
    exec(compile(ast.fix_missing_locations(module), str(path), "exec"), namespace)
    cls_ = namespace[name]
    cls_.__init__ = lambda self: None  # type: ignore[method-assign]
    p = cls_()
    p.model_manager = None
    p.logger = Logger()
    p.outliner = None
    p._outliner_idle = None
    p._outliner_load = None
    p._outliner_error = None
    p.failed = []
    p.succeeded = []
    p._load_failed = lambda model, error: p.failed.append((model, str(error)))
    p._load_succeeded = lambda model: p.succeeded.append(model)
    return p


def picture() -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (32, 32)).save(out, format="JPEG")
    return out.getvalue()


@pytest.fixture(autouse=True)
def fresh() -> None:
    FakeSam.fail = None
    FakeSam.made = 0


BOX = {"box": {"x": 0.1, "y": 0.1, "width": 0.2, "height": 0.2}}


@pytest.mark.parametrize("which", PLUGINS)
def test_the_first_question_loads_in_the_background_then_the_outlines_come_then_idle_out(which: str):
    async def run() -> None:
        p = plugin(which)
        assert await p.outlineMarked([{"image": picture(), "prompts": [BOX]}]) == {
            "loading": True,
            "pictures": [],
        }
        assert (await p.outlineMarked([{"image": picture(), "prompts": [BOX]}]))["loading"] is True, (
            "one load"
        )
        await asyncio.sleep(0.03)
        assert FakeSam.made == 1 and p.succeeded == [sam.SAM_MODEL]
        # the ONNX model of both plugins from where the ONNX models are
        assert p.outliner.base_url == "https://mirror/v1/onnx"
        answer = await p.outlineMarked(
            [{"image": picture(), "prompts": [BOX, BOX]}, {"image": picture(), "prompts": []}]
        )
        assert answer == {"pictures": [{"answers": [{"score": 0.9, "present": True}] * 2}, {"answers": []}]}
        outliner = p.outliner
        assert outliner.asked == [2], "a picture without prompts is not even encoded"
        await asyncio.sleep(0.12)
        assert outliner.closed and p.outliner is None
        assert any("left memory" in said for said in p.logger.said)

    asyncio.run(run())


@pytest.mark.parametrize("which", PLUGINS)
def test_a_picture_that_cannot_be_read_has_no_outlines_the_others_do(which: str):
    async def run() -> None:
        p = plugin(which)
        await p.outlineMarked([{"image": picture(), "prompts": [BOX]}])
        await asyncio.sleep(0.03)
        answer = await p.outlineMarked(
            [{"image": b"not a picture", "prompts": [BOX, BOX]}, {"image": picture(), "prompts": [BOX]}]
        )
        assert answer["pictures"][0] == {"answers": [{"score": 0.0, "present": False}] * 2}
        assert answer["pictures"][1] == {"answers": [{"score": 0.9, "present": True}]}

    asyncio.run(run())


@pytest.mark.parametrize("which", PLUGINS)
def test_nothing_asked_loads_nothing_and_a_failed_load_is_said_once(which: str):
    async def run() -> None:
        p = plugin(which)
        assert await p.outlineMarked([]) == {"pictures": []}
        assert FakeSam.made == 0
        FakeSam.fail = "no mirror"
        assert (await p.outlineMarked([{"image": picture(), "prompts": [BOX]}]))["loading"] is True
        await asyncio.sleep(0.03)
        assert p.failed == [(sam.SAM_MODEL, "no mirror")] and p.outliner is None
        with pytest.raises(RuntimeError, match="no mirror"):
            await p.outlineMarked([{"image": picture(), "prompts": [BOX]}])
        FakeSam.fail = None
        assert (await p.outlineMarked([{"image": picture(), "prompts": [BOX]}]))["loading"] is True
        await asyncio.sleep(0.03)
        assert (await p.outlineMarked([{"image": picture(), "prompts": [BOX]}]))["pictures"][0]["answers"][0][
            "present"
        ]

    asyncio.run(run())


# ------------------------------------------------------------------ the real model


def _runtime() -> str | None:
    for name in ("onnxruntime", "openvino"):
        try:
            __import__(name)
            return name
        except ImportError:
            continue
    return None


@pytest.mark.skipif(
    not os.environ.get("SAM_MODELS") or _runtime() is None, reason="SAM_MODELS and a runtime needed"
)
def test_the_real_model_outlines_a_small_thing_and_a_point_on_nothing_is_nothing():
    folder = os.environ["SAM_MODELS"]
    model = loaded(
        Runner(sam.runner(f"{folder}/vision_encoder.onnx")),
        Runner(sam.runner(f"{folder}/prompt_encoder_mask_decoder.onnx")),
    )
    rng = np.random.default_rng(7)
    noise = rng.integers(60, 200, (90, 160, 3)).astype(np.uint8)
    background = Image.fromarray(noise).resize((1280, 720), Image.Resampling.BICUBIC)
    scene = background.copy()
    ImageDraw.Draw(scene).rounded_rectangle((600, 380, 680, 440), radius=12, fill=(200, 30, 30))
    box = {"box": {"x": 590 / 1280, "y": 370 / 720, "width": 100 / 1280, "height": 80 / 720}}
    point = {"points": [{"x": 640 / 1280, "y": 410 / 720}]}
    thing = asyncio.run(model.segment(scene, [box, point]))
    for answer in thing:
        b = answer["mask"]["box"]
        assert answer["score"] > 0.9
        assert abs(b["x"] * 1280 - 600) < 6 and abs(b["y"] * 720 - 380) < 6
        assert abs(b["width"] * 1280 - 81) < 8 and abs(b["height"] * 720 - 61) < 8
    nothing = asyncio.run(model.segment(background, [point]))
    assert "mask" not in nothing[0], "a point where nothing lies is no outline"
