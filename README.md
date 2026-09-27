<p align="center">
  <img src=".github/vion-logo.svg" alt="ViON" width="320" />
</p>

# ViON - Plugins

Official plugins for the ViON video surveillance platform.

All plugins are published under the `@vionvision` npm scope.

## Model downloads

Detection backends (ONNX, OpenVINO, NCNN, CoreML, Coral, YAMNet) download their models on first use.
They come from the ViON mirror `https://models.vionvision.tech` (see `deploy/models-mirror` in the VIONN- repo);
set `VION_MODELS_HOST` to use another mirror. The path layout is `/<version>/<backend>/...`, identical to the upstream host.

## Upstream

Based on [camera.ui plugins](https://github.com/cameraui/plugins) by seydx (MIT), used with the author's permission.
To pull upstream changes:

```sh
git remote add upstream https://github.com/cameraui/plugins.git
git fetch upstream && git merge upstream/main
```

## Plugins

| Plugin                                 | Package                             |
| -------------------------------------- | ----------------------------------- |
| [Coral](camera-ui-coral)               | `@vionvision/camera-ui-coral`        |
| [CoreML](camera-ui-coreml)             | `@vionvision/camera-ui-coreml`       |
| [Eufy](camera-ui-eufy)                 | `@vionvision/camera-ui-eufy`         |
| [HomeKit](camera-ui-homekit)           | `@vionvision/camera-ui-homekit`      |
| [NCNN](camera-ui-ncnn)                 | `@vionvision/camera-ui-ncnn`         |
| [ONNX](camera-ui-onnx)                 | `@vionvision/camera-ui-onnx`         |
| [ONVIF](camera-ui-onvif)               | `@vionvision/camera-ui-onvif`        |
| [OpenCL](camera-ui-opencl)             | `@vionvision/camera-ui-opencl`       |
| [OpenCV](camera-ui-opencv)             | `@vionvision/camera-ui-opencv`       |
| [OpenVino](camera-ui-openvino)         | `@vionvision/camera-ui-openvino`     |
| [Pam Diff](camera-ui-pamdiff)          | `@vionvision/camera-ui-pamdiff`      |
| [Reolink](camera-ui-reolink)           | `@vionvision/camera-ui-reolink`      |
| [Ring](camera-ui-ring)                 | `@vionvision/camera-ui-ring`         |
| [Rust Motion](camera-ui-rust-motion)   | `@vionvision/camera-ui-rust-motion`  |
| [SMTP](camera-ui-smtp)                 | `@vionvision/camera-ui-smtp`         |
| [Tuya](camera-ui-tuya)                 | `@vionvision/camera-ui-tuya`         |
| [WASM Motion](camera-ui-wasm-motion)   | `@vionvision/camera-ui-wasm-motion`  |
| [Wyze](camera-ui-wyze)                 | `@vionvision/camera-ui-wyze`         |
| [YAMNet Audio](camera-ui-audio-yamnet) | `@vionvision/camera-ui-audio-yamnet` |

---

_Part of the ViON ecosystem - [vionvision.tech](https://vionvision.tech)._
