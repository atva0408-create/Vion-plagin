"""A model file from the mirror is kept only when it is what was asked for (ViON audit 2026-10-23, ML5).

A captive portal of a hotel or train Wi-Fi, or an error page answering 200, was saved as the model and stayed for good:
the download is skipped for a file in place, and every start failed to load it. The engines install camera-ui-ml from
PyPI, whose download checks nothing, so each engine carries the same checked_download.py; this test runs it and holds
the copies equal.

    python -m pytest camera-ui-onnx/tests/test_checked_download.py
"""

from __future__ import annotations

import asyncio
import importlib.util
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[2]
ENGINES = ["onnx", "openvino", "coral", "coreml", "ncnn"]
MODEL = b"\x08\x07\x12\x04onnx" + bytes(range(256)) * 8
OPENVINO_XML = b'<?xml version="1.0"?>\n<net name="yolo" version="11">\n<layers/></net>\n'
PORTAL = b"<!DOCTYPE html>\n<html><head><title>Sign in to the Wi-Fi</title></head><body>...</body></html>"


def load(engine: str) -> Any:
    path = ROOT / f"camera-ui-{engine}" / "src" / "checked_download.py"
    spec = importlib.util.spec_from_file_location(f"checked_download_{engine}", path)
    assert spec and spec.loader, path
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Logger:
    def __init__(self) -> None:
        self.lines: list[str] = []

    def log(self, message: str) -> None:
        self.lines.append(message)

    def warn(self, message: str) -> None:
        self.lines.append(f"warn: {message}")


def serve(
    module: Any,
    monkeypatch: pytest.MonkeyPatch,
    body: bytes,
    content_type: str = "application/octet-stream",
    length: int | None = None,
    status: int = 200,
) -> list[str]:
    asked: list[str] = []

    class Content:
        async def iter_chunked(self, size: int) -> Any:
            for start in range(0, len(body), 100):
                yield body[start : start + 100]

    class Response:
        def __init__(self) -> None:
            self.status = status
            self.headers = {
                "content-type": content_type,
                "content-length": str(len(body) if length is None else length),
            }
            self.content = Content()

        async def __aenter__(self) -> Response:
            return self

        async def __aexit__(self, *_: Any) -> None:
            return None

    class Session:
        async def __aenter__(self) -> Session:
            return self

        async def __aexit__(self, *_: Any) -> None:
            return None

        def get(self, url: str) -> Response:
            asked.append(url)
            return Response()

    monkeypatch.setattr(module.aiohttp, "ClientSession", Session)
    return asked


def fetch(module: Any, root: Path, rel: str = "v1/yolo/model.onnx") -> Logger:
    logger = Logger()
    asyncio.run(module.download(str(root), "https://models.test/" + rel, rel, logger))
    return logger


def test_every_engine_carries_the_same_file() -> None:
    texts = {
        engine: (ROOT / f"camera-ui-{engine}" / "src" / "checked_download.py").read_text(encoding="utf-8")
        for engine in ENGINES
    }
    assert len(set(texts.values())) == 1, "the copies drifted apart"
    for engine in ENGINES:
        manager = (ROOT / f"camera-ui-{engine}" / "src" / "model_manager.py").read_text(encoding="utf-8")
        assert "async def _download(self, url: str, rel: str) -> None:" in manager, engine
        assert "await checked_download(self.model_path, url, rel, self.logger)" in manager, engine


@pytest.fixture(params=ENGINES)
def module(request: pytest.FixtureRequest) -> Any:
    return load(str(request.param))


def test_a_model_is_saved_whole(module: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    serve(module, monkeypatch, MODEL)
    fetch(module, tmp_path)
    assert (tmp_path / "v1/yolo/model.onnx").read_bytes() == MODEL
    assert not list(tmp_path.rglob("*.tmp"))


def test_the_xml_of_an_openvino_model_is_a_model(
    module: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    serve(module, monkeypatch, OPENVINO_XML, content_type="application/xml")
    fetch(module, tmp_path, "v1/yolo/model.xml")
    assert (tmp_path / "v1/yolo/model.xml").read_bytes() == OPENVINO_XML


@pytest.mark.parametrize("content_type", ["text/html; charset=utf-8", "application/octet-stream"])
def test_a_web_page_is_not_saved_as_the_model(
    module: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, content_type: str
) -> None:
    serve(module, monkeypatch, PORTAL, content_type=content_type)
    with pytest.raises(RuntimeError, match="веб-страниц"):
        fetch(module, tmp_path)
    assert not (tmp_path / "v1/yolo/model.onnx").exists()
    assert not list(tmp_path.rglob("*.tmp"))


def test_a_page_sent_as_html_is_refused_whatever_it_starts_with(
    module: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # a portal that sends a redirect script and no markup is told by its type
    serve(module, monkeypatch, b"window.location='https://wifi.example/login'", content_type="text/html")
    with pytest.raises(RuntimeError, match="веб-страниц"):
        fetch(module, tmp_path)
    assert not (tmp_path / "v1/yolo/model.onnx").exists()


def test_a_file_cut_short_is_not_saved(module: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    serve(module, monkeypatch, MODEL[:1000], length=len(MODEL))
    with pytest.raises(RuntimeError, match="не целиком"):
        fetch(module, tmp_path)
    assert not (tmp_path / "v1/yolo/model.onnx").exists()


def test_a_page_saved_before_is_downloaded_again(
    module: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    saved = tmp_path / "v1/yolo/model.onnx"
    saved.parent.mkdir(parents=True)
    saved.write_bytes(PORTAL)
    asked = serve(module, monkeypatch, MODEL)
    logger = fetch(module, tmp_path)
    assert saved.read_bytes() == MODEL
    assert asked == ["https://models.test/v1/yolo/model.onnx"]
    assert any(line.startswith("warn:") for line in logger.lines)


def test_a_model_in_place_is_not_downloaded_again(
    module: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    saved = tmp_path / "v1/yolo/model.onnx"
    saved.parent.mkdir(parents=True)
    saved.write_bytes(MODEL)
    asked = serve(module, monkeypatch, b"new")
    fetch(module, tmp_path)
    assert asked == []
    assert saved.read_bytes() == MODEL
