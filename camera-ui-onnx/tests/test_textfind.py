"""The platform's language for English-only models, and the words of a search found in pictures (src/textfind.py, kept
identical in the ONNX and OpenVINO plugins; ONNXPlugin's CLIP queries and findInPictures): a query is put into English
from Russian whenever it has Cyrillic, else from the platform's language; the CLIP of English only gets it in English,
waiting a little for a translator that loads; OWL-ViT's boxes read as shares of the picture (the best, overlapping ones
once, from a floor), the crop of a find, the finder loaded in the background and out of memory when nobody asks. The
real methods run on fake models; with TEXTFIND_MODELS (a folder with owlvit-base-patch32/ and opus-mt-ru-en/ as the
mirror has them) the real models too.

    python -m pytest camera-ui-onnx/tests/test_textfind.py
"""

from __future__ import annotations

import ast
import asyncio
import io
import json
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


class Logger:
    def __init__(self) -> None:
        self.said: list[str] = []

    def log(self, text: str) -> None:
        self.said.append(text)

    success = log


# ------------------------------------------------------------------ the language of a query


def test_russian_whenever_cyrillic_else_the_platforms_language():
    assert textfind.language_of("красная сумка", None) == "ru"
    assert textfind.language_of("Ёлка", "en") == "ru", "Russian whatever the platform speaks"
    assert textfind.language_of("rote Tasche", "de") == "de"
    assert textfind.language_of("rote Tasche", "de-DE") == "de"
    assert textfind.language_of("red bag", "en") is None
    assert textfind.language_of("red bag", None) is None
    assert textfind.language_of("sac rouge", "fr") is None, "no translator for it: as it is"
    assert textfind.tidy(" Cat. ") == "cat"
    assert textfind.tidy("Box by the door!") == "box by the door"


def test_the_models_have_their_paths_on_the_mirror():
    assert textfind.model_file("owlvit-base-patch32") == "owlvit-base-patch32/owlvit-base-patch32.onnx"
    assert textfind.model_file("opus-mt-ru-en-encoder") == "opus-mt-ru-en/encoder.onnx"
    assert textfind.model_file("opus-mt-de-en-decoder") == "opus-mt-de-en/decoder.onnx"
    assert textfind.model_file("opus-mt-fr-en-encoder") is None
    assert textfind.model_file("yolo-v9-s-320") is None


class Backend:
    """A model that answers what `answer` gives for the inputs, by the names of its inputs in their order (ONNX's)."""

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


class Port:
    """An input of OpenVINO's compiled model: the ONNX input's name among the names of the tensors behind it, any one of
    which get_any_name may give (OWL-ViT's pixel_values came as /owlvit/vision_model/Cast_output_0)."""

    def __init__(self, name: str, *inner: str) -> None:
        self.names = {name, *inner}
        self.inner = inner

    def get_any_name(self) -> str:
        return self.inner[0] if self.inner else next(iter(self.names))

    def get_names(self) -> set[str]:
        return set(self.names)


def test_the_inputs_go_by_name_in_both_backends():
    onnx = Backend(["b", "a"], lambda _: [])
    assert textfind.ordered(onnx, {"a": 1, "b": 2}) == [2, 1]
    # OpenVINO's backend keeps the compiled model, whose ports have the names
    openvino = type(
        "Ov", (), {"_compiled": type("C", (), {"inputs": [Port("b", "/m/Cast_output_0"), Port("a")]})()}
    )()
    assert textfind.ordered(openvino, {"a": 1, "b": 2}) == [2, 1]
    assert textfind.ordered(object(), {"a": 1, "b": 2}) == [1, 2]
    # an input none of whose names is given is said, not fed a wrong value
    with pytest.raises(KeyError, match="c"):
        textfind.ordered(type("Ov", (), {"_compiled": type("C", (), {"inputs": [Port("c")]})()})(), {"a": 1})


# ------------------------------------------------------------------ a translator


