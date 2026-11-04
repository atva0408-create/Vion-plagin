"""Builds vion-ml: the wheel and the sdist in dist/, after the type check.

Nothing is published from here. vion-ml is served by VION's own index (pypi.vionvision.tech), built by
deploy/pypi-index/build-index.sh in VIONN- from this folder; on pypi.org the name camera-ui-ml is the author's, and a
package of ours there under it would be the very dependency confusion the index avoids.

    python scripts/build.py
"""

import shutil
import subprocess
import sys
from pathlib import Path

PACKAGE_NAME = "vion-ml"
PACKAGE_DIR = "camera_ui_ml"
ROOT = Path(__file__).resolve().parents[1]


def run(*command: str) -> None:
    print(f"→ {' '.join(command)}")
    subprocess.run(command, cwd=ROOT, check=True)


def version() -> str:
    for line in (ROOT / "pyproject.toml").read_text(encoding="utf-8").splitlines():
        if line.startswith("version"):
            return line.split("=", 1)[1].strip().strip("\"'")
    raise SystemExit("no version in pyproject.toml")


def main() -> None:
    print(f"Building {PACKAGE_NAME} {version()}")
    for name in ("dist", "build", f"{PACKAGE_DIR}.egg-info"):
        shutil.rmtree(ROOT / name, ignore_errors=True)
    # the marker of the inline types
    (ROOT / PACKAGE_DIR / "py.typed").touch()
    run(sys.executable, "-m", "mypy", "-p", PACKAGE_DIR, "--ignore-missing-imports")
    run(sys.executable, "-m", "build", "--wheel", "--sdist", "--outdir", "dist")
    for built in sorted((ROOT / "dist").iterdir()):
        print(f"  {built.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
