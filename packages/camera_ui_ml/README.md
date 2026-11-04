# vion-ml

The ML inference the detection plugins of VION share (ONNX, OpenVINO, CoreML, NCNN, Coral): model management, pre- and
post-processing, box and face pipelines. The module is `camera_ui_ml`, as the plugins import it.

Installed from VION's own index, never from pypi.org:

```sh
pip install --index-url https://pypi.vionvision.tech/simple --extra-index-url https://pypi.org/simple vion-ml
```

`camera_ui_sdk` is not a dependency: the server gives its plugins their own. Build: `python scripts/build.py` (wheel
and sdist in `dist/`); the index itself is built by `deploy/pypi-index/build-index.sh` in VIONN-.