class Tokenizer:
    """Words of the translator: ids 10 + position, decoded through `words`."""

    words = {5: "red", 6: "bag", 7: "."}

    def __call__(self, text: str, return_tensors: str = "np") -> dict[str, Any]:
        n = len(text.split())
        return {
            "input_ids": np.array([[10 + i for i in range(n)] + [0]]),
            "attention_mask": np.ones((1, n + 1), dtype=np.int64),
        }

    def decode(self, ids: list[int], skip_special_tokens: bool = True) -> str:
        return " ".join(self.words.get(i, "?") for i in ids).replace(" .", ".")


CONFIG = {"decoder_start_token_id": 99, "pad_token_id": 99, "eos_token_id": 0}


def translator(script: list[int], language: str = "ru", vocabulary: int = 100) -> textfind.Translator:
    """A loaded translator whose decoder says `script` token by token, the pad token always loudest (never said)."""
    t = textfind.Translator(None, Logger(), base_url="", language=language)  # type: ignore[arg-type]

    def decode(named: dict[str, Any]) -> list[Any]:
        step = named["input_ids"].shape[1] - 1
        logits = np.zeros((1, step + 1, vocabulary), dtype=np.float32)
        logits[0, -1, CONFIG["pad_token_id"]] = 100
        logits[0, -1, script[step] if step < len(script) else 0] = 50
        return [logits]

    t.encoder = Backend(
        ["input_ids", "attention_mask"], lambda named: [np.ones((1, named["input_ids"].shape[1], 4))]
    )
    # the decoder's inputs are not in the order of the call: they are fed by name
    t.decoder = Backend(["encoder_attention_mask", "input_ids", "encoder_hidden_states"], decode)
    t.tokenizer = Tokenizer()
    t.config = CONFIG
    t.initialized = True
    return t


def translators(*loaded: textfind.Translator) -> textfind.Translators:
    many = textfind.Translators(None, Logger(), base_url="")  # type: ignore[arg-type]
    for t in loaded:
        many.by_language[t.language] = t
    return many


def test_the_translation_is_greedy_and_ends_at_the_end_token():
    t = translator([5, 6, 7, 0])
    assert asyncio.run(t.english("красная сумка")) == "red bag"
    # each step the whole output so far, starting with the start token
    assert [call["input_ids"].tolist() for call in t.decoder.calls] == [
        [[99]],
        [[99, 5]],
        [[99, 5, 6]],
        [[99, 5, 6, 7]],
    ]
    assert t.decoder.calls[0]["encoder_hidden_states"].shape == (1, 3, 4)


def test_a_translation_that_never_ends_is_cut():
    t = translator([5] * 100)
    asyncio.run(t.english("сумка"))
    assert len(t.decoder.calls) == textfind.MAX_TOKENS


def test_each_language_has_its_translator_english_none():
    ru, de = translator([5, 0], "ru"), translator([6, 0], "de")
    many = translators(ru, de)
    assert asyncio.run(many.english("  red bag ", "en")) == "red bag"
    assert asyncio.run(many.english("сумка", "de")) == "red", "Cyrillic is Russian on a German platform too"
    assert asyncio.run(many.english("Tasche", "de")) == "bag"
    assert asyncio.run(many.english("Человек", None)) == "person", "a known word needs no model"
    assert len(ru.decoder.calls) == 2 and len(de.decoder.calls) == 2


class SlowTranslator(textfind.Translator):
    """Loads in `seconds`, then translates by `script`."""

    def __init__(self, seconds: float, script: list[int]) -> None:
        super().__init__(None, Logger(), base_url="", language="ru")  # type: ignore[arg-type]
        self.seconds = seconds
        self.loads = 0
        self.script = script

    async def _load(self) -> None:
        self.loads += 1
        await asyncio.sleep(self.seconds)
        ready = translator(self.script)
        self.encoder, self.decoder, self.tokenizer, self.config = (
            ready.encoder,
            ready.decoder,
            ready.tokenizer,
            ready.config,
        )
        self.initialized = True


