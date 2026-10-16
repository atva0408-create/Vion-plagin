"""The start of the detector plugins loads the picture search's CLIP and, for a model that knows English only, the
translator of Russian searches; a failure of either says which one and why.

ONNX Legacy said «Не удалось предзагрузить модели CLIP:» with no words at each start of 2026-10-13/14 although CLIP had
loaded: the translator failed (sentencepiece missing), its error had no text, and it was told as CLIP's. The real
``_preload_clip`` of the plugins runs here with fake models.

    python -m pytest camera-ui-onnx/tests/test_preload_clip.py
"""

from __future__ import annotations

import ast
import asyncio
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[2]
# the legacy plugins are built from these two sources (their src/ is a copy, not in git)
PLUGINS = ["onnx", "openvino"]


class Logger:
    def __init__(self) -> None:
        self.said: list[str] = []
        self.errors: list[str] = []

    def log(self, message: str) -> None:
        self.said.append(message)

    def error(self, message: str) -> None:
        self.errors.append(message)


class Encoder:
    def __init__(self, embedding_model: str) -> None:
        self.embedding_model = embedding_model


class Translators:
    def __init__(self, failure: BaseException | None) -> None:
        self.failure = failure
        self.loaded: list[str] = []

    def load(self, language: str) -> Any:
        self.loaded.append(language)

        async def run() -> None:
            if self.failure is not None:
                raise self.failure

        return asyncio.ensure_future(run())


@pytest.fixture(params=PLUGINS)
def plugin_class(request: pytest.FixtureRequest) -> Any:
    path = ROOT / f"camera-ui-{request.param}" / "src" / "main.py"
    tree = ast.parse(path.read_text(encoding="utf-8"))
    method = next(
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "_preload_clip"
    )
    cls = ast.ClassDef(name="Plugin", bases=[], keywords=[], body=[method], decorator_list=[], type_params=[])
    module = ast.Module(
        body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), cls],
        type_ignores=[],
    )
    namespace: dict[str, Any] = {"Any": Any}
    exec(compile(ast.fix_missing_locations(module), str(path), "exec"), namespace)
    return namespace["Plugin"]


def start(
    plugin_class: Any,
    *,
    clip: BaseException | None = None,
    translator: BaseException | None = None,
    model: str = "clip-vit-b32",
) -> tuple[Logger, Translators]:
    instance = object.__new__(plugin_class)
    instance.logger = Logger()
    instance.translators = Translators(translator)
    instance.clip_model = lambda: model

    async def get_clip_encoder(_name: str) -> Encoder:
        if clip is not None:
            raise clip
        return Encoder(model)

    instance.get_clip_encoder = get_clip_encoder
    asyncio.run(instance._preload_clip())
    return instance.logger, instance.translators


def test_a_translator_that_fails_with_no_words_is_named_with_the_kind_of_its_error(plugin_class: Any) -> None:
    logger, translators = start(plugin_class, translator=RuntimeError())
    assert translators.loaded == ["ru"]
    assert "Модели CLIP предзагружены" in logger.said
    assert len(logger.errors) == 1
    assert "переводчик" in logger.errors[0] and "RuntimeError" in logger.errors[0]
    assert "CLIP" not in logger.errors[0]


def test_clip_that_fails_says_so_and_why(plugin_class: Any) -> None:
    logger, translators = start(plugin_class, clip=TimeoutError())
    assert logger.errors == ["Не удалось предзагрузить модели CLIP: TimeoutError"]
    assert "Модели CLIP предзагружены" not in logger.said
    assert translators.loaded == []
    logger, _ = start(plugin_class, clip=OSError("нет файла модели"))
    assert logger.errors == ["Не удалось предзагрузить модели CLIP: нет файла модели"]


def test_all_well_nothing_is_said_wrong_and_a_multilingual_model_needs_no_translator(
    plugin_class: Any,
) -> None:
    logger, translators = start(plugin_class)
    assert logger.errors == [] and translators.loaded == ["ru"]
    logger, translators = start(plugin_class, model="siglip-multilingual")
    assert logger.errors == [] and translators.loaded == []
