"""Every ML plugin opens JPEG, PNG and WebP pictures and no other format (review 2026-11-04).

Pillow opens a picture in any of the formats it knows when none is named, and the photos people upload for faces and
for a search by picture come to decode_image of camera_ui_ml as they were sent. image_formats.limit_image_formats(),
called by every plugin before a picture is opened, leaves Pillow those three. Run with the Pillow the plugins install
and camera-ui-ml as it comes from PyPI: the limit works on the decode_image there too, not only on our copy.

    python -m pytest camera-ui-onnx/tests/test_image_formats.py
"""

from __future__ import annotations

import importlib.util
import re
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
PLUGINS = ["onnx", "openvino", "ncnn", "coreml", "coral", "onnx-legacy", "openvino-legacy"]

pytest.importorskip("PIL")

# each format a picture of 4x4 pixels, made in a process of its own (the limit is for a whole process)
PICTURES = r"""
import io, sys
from PIL import Image
picture = Image.new("RGB", (4, 4), (200, 30, 40))
for name in ("JPEG", "PNG", "WEBP", "GIF", "BMP", "TIFF", "TGA", "PCX", "ICO", "PPM", "DDS"):
    out = io.BytesIO()
    picture.save(out, name)
    sys.stdout.buffer.write(name.encode() + b" " + out.getvalue().hex().encode() + b"\n")
"""

# the plugin's module limits, then the decode_image camera_ui_ml has and Image.open as the plugins call them
DECODE = r"""
import importlib.util, io, sys
spec = importlib.util.spec_from_file_location("image_formats", sys.argv[1])
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
module.limit_image_formats()
from PIL import Image
from camera_ui_ml.preprocess import decode_image
for line in sys.stdin.read().splitlines():
    name, data = line.split(" ")
    data = bytes.fromhex(data)
    try:
        rgb = decode_image(data)
        Image.open(io.BytesIO(data)).load()
        print(name, "opened", rgb.shape[0], rgb.shape[1])
    except Exception as error:
        print(name, "refused", type(error).__name__)
"""


def pictures() -> str:
    return subprocess.run([sys.executable, "-c", PICTURES], check=True, capture_output=True, text=True).stdout


@pytest.mark.parametrize("plugin", PLUGINS)
def test_the_plugin_opens_jpeg_png_and_webp_and_refuses_every_other_format(plugin: str) -> None:
    module = ROOT / f"camera-ui-{plugin}" / "src" / "image_formats.py"
    if not module.exists():
        # the legacy plugins get src/ from scripts/sync.mjs (it is not in git)
        pytest.skip(f"{module} not synced: node camera-ui-{plugin}/scripts/sync.mjs")
    if importlib.util.find_spec("camera_ui_ml") is None:
        pytest.skip("camera-ui-ml is not installed: pip install -r camera-ui-onnx/requirements.txt")
    result = subprocess.run(
        [sys.executable, "-c", DECODE, str(module)],
        input=pictures(),
        check=True,
        capture_output=True,
        text=True,
    )
    outcome = dict(line.split(" ", 1) for line in result.stdout.splitlines())
    assert outcome.pop("JPEG") == "opened 4 4"
    assert outcome.pop("PNG") == "opened 4 4"
    assert outcome.pop("WEBP") == "opened 4 4"
    assert outcome and all(value == "refused UnidentifiedImageError" for value in outcome.values()), outcome


@pytest.mark.parametrize("plugin", PLUGINS)
def test_the_plugin_limits_the_formats_before_a_picture_is_opened(plugin: str) -> None:
    main = ROOT / f"camera-ui-{plugin}" / "src" / "main.py"
    if not main.exists():
        pytest.skip(f"{main} not synced: node camera-ui-{plugin}/scripts/sync.mjs")
    source = main.read_text(encoding="utf-8")
    assert "from image_formats import limit_image_formats" in source
    # at the top of the module, once its imports are done: before any class or function of the plugin runs
    call = re.search(r"^limit_image_formats\(\)$", source, re.MULTILINE)
    first_definition = re.search(r"^(class|def|async def) ", source, re.MULTILINE)
    assert call and first_definition and call.start() < first_definition.start()


COPY = r"""
import sys
sys.path.insert(0, sys.argv[1])
from camera_ui_ml.preprocess import decode_image
for line in sys.stdin.read().splitlines():
    name, data = line.split(" ")
    try:
        rgb = decode_image(bytes.fromhex(data))
        print(name, "opened", rgb.shape[0], rgb.shape[1])
    except Exception as error:
        print(name, "refused", type(error).__name__)
"""


def test_our_copy_of_camera_ui_ml_opens_those_formats_by_itself() -> None:
    """vion-ml (our copy) names the formats in decode_image: the limit holds without the plugin's module."""
    copy = ROOT / "packages" / "camera_ui_ml"
    result = subprocess.run(
        [sys.executable, "-c", COPY, str(copy)], input=pictures(), check=True, capture_output=True, text=True
    )
    outcome = dict(line.split(" ", 1) for line in result.stdout.splitlines())
    assert [outcome.pop(name) for name in ("JPEG", "PNG", "WEBP")] == ["opened 4 4"] * 3
    assert outcome and all(value == "refused UnidentifiedImageError" for value in outcome.values()), outcome