def test_a_translator_that_loads_is_waited_for_a_while_then_the_query_goes_as_it_is():
    async def run() -> None:
        slow = SlowTranslator(0.05, [5, 0])
        many = translators(slow)
        many.logger = Logger()
        assert await many.english("сумка", None, wait=0.01) == "сумка"
        assert any("still loads" in line for line in many.logger.said)
        # it loads on: a little later the same query is translated, by the one load
        await asyncio.sleep(0.06)
        assert await many.english("сумка", None, wait=0.01) == "red"
        assert slow.loads == 1
        # waited for as long as it takes when the caller can
        slower = SlowTranslator(0.02, [6, 0])
        assert await translators(slower).english("сумка", None) == "bag"

    asyncio.run(run())


def test_a_translator_loads_once_whoever_asks_and_a_failed_load_is_tried_again():
    async def run() -> None:
        slow = SlowTranslator(0.02, [5, 0])
        many = translators(slow)
        assert many.ready(None) and not many.ready("ru")
        await asyncio.gather(many.load("ru"), many.load("ru"), slow.initialize())
        assert slow.loads == 1 and many.ready("ru")
        assert many.load("ru") is None and many.load(None) is None

        class Failing(SlowTranslator):
            fail = True

            async def _load(self) -> None:
                self.loads += 1
                if Failing.fail:
                    raise RuntimeError("no mirror")
                await super()._load()

        failing = Failing(0.0, [5, 0])
        with pytest.raises(RuntimeError):
            await failing.initialize()
        Failing.fail = False
        await failing.initialize()
        assert failing.loads == 3 and failing.initialized

    asyncio.run(run())


def test_the_translators_leave_the_manager_when_closed():
    forgotten: list[str] = []
    ru = translator([5, 0])
    many = translators(ru)
    many.manager = type("Manager", (), {"forget": lambda _self, name: forgotten.append(name)})()
    backends = (ru.encoder, ru.decoder)
    many.close()
    assert all(b.closed for b in backends)  # type: ignore[union-attr]
    assert forgotten == ["opus-mt-ru-en-encoder", "opus-mt-ru-en-decoder"]
    assert many.by_language == {}


# ------------------------------------------------------------------ the boxes


def test_boxes_are_the_best_ones_from_the_floor_overlapping_ones_once():
    logits = np.array(
        [logit(0.02), logit(0.6), logit(0.55), logit(0.3), logit(0.2), logit(0.12), logit(0.049)]
    )
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
    assert (
        max(Image.open(io.BytesIO(textfind.crop_of(image, {"x": 0, "y": 0, "width": 1, "height": 1}))).size)
        == textfind.CROP_SIDE
    )


def owl_finder(scores: list[float], *loaded: textfind.Translator) -> textfind.TextFinder:
    """A finder whose OWL sees one thing a picture, scored in turn, at the left of the picture."""
    finder = textfind.TextFinder(
        None, Logger(), base_url="", translators=translators(*(loaded or (translator([5, 6, 0]),)))
    )  # type: ignore[arg-type]
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
        return {
            "input_ids": np.zeros((1, textfind.OWL_TOKENS), dtype=np.int64),
            "attention_mask": np.ones((1, textfind.OWL_TOKENS), dtype=np.int64),
        }

    finder.owl_tokenizer = tokens
    finder.initialized = True
    return finder


def test_a_find_has_its_crop_a_weak_one_only_its_boxes():
    finder = owl_finder([0.4, 0.07])
    pictures = [Image.new("RGB", (640, 360), (90, 90, 90)) for _ in range(2)]
    result = asyncio.run(finder.find("красная сумка", pictures, "en"))
    assert result["query"] == "red bag" and finder.asked == ["a photo of red bag"]
    assert result["foundScore"] == textfind.FOUND_SCORE
    first, second = result["pictures"]
    assert first["boxes"][0]["score"] == 0.4 and Image.open(io.BytesIO(first["crop"])).size[0] > 0
    assert second["boxes"][0]["score"] == 0.07 and "crop" not in second
    assert finder.busy == 0


