# API Reference

Module-by-module reference, auto-generated from the Go doc comments in `github.com/cameraui/sdk/go`.

| Module | What's in it |
| --- | --- |
| [Plugin API](plugin.md) | `BasePlugin`, the `PluginContract` manifest, optional interfaces (discovery, notifier, detection). |
| [Camera](camera.md) | `Camera`, `CameraDevice`, sources, frames, streaming, detection events, runtime device API. |
| [Sensors](sensor.md) | Detection sensors (motion, object, face, license-plate, audio, classifier, clip) and smart-home sensors (contact, doorbell, lock, garage, light, switch, ptz, security system, environmental). |
| [Storage & Schema](storage.md) | Schema-driven per-device config rendered as UI forms by the host. |
| [Manager](manager.md) | `CoreManager` / `DeviceManager` / `DownloadManager` for system-level services. |
| [Observable](observable.md) | Reactive primitives — `Observable`, `Subject`, `BehaviorSubject`, `ReplaySubject` — and `Disposable`. |
| [Types](types.md) | Shared types (`Logger`, `PluginAPI`, contract enums, helpers). |

If you're new to the SDK, start with the [Plugin Guide](../plugin-guide.md) instead — it walks through these modules in the order you'll actually use them.
