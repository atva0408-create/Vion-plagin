"""A model file downloaded from the mirror is kept only when it is what was asked for.

A captive portal of a hotel or train Wi-Fi, or an error page answering 200, was saved as the model, and the file stayed
for good: a file in place is not downloaded again, and every start failed to load it (ViON audit 2026-10-23). The
engines install camera-ui-ml from PyPI, whose download checks nothing: each engine carries this same file
(camera-ui-onnx/tests/test_checked_download.py holds the copies equal).
"""

from __future__ import annotations

import os
from typing import Any

import aiohttp

_CHUNK = 1024 * 1024
# enough to tell a page from a model: a page starts with its doctype or <html> within its first bytes
_SNIFF = 512


def looks_like_a_page(head: bytes) -> bool:
    """HTML where a model was expected. The XML of an OpenVINO model has no <html in it."""
    text = head.lstrip()[:_SNIFF].lower()
    return text.startswith(b"<!doctype html") or b"<html" in text


def _saved_page(path: str) -> bool:
    with open(path, "rb") as handle:
        return looks_like_a_page(handle.read(_SNIFF))


async def download(model_path: str, url: str, rel: str, logger: Any) -> None:
    full_path = os.path.join(model_path, rel)
    name = os.path.basename(rel)
    if os.path.isfile(full_path):
        if not _saved_page(full_path):
            return
        # saved by a version without these checks: it would never load
        logger.warn(f"{name} — веб-страница, а не модель: скачиваю заново")
        os.remove(full_path)

    os.makedirs(os.path.dirname(full_path), exist_ok=True)
    tmp_path = full_path + ".tmp"
    logger.log(f"Downloading {name}...")
    downloaded = 0
    try:
        async with aiohttp.ClientSession() as session, session.get(url) as response:
            if response.status < 200 or response.status >= 300:
                raise RuntimeError(f"Error downloading {url}: {response.status}")
            if "text/html" in str(response.headers.get("content-type", "")).lower():
                raise RuntimeError(f"{url} ответил веб-страницей, а не моделью: сеть просит войти?")

            total = int(response.headers.get("content-length", 0) or 0)
            last_step = 0
            head = b""
            with open(tmp_path, "wb") as handle:
                async for chunk in response.content.iter_chunked(_CHUNK):
                    if not chunk:
                        continue
                    if len(head) < _SNIFF:
                        head += chunk[: _SNIFF - len(head)]
                    downloaded += len(chunk)
                    handle.write(chunk)
                    if total > _CHUNK:
                        percent = min(100, downloaded * 100 // total)
                        if percent >= last_step + 25:
                            last_step = (percent // 25) * 25
                            logger.log(f"Downloading {name}... {last_step}%")

            if looks_like_a_page(head):
                raise RuntimeError(f"{url} ответил веб-страницей, а не моделью: сеть просит войти?")
            if total and downloaded != total:
                raise RuntimeError(f"{name} скачался не целиком: {downloaded} из {total} байт")
    except BaseException:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise

    os.replace(tmp_path, full_path)
    logger.log(f"Downloaded {name} ({downloaded / _CHUNK:.1f} MB)")