def test_the_finder_asks_in_the_platforms_language():
    finder = owl_finder([0.4], translator([6, 0], "de"))
    result = asyncio.run(finder.find("Tasche", [Image.new("RGB", (64, 64))], "de"))
    assert result["query"] == "bag"


def test_the_model_is_not_idle_while_a_find_is_under_way():
    finder = owl_finder([0.4])
    now = time.monotonic()
    finder.last_used = now - textfind.IDLE_S - 1
    assert finder.idle(now)
    finder.busy = 1
    assert not finder.idle(now)
    finder.busy = 0
    finder.last_used = now - textfind.IDLE_S + 5
    assert not finder.idle(now)


def test_a_closed_finder_leaves_the_manager_too_and_the_translators_stay():
    forgotten: list[str] = []
    finder = owl_finder([0.4])
    finder.manager = type("Manager", (), {"forget": lambda _self, name: forgotten.append(name)})()  # type: ignore[assignment]
    owl = finder.owl
    finder.close()
    assert owl.closed and forgotten == [textfind.OWL_MODEL]  # type: ignore[union-attr]
    assert finder.owl is None and not finder.initialized
    assert finder.translators.ready("ru")


# ------------------------------------------------------------------ the plugin's methods


class Encoder:
    """A CLIP encoder of a family, that says what it was asked to embed."""

    def __init__(self, family: str) -> None:
        self.embedding_model = family
        self.initialized = True
        self.asked: list[str] = []

    async def embed_text(self, text: str) -> list[float]:
        self.asked.append(text)
        return [1.0, 0.0]


class Finder:
    """TextFinder that fails to load while `fail` says so."""

    fail: str | None = None
    made = 0

    def __init__(self, *_args: Any, **kwargs: Any) -> None:
        Finder.made += 1
        self.translators = kwargs.get("translators")
        self.initialized = False
        self.closed = False
        self.asked: list[tuple[str, int, str | None]] = []
        self.last_used = time.monotonic()

    async def initialize(self) -> None:
        await asyncio.sleep(0.01)
        if Finder.fail:
            raise RuntimeError(Finder.fail)
        self.initialized = True

    async def find(self, text: str, images: list[Any], platform: str | None = None) -> dict[str, Any]:
        self.asked.append((text, len(images), platform))
        self.last_used = time.monotonic()
        return {"query": text, "pictures": [{"boxes": []} for _ in images]}

    def idle(self, now: float) -> bool:
        return now - self.last_used >= 0.05

    def close(self) -> None:
        self.closed = True


PLUGINS = {"onnx": ("camera-ui-onnx", "ONNXPlugin"), "openvino": ("camera-ui-openvino", "OpenVinoPlugin")}


def _plugin_class(which: str) -> type:
    folder, name = PLUGINS[which]
    path = ROOT / folder / "src" / "main.py"
    tree = ast.parse(path.read_text(encoding="utf-8"))
    cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == name)
    cls.bases = []
    keep = {
        "findInPictures",
        "_close_text_finder_when_idle",
        "get_text_finder",
        "_load_text_finder",
        "getTextEmbedding",
        "getTextEmbeddings",
        "_clip_query",
        "_preload_clip",
    }
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
        "TEXT_FINDER_IDLE_S": 0.05,
        "CLIP_TRANSLATE_WAIT_S": 0.05,
        "MODEL_BASE_URL": "https://mirror/v1/onnx",
        "TEXTFIND_BASE_URL": "https://mirror/v1/onnx",
        "OWL_MODEL": textfind.OWL_MODEL,
        "TextFinder": Finder,
        "language_of": textfind.language_of,
        "clip_score_band": lambda family: [0.1, 0.3],
    }
    exec(compile(ast.fix_missing_locations(module), str(path), "exec"), namespace)
    return namespace[name]


