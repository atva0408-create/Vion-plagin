"""The picture formats this plugin opens.

Pillow opens a picture in any format it knows when none is named (43 in Pillow 13, EPS through Ghostscript among
them), and camera_ui_ml (from PyPI) and this plugin open every picture so: the snapshots of the cameras, and the
photos people upload for faces and for a search by picture. Those are JPEG and PNG, and WebP, which the interface lets
through for a face. The other decoders are code an upload should not reach, so the formats are limited for the whole
process, before the first picture is opened.
"""

from __future__ import annotations

from PIL import Image

READ_FORMATS = ("JPEG", "PNG", "WEBP")


def limit_image_formats() -> None:
    """Leaves Pillow the decoders of READ_FORMATS alone; another format is then "cannot identify image file"."""
    # every plugin of Pillow registers now, once: a later Image.open() does not register the others again
    Image.init()
    for name in list(Image.ID):
        if name not in READ_FORMATS:
            Image.ID.remove(name)
            Image.OPEN.pop(name, None)
