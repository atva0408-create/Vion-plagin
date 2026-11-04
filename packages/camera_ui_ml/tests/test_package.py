"""vion-ml is what the ML plugins install, from VION's index, and it brings nothing of the author's.

The plugins installed camera-ui-ml 1.2.15 from pypi.org: our changes to this copy never reached a client, and pip took
camera-ui-sdk from the author's project along with it. A package of ours under his name would be taken from whichever
index has the larger version. So: our name, no camera-ui-* among its dependencies, and every ML plugin asking for this
very version.
"""

from __future__ import annotations

import re
import tomllib
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[1]
PLUGINS = PACKAGE.parents[1]
ML_PLUGINS = ["onnx", "openvino", "onnx-legacy", "openvino-legacy", "ncnn", "coreml", "coral"]


def project() -> dict[str, object]:
    with open(PACKAGE / "pyproject.toml", "rb") as file:
        return tomllib.load(file)["project"]  # type: ignore[no-any-return]


def test_the_package_has_our_name_and_none_of_the_author_s_dependencies() -> None:
    meta = project()
    assert meta["name"] == "vion-ml"
    dependencies = [str(dependency) for dependency in meta["dependencies"]]  # type: ignore[attr-defined]
    assert not [dependency for dependency in dependencies if re.match(r"camera[-_.]ui", dependency, re.I)]
    urls = " ".join(str(url) for url in meta["urls"].values())  # type: ignore[attr-defined]
    assert "cameraui" not in urls and "seydx" not in urls


def test_every_ml_plugin_installs_this_version_and_not_camera_ui_ml() -> None:
    version = project()["version"]
    for plugin in ML_PLUGINS:
        requirements = (PLUGINS / f"camera-ui-{plugin}" / "requirements.txt").read_text(encoding="utf-8")
        assert f"vion-ml=={version}" in requirements.splitlines(), plugin
        assert not re.search(r"^camera[-_]ui[-_]ml\b", requirements, re.I | re.M), plugin
