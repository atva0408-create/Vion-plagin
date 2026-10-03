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

## Translations

The ViON interface exists in English, Russian and German, and every plugin ships its own texts in all three:

| File                                                | What it is                                                                        |
| --------------------------------------------------- | --------------------------------------------------------------------------------- |
| `README.md`, `CHANGELOG.md`                         | Description page and list of changes, in English, written for the customer        |
| `i18n/README.<lang>.md`, `i18n/CHANGELOG.<lang>.md` | The same pages in the other languages                                             |
| `i18n/<lang>.json`                                  | Settings texts: `{ "<text as the code writes it>": "<text in that language>" }`  |

`i18n` is listed in `additionalFiles` of `cameraui.config.ts`, so it is part of the bundle. The server serves the
pages in the language of the interface and translates the settings forms through the dictionaries; a text without a
translation is shown the way the code writes it. Pages carry no links and no web addresses: the reader is a customer
inside the product.

After adding or changing a setting:

```sh
npm run i18n -- --sync   # adds the new texts to i18n/*.json with empty values, drops the removed ones
npm run i18n             # lists what is not translated yet; CI runs the same check
```

A text several plugins share must be translated the same way in each of them. A file whose `description` fields are
read by a model rather than by people (tool and answer schemas) is excluded with the comment `i18n-skip-file`.

## Ready-made automations

`automations/catalog.json` and `automations/blueprints/` are the store of ready-made automations the ViON
interface offers under Automations. They are generated from the templates in `scripts/automations.ts`, where every
template carries its texts in all languages of the interface:

```sh
npm run automations            # writes the catalog and one blueprint per template and language
npm run automations -- --check # what CI runs: the files are what the script writes
```

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
| [Xiaomi](camera-ui-xiaomi)             | `@vionvision/camera-ui-xiaomi`       |
| [Yandex Smart Home](camera-ui-yandex)  | `@vionvision/camera-ui-yandex`       |
| [YAMNet Audio](camera-ui-audio-yamnet) | `@vionvision/camera-ui-audio-yamnet` |

---

_Part of the ViON ecosystem - [vionvision.tech](https://vionvision.tech)._