def plugin(which: str, encoder: Encoder | None = None, *loaded: textfind.Translator) -> Any:
    cls = _plugin_class(which)
    cls.__init__ = lambda self: None  # type: ignore[method-assign]
    p = cls()
    p.model_manager = None
    p.logger = Logger()
    p.text_finder = None
    p._text_finder_idle = None
    p._text_finder_load = None
    p._text_finder_error = None
    p.translators = translators(*(loaded or (translator([5, 6, 0]),)))
    p.failed = []
    p.succeeded = []
    p._load_failed = lambda name, error: p.failed.append((name, str(error)))
    p._load_succeeded = lambda name: p.succeeded.append(name)
    the_encoder = encoder or Encoder("clip-vit-base-patch32")
    p.clip_model = lambda: "clip-vit-base-patch32-vision"

    async def get_clip_encoder(_name: str) -> Encoder:
        return the_encoder

    p.get_clip_encoder = get_clip_encoder
    p.encoder = the_encoder
    return p


@pytest.fixture(autouse=True)
def fake_finder() -> None:
    Finder.fail = None
    Finder.made = 0


def picture() -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (32, 32)).save(out, format="JPEG")
    return out.getvalue()


@pytest.mark.parametrize("which", PLUGINS)
def test_a_russian_search_reaches_an_english_clip_in_english(which: str):
    async def run() -> None:
        p = plugin(which)
        assert (await p.getTextEmbeddings("красная сумка"))[0]["embedding"] == [1.0, 0.0]
        await p.getTextEmbedding("красная сумка")
        await p.getTextEmbeddings("red bag", {"language": "en"})
        assert p.encoder.asked == ["red bag", "red bag", "red bag"]

    asyncio.run(run())


@pytest.mark.parametrize("which", PLUGINS)
def test_the_platforms_language_is_put_into_english_too(which: str):
    async def run() -> None:
        p = plugin(which, None, translator([5, 0], "ru"), translator([6, 0], "de"))
        await p.getTextEmbeddings("Tasche", {"language": "de"})
        await p.getTextEmbeddings("Tasche", {"language": "en"})
        assert p.encoder.asked == ["bag", "Tasche"]

    asyncio.run(run())


@pytest.mark.parametrize("which", PLUGINS)
def test_a_multilingual_clip_gets_the_query_as_it_is(which: str):
    async def run() -> None:
        p = plugin(which, Encoder("siglip-base-patch16-256-multilingual"))
        await p.getTextEmbeddings("красная сумка", {"language": "ru"})
        await p.getTextEmbedding("красная сумка")
        assert p.encoder.asked == ["красная сумка", "красная сумка"]

    asyncio.run(run())


@pytest.mark.parametrize("which", PLUGINS)
def test_a_translator_still_loading_lets_the_search_go_on_as_it_is(which: str):
    async def run() -> None:
        p = plugin(which, None, SlowTranslator(0.2, [5, 0]))
        started = time.monotonic()
        await p.getTextEmbeddings("сумка")
        assert time.monotonic() - started < 0.15, "waited CLIP_TRANSLATE_WAIT_S, not the whole load"
        assert p.encoder.asked == ["сумка"]

    asyncio.run(run())


@pytest.mark.parametrize("which", PLUGINS)
def test_the_russian_translator_is_ready_with_an_english_clip_only(which: str):
    async def run() -> None:
        slow = SlowTranslator(0.01, [5, 0])
        p = plugin(which, None, slow)
        await p._preload_clip()
        assert slow.initialized
        other = SlowTranslator(0.01, [5, 0])
        multilingual = plugin(which, Encoder("siglip-base-patch16-256-multilingual"), other)
        await multilingual._preload_clip()
        assert other.loads == 0

    asyncio.run(run())


