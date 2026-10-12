"""Where the words of a search are in the pictures (src/textfind.py, ONNXPlugin.findInPictures): the query put into
English when it is Russian, OWL-ViT's boxes read as shares of the picture (the best, overlapping ones once, from a
floor), the crop of a find, and the models out of memory when nobody asks. The real methods run on fake models; with
TEXTFIND_MODELS (a folder with owlvit-base-patch32/ and opus-mt-ru-en/ as the mirror has them) the real models too.

    python -m pytest camera-ui-onnx/tests/test_textfind.py
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

import textfind  # noqa: E402


def logit(p: float) -> float:
    return float(np.log(p / (1 - p)))


# ------------------------------------------------------------------ the query


def test_a_russian_query_is_translated_an_english_one_is_not():
    assert textfind.needs_translation("красная сумка")
    assert textfind.needs_translation("Ёлка")
    assert not textfind.needs_translation("red bag")
    assert not textfind.needs_translation("123")
    assert textfind.tidy(" Cat. ") == "cat"
    assert textfind.tidy("Box by the door!") == "box by the door"


class Backend:
    """A model that answers what `answer` gives for the inputs, by the names of its inputs in their order."""

    def __init__(self, names: list[str], answer: Any) -> None:
        self._input_names = names
        self.answer = answer
        self.calls: list[dict[str, Any]] = []
        self.closed = False

    async def infer(self, inputs: list[Any]) -> list[Any]:
        named = dict(zip(self._input_names, inputs, strict=True))
        self.calls.append(named)
        return self.answer(named)

    def close(self) -> None:
        self.closed = True


class Tokenizer:
    """Words of the translator: ids 10 + position, decoded through `words`."""

    words = {5: "red", 6: "bag", 7: "."}

    def __call__(self, text: str, return_tensors: str = "np") -> dict[str, Any]:
        n = len(text.split())
        return {"input_ids": np.array([[10 + i for i in range(n)] + [0]]), "attention_mask": np.ones((1, n + 1), dtype=np.int64)}

    def decode(self, ids: list[int], skip_special_tokens: bool = True) -> str:
        return " ".join(self.words.get(i, "?") for i in ids).replace(" .", ".")


CONFIG = {"decoder_start_token_id": 99, "pad_token_id": 99, "eos_token_id": 0}


def translator(script: list[int], vocabulary: int = 100) -> textfind.TextFinder:
    """A finder whose decoder says `script` token by token, the pad token always loudest (it must never be said)."""
    finder = textfind.TextFinder(None, None, base_url="")  # type: ignore[arg-type]

    def decode(named: dict[str, Any]) -> list[Any]:
        step = named["input_ids"].shape[1] - 1
        logits = np.zeros((1, step + 1, vocabulary), dtype=np.float32)
        logits[0, -1, CONFIG["pad_token_id"]] = 100
        logits[0, -1, script[step] if step < len(script) else 0] = 50
        return [logits]

    finder.encoder = Backend(["input_ids", "attention_mask"], lambda named: [np.ones((1, named["input_ids"].shape[1], 4))])
    # the decoder's inputs are not in the order of the call: they are fed by name
    finder.decoder = Backend(["encoder_attention_mask", "input_ids", "encoder_hidden_states"], decode)
    finder.translator_tokenizer = Tokenizer()
    finder.translator_config = CONFIG
    return finder


def test_the_translation_is_greedy_and_ends_at_the_end_token():
    finder = translator([5, 6, 7, 0])
    assert asyncio.run(finder.english("красная сумка")) == "red bag"
    # each step the whole output so far, starting with the start token
    assert [call["input_ids"].tolist() for call in finder.decoder.calls] == [[[99]], [[99, 5]], [[99, 5, 6]], [[99, 5, 6, 7]]]
    assert finder.decoder.calls[0]["encoder_hidden_states"].shape == (1, 3, 4)


def test_a_translation_that_never_ends_is_cut():
    finder = translator([5] * 100)
    asyncio.run(finder.english("сумка"))
    assert len(finder.decoder.calls) == textfind.MAX_TOKENS


def test_english_and_known_words_need_no_translator():
    finder = translator([5, 0])
    assert asyncio.run(finder.english("  red bag ")) == "red bag"
    assert asyncio.run(finder.english("Человек")) == "person"
    assert finder.decoder.calls == []


# ------------------------------------------------------------------ the boxes


def test_boxes_are_the_best_ones_from_the_floor_overlapping_ones_once():
    logits = np.array([logit(0.02), logit(0.6), logit(0.55), logit(0.3), logit(0.2), logit(0.12), logit(0.049)])
    boxes = np.array(
        [
            [0.5, 0.5, 0.2, 0.2],
            [0.25, 0.5, 0.2, 0.4],  # the best
            [0.26, 0.5, 0.2, 0.4],  # the same thing again
            [0.8, 0.2, 0.1, 0.1],
            [0.5, 0.9, 0.1, 0.1],
            [0.1, 0.1, 0.1, 0.1],  # a fourth: no more than three
            [0.9, 0.9, 0.1, 0.1],
        ]
    )
    found = textfind.boxes_of(logits, boxes)
    assert [b["score"] for b in found] == [0.6, 0.3, 0.2]
    assert found[0] == pytest.approx({"x": 0.15, "y": 0.3, "width": 0.2, "height": 0.4, "score": 0.6})
    # nothing from the floor: nothing said
    assert textfind.boxes_of(np.array([logit(0.049)]), np.array([[0.5, 0.5, 0.1, 0.1]])) == []


def test_a_box_over_the_edge_is_cut_to_the_picture():
    found = textfind.boxes_of(np.array([logit(0.5)]), np.array([[0.05, 0.95, 0.2, 0.2]]))
    assert found[0] == pytest.approx({"x": 0.0, "y": 0.85, "width": 0.15, "height": 0.15, "score": 0.5})


def test_the_crop_is_the_box_with_some_around_it():
    image = Image.new("RGB", (1000, 500), (0, 0, 0))
    ImageDraw.Draw(image).rectangle((200, 100, 399, 299), fill=(255, 0, 0))
    crop = Image.open(io.BytesIO(textfind.crop_of(image, {"x": 0.2, "y": 0.2, "width": 0.2, "height": 0.4})))
    # 200x200 and 15 % around: 260x260
    assert crop.size == (260, 260)
    assert crop.getpixel((130, 130))[0] > 200 and crop.getpixel((5, 5))[0] < 50
    # a big find is made smaller
    assert max(Image.open(io.BytesIO(textfind.crop_of(image, {"x": 0, "y": 0, "width": 1, "height": 1}))).size) == textfind.CROP_SIDE


def owl_finder(scores: list[float]) -> textfind.TextFinder:
    """A finder whose OWL sees one thing a picture, scored in turn, at the left of the picture."""
    finder = translator([5, 6, 0])
    queue = list(scores)

    def answer(named: dict[str, Any]) -> list[Any]:
        assert named["pixel_values"].shape == (1, 3, textfind.OWL_SIZE, textfind.OWL_SIZE)
        logits = np.full((1, 4, 1), logit(0.001))
        logits[0, 2, 0] = logit(queue.pop(0))
        boxes = np.tile(np.array([0.25, 0.5, 0.3, 0.6]), (1, 4, 1))
        return [logits, boxes, None, None]

    finder.owl = Backend(["input_ids", "pixel_values", "attention_mask"], answer)

    def tokens(texts: list[str], **_: Any) -> dict[str, Any]:
        finder.asked = texts  # type: ignore[attr-defined]
        return {"input_ids": np.zeros((1, textfind.OWL_TOKENS), dtype=np.int64), "attention_mask": np.ones((1, textfind.OWL_TOKENS), dtype=np.int64)}

    finder.owl_tokenizer = tokens
    return finder


def test_a_find_has_its_crop_a_weak_one_only_its_boxes():
    finder = owl_finder([0.4, 0.07])
    pictures = [Image.new("RGB", (640, 360), (90, 90, 90)) for _ in range(2)]
    result = asyncio.run(finder.find("красная сумка", pictures))
    assert result["query"] == "red bag" and finder.asked == ["a photo of red bag"]
    assert result["foundScore"] == textfind.FOUND_SCORE
    first, second = result["pictures"]
    assert first["boxes"][0]["score"] == 0.4 and Image.open(io.BytesIO(first["crop"])).size[0] > 0
    assert second["boxes"][0]["score"] == 0.07 and "crop" not in second
    assert finder.busy == 0


def test_the_models_are_not_idle_while_a_find_is_under_way():
    finder = owl_finder([0.4])
    now = time.monotonic()
    finder.last_used = now - textfind.IDLE_S - 1
    assert finder.idle(now)
    finder.busy = 1
    assert not finder.idle(now)
    finder.busy = 0
    finder.last_used = now - textfind.IDLE_S + 5
    assert not finder.idle(now)


def test_closed_models_leave_the_manager_too():
    forgotten: list[str] = []
    finder = owl_finder([0.4])
    finder.manager = type("Manager", (), {"forget": lambda _self, name: forgotten.append(name)})()  # type: ignore[assignment]
    backends = (finder.owl, finder.encoder, finder.decoder)
    finder.initialized = True
    finder.close()
    assert all(b.closed for b in backends)  # type: ignore[union-attr]
    assert forgotten == [textfind.OWL_MODEL, textfind.TRANSLATOR_ENCODER, textfind.TRANSLATOR_DECODER]
    assert finder.owl is None and not finder.initialized


# ------------------------------------------------------------------ the plugin's method


def _plugin_class() -> type:
    path = ROOT / "camera-ui-onnx" / "src" / "main.py"
    tree = ast.parse(path.read_text(encoding="utf-8"))
    cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "ONNXPlugin")
    cls.bases = []
    keep = {"findInPictures", "_close_text_finder_when_idle", "get_text_finder", "_load_text_finder"}
    cls.body = [node for node in cls.body if isinstance(node, ast.AsyncFunctionDef | ast.FunctionDef) and node.name in keep]
    module = ast.Module(body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), cls], type_ignores=[])
    namespace: dict[str, Any] = {
        "asyncio": asyncio,
        "time": time,
        "Any": Any,
        "Image": Image,
        "decode_image": lambda data: np.asarray(Image.open(io.BytesIO(data)).convert("RGB")),
        "TEXT_FINDER_IDLE_S": 0.05,
        "MODEL_BASE_URL": "https://mirror/v1/onnx",
        "OWL_MODEL": textfind.OWL_MODEL,
        "TextFinder": Finder,
    }
    exec(compile(ast.fix_missing_locations(module), str(path), "exec"), namespace)
    return namespace["ONNXPlugin"]


class Finder:
    """TextFinder that fails to load while `fail` says so."""

    fail: str | None = None
    made = 0

    def __init__(self, *_args: Any, **_kwargs: Any) -> None:
        Finder.made += 1
        self.initialized = False
        self.closed = False
        self.asked: list[tuple[str, int]] = []
        self.last_used = time.monotonic()

    async def initialize(self) -> None:
        await asyncio.sleep(0.01)
        if Finder.fail:
            raise RuntimeError(Finder.fail)
        self.initialized = True

    async def find(self, text: str, images: list[Any]) -> dict[str, Any]:
        self.asked.append((text, len(images)))
        self.last_used = time.monotonic()
        return {"query": text, "pictures": [{"boxes": []} for _ in images]}

    def idle(self, now: float) -> bool:
        return now - self.last_used >= 0.05

    def close(self) -> None:
        self.closed = True


def plugin() -> Any:
    cls = _plugin_class()
    cls.__init__ = lambda self: None  # type: ignore[method-assign]
    p = cls()
    p.model_manager = None
    p.logger = type("Logger", (), {"log": lambda *_: None})()
    p.text_finder = None
    p._text_finder_idle = None
    p._text_finder_load = None
    p._text_finder_error = None
    p.failed = []
    p.succeeded = []
    p._load_failed = lambda name, error: p.failed.append((name, str(error)))
    p._load_succeeded = lambda name: p.succeeded.append(name)
    return p


@pytest.fixture(autouse=True)
def fake_finder() -> None:
    Finder.fail = None
    Finder.made = 0


def picture() -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (32, 32)).save(out, format="JPEG")
    return out.getvalue()


def test_the_first_call_loads_in_the_background_and_says_so_then_the_finds_come():
    async def run() -> None:
        p = plugin()
        # a call ends after 30 s, the models take longer: the first answer is that they load
        assert await p.findInPictures("сумка", [picture(), picture()]) == {"query": "сумка", "loading": True, "pictures": []}
        # asked again while they load: still loading, one load
        assert (await p.findInPictures("сумка", [picture()]))["loading"] is True
        await asyncio.sleep(0.03)
        assert Finder.made == 1 and p.succeeded == [textfind.OWL_MODEL]
        result = await p.findInPictures("сумка", [picture(), picture()])
        assert result["pictures"] == [{"boxes": []}, {"boxes": []}]
        finder = p.text_finder
        assert finder.asked == [("сумка", 2)]
        # asked again before it is idle: the same finder, still in memory; then idle, out of it
        await p.findInPictures("сумка", [picture()])
        assert Finder.made == 1 and not finder.closed
        await asyncio.sleep(0.12)
        assert finder.closed and p.text_finder is None

    asyncio.run(run())


def test_loaded_and_never_asked_it_leaves_memory_too():
    async def run() -> None:
        p = plugin()
        await p.findInPictures("сумка", [picture()])
        await asyncio.sleep(0.03)
        finder = p.text_finder
        assert finder.initialized and not finder.closed
        await asyncio.sleep(0.12)
        assert finder.closed and p.text_finder is None

    asyncio.run(run())


def test_nothing_asked_loads_nothing_and_a_failed_load_is_said_once():
    async def run() -> None:
        p = plugin()
        assert await p.findInPictures("  ", [picture()]) == {"query": "", "pictures": [{"boxes": []}]}
        assert await p.findInPictures("сумка", []) == {"query": "сумка", "pictures": []}
        assert Finder.made == 0
        Finder.fail = "no mirror"
        assert (await p.findInPictures("сумка", [picture()]))["loading"] is True
        await asyncio.sleep(0.03)
        assert p.failed == [(textfind.OWL_MODEL, "no mirror")] and p.text_finder is None
        with pytest.raises(RuntimeError, match="no mirror"):
            await p.findInPictures("сумка", [picture()])
        # said once: the next call loads again, and can
        Finder.fail = None
        assert (await p.findInPictures("сумка", [picture()]))["loading"] is True
        await asyncio.sleep(0.03)
        assert (await p.findInPictures("сумка", [picture()]))["pictures"] == [{"boxes": []}]

    asyncio.run(run())


# ------------------------------------------------------------------ the real models


MODELS = os.environ.get("TEXTFIND_MODELS")


@pytest.mark.skipif(not MODELS, reason="TEXTFIND_MODELS not given")
def test_the_real_models_find_a_red_square():
    import onnxruntime as ort
    from transformers import AutoTokenizer

    class Real:
        def __init__(self, path: str) -> None:
            self.session = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
            self._input_names = [i.name for i in self.session.get_inputs()]

        async def infer(self, inputs: list[Any]) -> list[Any]:
            return self.session.run(None, dict(zip(self._input_names, inputs, strict=True)))

        def close(self) -> None:
            pass

    import json

    owl = Path(MODELS) / textfind.OWL_MODEL  # type: ignore[arg-type]
    opus = Path(MODELS) / textfind.TRANSLATOR  # type: ignore[arg-type]
    finder = textfind.TextFinder(None, None, base_url="")  # type: ignore[arg-type]
    finder.owl = Real(str(owl / f"{textfind.OWL_MODEL}.onnx"))
    finder.encoder = Real(str(opus / "encoder.onnx"))
    finder.decoder = Real(str(opus / "decoder.onnx"))
    finder.owl_tokenizer = AutoTokenizer.from_pretrained(str(owl))
    finder.translator_tokenizer = AutoTokenizer.from_pretrained(str(opus))
    finder.translator_config = json.loads((opus / "config.json").read_text(encoding="utf-8"))
    assert asyncio.run(finder.english("красный квадрат")) in {"red square", "the red square"}
    image = Image.new("RGB", (640, 480), (230, 230, 230))
    ImageDraw.Draw(image).rectangle((400, 80, 559, 239), fill=(220, 20, 20))
    result = asyncio.run(finder.find("красный квадрат", [image]))
    best = result["pictures"][0]["boxes"][0]
    assert best["score"] >= textfind.FOUND_SCORE
    assert best["x"] == pytest.approx(400 / 640, abs=0.05) and best["y"] == pytest.approx(80 / 480, abs=0.05)