@pytest.mark.parametrize("which", PLUGINS)
def test_the_first_find_loads_in_the_background_and_says_so_then_the_finds_come(which: str):
    async def run() -> None:
        p = plugin(which)
        # a call ends after 30 s, the models take longer: the first answer is that they load
        assert await p.findInPictures("сумка", [picture(), picture()]) == {
            "query": "сумка",
            "loading": True,
            "pictures": [],
        }
        # asked again while they load: still loading, one load
        assert (await p.findInPictures("сумка", [picture()]))["loading"] is True
        await asyncio.sleep(0.03)
        assert Finder.made == 1 and p.succeeded == [textfind.OWL_MODEL]
        result = await p.findInPictures("сумка", [picture(), picture()], {"language": "ru"})
        assert result["pictures"] == [{"boxes": []}, {"boxes": []}]
        finder = p.text_finder
        assert finder.asked == [("сумка", 2, "ru")] and finder.translators is p.translators
        # asked again before it is idle: the same finder, still in memory; then idle, out of it
        await p.findInPictures("сумка", [picture()])
        assert Finder.made == 1 and not finder.closed
        await asyncio.sleep(0.12)
        assert finder.closed and p.text_finder is None

    asyncio.run(run())


@pytest.mark.parametrize("which", PLUGINS)
def test_the_translator_of_the_query_is_loaded_with_the_finder(which: str):
    async def run() -> None:
        slow = SlowTranslator(0.05, [6, 0])
        slow.language, slow.family = "de", "opus-mt-de-en"
        p = plugin(which, None, translator([5, 0]), slow)
        assert (await p.findInPictures("сумка", [picture()]))["loading"] is True
        await asyncio.sleep(0.03)
        assert (await p.findInPictures("сумка", [picture()]))["pictures"] == [{"boxes": []}]
        # the finder is there, the German translator not yet: the German query waits for it, loading
        assert (await p.findInPictures("Tasche", [picture()], {"language": "de"}))["loading"] is True
        assert p.text_finder.asked == [("сумка", 1, None)]
        await asyncio.sleep(0.08)
        assert slow.initialized
        assert (await p.findInPictures("Tasche", [picture()], {"language": "de"}))["pictures"] == [
            {"boxes": []}
        ]

    asyncio.run(run())


@pytest.mark.parametrize("which", PLUGINS)
def test_loaded_and_never_asked_it_leaves_memory_too(which: str):
    async def run() -> None:
        p = plugin(which)
        await p.findInPictures("сумка", [picture()])
        await asyncio.sleep(0.03)
        finder = p.text_finder
        assert finder.initialized and not finder.closed
        await asyncio.sleep(0.12)
        assert finder.closed and p.text_finder is None

    asyncio.run(run())


@pytest.mark.parametrize("which", PLUGINS)
def test_nothing_asked_loads_nothing_and_a_failed_load_is_said_once(which: str):
    async def run() -> None:
        p = plugin(which)
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


# ------------------------------------------------------------------ the two plugins: the same module, the same paths


def test_both_plugins_carry_the_same_module():
    assert (ROOT / "camera-ui-onnx" / "src" / "textfind.py").read_bytes() == (
        ROOT / "camera-ui-openvino" / "src" / "textfind.py"
    ).read_bytes()


def test_the_onnx_manager_finds_the_models_where_the_mirror_has_them():
    pytest.importorskip("onnxruntime")
    pytest.importorskip("camera_ui_ml")
    import model_manager  # type: ignore[import-not-found]

    rel = model_manager.OnnxModelManager._rel_path
    assert rel("owlvit-base-patch32") == "owlvit-base-patch32/owlvit-base-patch32.onnx"
    assert rel("opus-mt-de-en-encoder") == "opus-mt-de-en/encoder.onnx"
    assert rel("yolo-v9-s-320") == "yolo-v9-s-320/yolo-v9-s-320.onnx"


def test_the_openvino_manager_reads_the_onnx_graphs_of_the_onnx_folder(monkeypatch: pytest.MonkeyPatch):
    """Which files the OpenVINO model manager takes for these models; OpenVINO itself is not needed for that."""
    import importlib.util
    import types

    pytest.importorskip("aiohttp")
    pytest.importorskip("camera_ui_ml")
    if importlib.util.find_spec("openvino") is None:
        monkeypatch.setitem(sys.modules, "openvino", types.ModuleType("openvino"))
    # the plugins share module names: import the OpenVINO ones afresh
    for name in ("model_manager", "defaults", "modules", "trained", "inference"):
        monkeypatch.delitem(sys.modules, name, raising=False)
    monkeypatch.syspath_prepend(str(ROOT / "camera-ui-openvino" / "src"))
    monkeypatch.setitem(sys.modules, "inference", types.SimpleNamespace(OpenVinoBackend=object))
    import model_manager  # type: ignore[import-not-found]

    manager = object.__new__(model_manager.OpenVinoModelManager)
    onnx = model_manager.TEXTFIND_BASE_URL
    assert onnx.endswith("/v1/onnx")
    assert manager.model_files("owlvit-base-patch32") == {
        "xml": (
            f"{onnx}/owlvit-base-patch32/owlvit-base-patch32.onnx",
            "owlvit-base-patch32/owlvit-base-patch32.onnx",
        ),
        "bin": (
            f"{onnx}/owlvit-base-patch32/owlvit-base-patch32.onnx",
            "owlvit-base-patch32/owlvit-base-patch32.onnx",
        ),
    }
    assert manager.model_files("opus-mt-ru-en-decoder")["xml"] == (
        f"{onnx}/opus-mt-ru-en/decoder.onnx",
        "opus-mt-ru-en/decoder.onnx",
    )
    # its own models are still the IR pairs of its folder
    assert manager.model_files("yolo-v9-s-320")["xml"][1] == "yolo-v9-s-320/yolo-v9-s-320.xml"


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

    folder = Path(MODELS)  # type: ignore[arg-type]
    loaded: list[textfind.Translator] = []
    for language, family in textfind.TRANSLATORS.items():
        if not (folder / family).is_dir():
            continue
        t = textfind.Translator(None, Logger(), base_url="", language=language)  # type: ignore[arg-type]
        t.encoder = Real(str(folder / family / "encoder.onnx"))
        t.decoder = Real(str(folder / family / "decoder.onnx"))
        t.tokenizer = AutoTokenizer.from_pretrained(str(folder / family))
        t.config = json.loads((folder / family / "config.json").read_text(encoding="utf-8"))
        t.initialized = True
        loaded.append(t)
    many = translators(*loaded)
    assert asyncio.run(many.english("красный квадрат", None)) in {"red square", "the red square"}
    if "de" in many.by_language:
        assert asyncio.run(many.english("rotes Quadrat", "de")) in {"red square", "the red square"}
    owl = folder / textfind.OWL_MODEL
    finder = textfind.TextFinder(None, Logger(), base_url="", translators=many)  # type: ignore[arg-type]
    finder.owl = Real(str(owl / f"{textfind.OWL_MODEL}.onnx"))
    finder.owl_tokenizer = AutoTokenizer.from_pretrained(str(owl))
    finder.initialized = True
    image = Image.new("RGB", (640, 480), (230, 230, 230))
    ImageDraw.Draw(image).rectangle((400, 80, 559, 239), fill=(220, 20, 20))
    result = asyncio.run(finder.find("красный квадрат", [image]))
    best = result["pictures"][0]["boxes"][0]
    assert best["score"] >= textfind.FOUND_SCORE
    assert best["x"] == pytest.approx(400 / 640, abs=0.05) and best["y"] == pytest.approx(80 / 480, abs=0.05)
