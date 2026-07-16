# Plugin Guide

A camera.ui plugin is a Go module the host loads at runtime to extend cameras with new capabilities — a detection model, a vendor camera integration, a notifier, a smart-home bridge. This guide is the single reference for shipping one. You should be comfortable with modern Go (1.24+) and have the SDK installed (`go get github.com/cameraui/sdk/go`).

## 1. Plugin anatomy

A Go plugin is a single executable. The `main()` function calls `cameraui.Run` (the package alias is up to you — the package's actual name is `sdk`, so a typical import is `cameraui "github.com/cameraui/sdk/go"`). `Run` performs the handshake with the host, opens per-plugin storage, instantiates your plugin via a constructor, and blocks until the host stops it.

The minimal runnable plugin:

```go
// main.go
package main

import (
    cameraui "github.com/cameraui/sdk/go"
)

type MyPlugin struct {
    cameraui.BasePlugin
}

// NewPlugin is the constructor handed to Run; it receives the three
// host-injected dependencies in order: logger, api, storage.
func NewPlugin(logger *cameraui.Logger, api *cameraui.PluginAPI, storage *cameraui.DeviceStorage) cameraui.Plugin {
    return &MyPlugin{BasePlugin: cameraui.NewBasePlugin(logger, api, storage)}
}

func (p *MyPlugin) ConfigureCameras(cameras []*cameraui.CameraDevice) error { return nil }
func (p *MyPlugin) OnCameraAdded(camera *cameraui.CameraDevice) error      { return nil }
func (p *MyPlugin) OnCameraReleased(cameraID string) error                  { return nil }

func main() {
    cameraui.Run(NewPlugin)
}
```

The contract — the static manifest the host reads before starting the plugin — lives **outside** the binary. For TypeScript/Python plugins it's a separate file; for Go plugins it's expressed in `cameraui.config.ts` next to your code (the same packaging tool your camera.ui plugin scaffold uses) which the host parses at install time. The `PluginContract` struct in this SDK is what the host hands back to you on the wire.

The minimum your plugin struct must implement is the `cameraui.Plugin` interface:

```go
type Plugin interface {
    ConfigureCameras(cameras []*CameraDevice) error
    OnCameraAdded(camera *CameraDevice) error
    OnCameraReleased(cameraID string) error
}
```

Embed `cameraui.BasePlugin` to inherit the three host-injected fields (`Logger`, `API`, `Storage`) without retyping them.

## 2. The contract

`PluginContract` is the static manifest the host reads before starting the plugin. Its fields:

- **`Name`** — stable identifier; doubles as log prefix and storage namespace.
- **`Role`** — what the plugin does at the highest level (see table below).
- **`Provides`** — sensor types the plugin attaches to cameras (e.g. `[]SensorType{cameraui.SensorTypeMotion}`).
- **`Consumes`** — sensor types the plugin reads from other plugins.
- **`Interfaces`** — capability flags (`DiscoveryProvider`, `Notifier`, detection types, …).
- **`Dependencies`** *(optional)* — extra Go modules the host should resolve into the plugin's runtime.

| Role | Use when |
| --- | --- |
| `PluginRoleSensorProvider` | You add detection or smart-home sensors to existing cameras (motion plugin, classifier, contact sensor). |
| `PluginRoleCameraController` | You bring your own cameras and own their streams (RTSP, ONVIF, vendor SDK), but produce no sensors. |
| `PluginRoleCameraAndSensorProvider` | You bring your own cameras AND want to attach sensors to them. Most vendor integrations land here. |
| `PluginRoleHub` | Cloud-service integration that owns its cameras end-to-end via a vendor account, OR a bridge plugin that consumes other plugins' sensors and forwards them to an external system (HomeKit, MQTT, automations) or implements a `Notifier`. |

Examples:

```go
import cameraui "github.com/cameraui/sdk/go"

// Detection plugin attaching motion sensors.
contractMotion := cameraui.PluginContract{
    Name:       "My Motion",
    Role:       cameraui.PluginRoleSensorProvider,
    Provides:   []cameraui.SensorType{cameraui.SensorTypeMotion},
    Consumes:   []cameraui.SensorType{},
    Interfaces: []cameraui.PluginInterface{cameraui.PluginInterfaceMotionDetection},
}

// ONVIF-style integration with discovery.
contractOnvif := cameraui.PluginContract{
    Name:       "ACME Cameras",
    Role:       cameraui.PluginRoleCameraAndSensorProvider,
    Provides:   []cameraui.SensorType{cameraui.SensorTypeMotion},
    Interfaces: []cameraui.PluginInterface{cameraui.PluginInterfaceDiscoveryProvider},
}

// HomeKit bridge consuming sensor state from other plugins.
contractHomeKit := cameraui.PluginContract{
    Name:     "HomeKit Bridge",
    Role:     cameraui.PluginRoleHub,
    Provides: []cameraui.SensorType{},
    Consumes: []cameraui.SensorType{cameraui.SensorTypeMotion, cameraui.SensorTypeDoorbell},
}
```

These struct literals are illustrative — the contract is delivered to your plugin from the host via the SDK runtime, so you don't construct one yourself in `main`. Use `cameraui.GetContractValidationErrors` and `cameraui.ValidateContractConsistency` if you need to validate one programmatically.

## 3. The plugin struct

Your plugin is a struct with three host-injected dependencies. The cleanest pattern is to embed `cameraui.BasePlugin` and add per-camera state next to it:

```go
package main

import (
    "sync"

    cameraui "github.com/cameraui/sdk/go"
)

type cameraState struct {
    pollTicker *time.Ticker
    // ... whatever else you keep per camera
}

type MyPlugin struct {
    cameraui.BasePlugin

    mu      sync.Mutex
    cameras map[string]*cameraState
}

func NewPlugin(logger *cameraui.Logger, api *cameraui.PluginAPI, storage *cameraui.DeviceStorage) cameraui.Plugin {
    p := &MyPlugin{
        BasePlugin: cameraui.NewBasePlugin(logger, api, storage),
        cameras:    make(map[string]*cameraState),
    }
    api.On(string(cameraui.APIEventShutdown), func(_ ...any) { p.shutdown() })
    return p
}

func (p *MyPlugin) ConfigureCameras(cameras []*cameraui.CameraDevice) error {
    for _, cam := range cameras {
        if err := p.attach(cam); err != nil {
            return err
        }
    }
    return nil
}

func (p *MyPlugin) OnCameraAdded(cam *cameraui.CameraDevice) error {
    return p.attach(cam)
}

func (p *MyPlugin) OnCameraReleased(cameraID string) error {
    p.mu.Lock()
    state, ok := p.cameras[cameraID]
    delete(p.cameras, cameraID)
    p.mu.Unlock()
    if ok && state.pollTicker != nil {
        state.pollTicker.Stop()
    }
    return nil
}

func (p *MyPlugin) attach(cam *cameraui.CameraDevice) error { /* ... */ return nil }
func (p *MyPlugin) shutdown()                                { /* drop timers, close sockets */ }
```

Things to internalize:

- `ConfigureCameras` runs once at startup with the cameras already assigned to the plugin. Returning an error aborts plugin startup.
- `OnCameraAdded` runs whenever the user assigns a new camera at runtime. Set up the same per-camera state as `ConfigureCameras`.
- `OnCameraReleased` runs when a camera is removed or reassigned. Drop timers, close vendor sessions.
- A `map[string]*cameraState` keyed by `cam.ID()` is the conventional pattern for per-camera state — cheap to look up, trivial to clean up. Guard it with a `sync.Mutex`; lifecycle hooks may run concurrently with detection callbacks.
- `cameraui.APIEventShutdown` fires when the host tears the plugin down (reload, server stop). Listeners must release everything synchronously enough for the host to stop the process. There is also `cameraui.APIEventFinishLaunching`, fired once after `ConfigureCameras` returns — useful for kicking off background work that should wait until the camera set is stable.

## 4. Adding sensors to cameras

A sensor is the unit of state the host (and other plugins) sees on a camera. Detection sensors push results from analyzing video; control sensors expose user-toggleable hardware (lights, sirens, locks); event sensors fire one-shot triggers (doorbell).

For detection, construct the matching `*DetectorSensor`, wire up an implementation of the matching `*Detector` interface (the host calls it once per frame at the configured rate), then attach the sensor to the camera with `AddSensor`. The same struct can implement both — it's the typical pattern:

```go
type myMotionDetector struct {
    sensor *cameraui.MotionDetectorSensor
}

func (d *myMotionDetector) DetectMotion(frame cameraui.VideoFrameData) (*cameraui.MotionResult, error) {
    // analyze frame.Data here, return detections.
    return &cameraui.MotionResult{Detected: false}, nil
}

func (p *MyPlugin) attach(cam *cameraui.CameraDevice) error {
    sensor := cameraui.NewMotionDetectorSensor("My Motion")
    if err := cam.AddSensor(sensor); err != nil {
        return err
    }
    // The detector is invoked by the host's frame pipeline. To wire it up,
    // implement the matching detection interface on the plugin (see Section 6.3)
    // and let the SDK proxy frames to it.
    _ = sensor
    return nil
}
```

The other detector base types follow the same shape — but note the input cardinality:

- `cameraui.NewObjectDetectorSensor(name)` pairs with `ObjectDetector.DetectObjects(frame VideoFrameData)` — one frame at a time.
- `cameraui.NewMotionDetectorSensor(name)` pairs with `MotionDetector.DetectMotion(frame VideoFrameData)` — one frame at a time.
- `cameraui.NewAudioDetectorSensor(name)` pairs with `AudioDetector.DetectAudio(audio AudioFrameData)` — one audio frame at a time.
- `cameraui.NewFaceDetectorSensor(name)` pairs with `FaceDetector.DetectFaces(frames []VideoFrameData)` — a batch of person regions.
- `cameraui.NewLicensePlateDetectorSensor(name)` pairs with `LicensePlateDetector.DetectLicensePlates(frames []VideoFrameData)` — a batch of vehicle regions.
- `cameraui.NewClassifierDetectorSensor(name)` pairs with `ClassifierDetector.DetectClassifications(frames []VideoFrameData)` — a batch of trigger regions.
- `cameraui.NewClipDetectorSensor(name)` pairs with `ClipDetector.DetectEmbeddings(frames []VideoFrameData)` — a batch of trigger regions.

The frame-based detectors with a batch shape (face, license plate, classifier, clip) also expose a `ModelSpec()` method on the detector interface — return the input dimensions and (for classifier) the trigger labels. Every frame in a batch is scaled to that input. Normally it is a region the upstream object detector cropped around a matching detection, but when the pipeline has no decoded loop frame, the whole scene is scaled instead and you get a single full-frame entry.

Smart-home sensors expose semantic methods instead. You construct one, call `cam.AddSensor`, and then call those methods when your hardware reports a change:

```go
contact := cameraui.NewContactSensor("Front Door")
_ = cam.AddSensor(contact)
contact.SetDetected(true)            // door opens

bell := cameraui.NewDoorbellTrigger("Doorbell")
_ = cam.AddSensor(bell)
bell.Trigger()                        // ring (auto-resets after 2 s)

light := cameraui.NewLightControl("Porch Light")
_ = cam.AddSensor(light)
light.SetOn()                         // turn on
light.SetBrightness(80)               // 0-100
```

The host removes sensors automatically when a camera is released. Your `OnCameraReleased` hook just needs to drop your reference to the sensor.

## 5. Storage and configuration schema

User-facing settings live in storage. Storage is split into two scopes — plugin-level and sensor-level — each driven by a JSON schema your code returns. The host renders the schemas as form fields and persists the values; you read them via `storage.GetValue("X")` (or `storage.GetValue("X", default)`).

**Plugin-level** schemas appear on the plugin's settings page. Implement `cameraui.StorageSchemaProvider` on your plugin struct:

```go
import cameraui "github.com/cameraui/sdk/go"

func (p *MyPlugin) StorageSchema() []cameraui.JsonSchema {
    storeTrue := true
    return []cameraui.JsonSchema{
        {
            Type:         cameraui.JsonSchemaTypeNumber,
            Key:          "pollIntervalSec",
            Title:        "Poll interval (seconds)",
            Description:  "How often background work runs",
            DefaultValue: 30,
            Minimum:      cameraui.Float64(5),
            Maximum:      cameraui.Float64(300),
            Step:         cameraui.Float64(5),
            Store:        &storeTrue,
            Required:     true,
            OnSet: func(oldValue, newValue any) any {
                p.Logger.Log("Poll interval changed:", oldValue, "->", newValue)
                p.reschedule()
                return nil
            },
        },
    }
}

func (p *MyPlugin) reschedule() { /* re-warm timers */ }
```

`Float64` is a tiny helper that boxes a literal into a `*float64` — schema fields use pointers for "unset". The same trick exists for `Int` and `Bool`.

**Sensor-level** schemas appear on the camera detail page next to that one sensor. Sensor types in this SDK don't have a built-in schema-provider hook — instead, register the schema after `AddSensor` returns, by calling `DefineSchemas` on the per-sensor `DeviceStorage` exposed via `BaseSensor.Storage()`:

```go
sensor := cameraui.NewMotionDetectorSensor("Configurable Motion")
if err := cam.AddSensor(sensor); err != nil {
    return err
}

storeTrue := true
sensor.Storage().DefineSchemas([]cameraui.JsonSchema{
    {
        Type:         cameraui.JsonSchemaTypeNumber,
        Key:          "sensitivity",
        Title:        "Sensitivity",
        Description:  "Higher = trigger on smaller motion",
        DefaultValue: 50,
        Minimum:      cameraui.Float64(0),
        Maximum:      cameraui.Float64(100),
        Step:         cameraui.Float64(1),
        Store:        &storeTrue,
        OnSet:        func(_, _ any) any { p.warmCaches(cam.ID()); return nil },
    },
    {
        Type:         cameraui.JsonSchemaTypeString,
        Key:          "mode",
        Title:        "Mode",
        Description:  "Trade-off between speed and accuracy",
        DefaultValue: "fast",
        Enum:         []string{"fast", "accurate"},
        Store:        &storeTrue,
    },
    {
        Type:        cameraui.JsonSchemaTypeButton,
        Key:         "reset",
        Title:       "Reset to defaults",
        Description: "Restore sensitivity / mode",
        Color:       cameraui.ButtonColorDanger,
        OnSet: func(_, _ any) any {
            sensor.Storage().SetValue("sensitivity", 50)
            sensor.Storage().SetValue("mode", "fast")
            return nil
        },
    },
})
```

Field types:

- `cameraui.JsonSchemaTypeNumber` — slider/input with optional `Minimum`, `Maximum`, `Step`.
- `cameraui.JsonSchemaTypeString` — text input; add `Enum: []string{...}` for a dropdown, `Format: cameraui.StringFormatPassword` to mask, `Format: cameraui.StringFormatImage` / `StringFormatQRCode` for media display.
- `cameraui.JsonSchemaTypeBoolean` — toggle.
- `cameraui.JsonSchemaTypeButton` — fires `OnSet()` on click; stores no value. Useful for actions like "Test connection" or "Reset".
- `cameraui.JsonSchemaTypeSubmit` — fires `OnClick(value any) *FormSubmitResponse` and lets you echo a toast back to the UI.

`OnSet(oldValue, newValue)` runs after the host has persisted the new value. Use it to re-warm caches, restart sessions, or anything else that depends on the changed setting. The return value is unused by the SDK — feel free to return `nil`. The host doesn't block UI on it; keep work scoped to the plugin.

For the full schema reference (conditional visibility via `Condition`, submit handlers with toast feedback, array fields, computed `OnGet` values), see `sdk/go/storage_schema.go`.

## 6. Optional interfaces

`Plugin` covers the lifecycle. Specific capabilities are unlocked by implementing one of the optional interfaces and listing it in the contract's `Interfaces` field. The rest of this section shows each one with a working snippet.

### 6.1 DiscoveryProvider

Let users scan and adopt cameras. Three methods: `OnDiscoverCameras` returns adoption candidates, `OnGetCameraSettings` returns the schema for the adoption form, `OnAdoptCamera` resolves the form values into a camera config map for the host to persist. Available only for camera-controlling roles (`PluginRoleCameraController`, `PluginRoleCameraAndSensorProvider`).

```go
import (
    "fmt"
    "net/url"
    "sync"

    cameraui "github.com/cameraui/sdk/go"
)

type fakeDevice struct {
    id, name, manufacturer, model, host string
}

var fakeDevices = []fakeDevice{
    {"fake-001", "Front Door", "ACME", "X1", "192.0.2.10"},
}

type CameraProvider struct {
    cameraui.BasePlugin

    mu      sync.Mutex
    cameras map[string]*cameraui.CameraDevice
}

// Compile-time guarantee that we implement DiscoveryProvider.
var _ cameraui.DiscoveryProvider = (*CameraProvider)(nil)

func NewCameraProvider(logger *cameraui.Logger, api *cameraui.PluginAPI, storage *cameraui.DeviceStorage) cameraui.Plugin {
    p := &CameraProvider{
        BasePlugin: cameraui.NewBasePlugin(logger, api, storage),
        cameras:    make(map[string]*cameraui.CameraDevice),
    }
    api.On(string(cameraui.APIEventShutdown), func(_ ...any) { p.cameras = nil })
    return p
}

func (p *CameraProvider) ConfigureCameras(cams []*cameraui.CameraDevice) error {
    p.mu.Lock()
    defer p.mu.Unlock()
    for _, c := range cams {
        p.cameras[c.ID()] = c
    }
    return nil
}

func (p *CameraProvider) OnCameraAdded(cam *cameraui.CameraDevice) error {
    p.mu.Lock()
    p.cameras[cam.ID()] = cam
    p.mu.Unlock()
    return nil
}

func (p *CameraProvider) OnCameraReleased(cameraID string) error {
    p.mu.Lock()
    delete(p.cameras, cameraID)
    p.mu.Unlock()
    return nil
}

func (p *CameraProvider) OnDiscoverCameras() ([]cameraui.DiscoveredCamera, error) {
    p.mu.Lock()
    adopted := make(map[string]struct{}, len(p.cameras))
    for _, c := range p.cameras {
        adopted[c.NativeID()] = struct{}{}
    }
    p.mu.Unlock()

    out := make([]cameraui.DiscoveredCamera, 0, len(fakeDevices))
    for _, d := range fakeDevices {
        if _, ok := adopted[d.id]; ok {
            continue
        }
        out = append(out, cameraui.DiscoveredCamera{
            ID:           d.id,
            Name:         d.name,
            Manufacturer: d.manufacturer,
            Model:        d.model,
        })
    }
    return out, nil
}

func (p *CameraProvider) OnGetCameraSettings(_ cameraui.DiscoveredCamera) ([]cameraui.JsonSchema, error) {
    return []cameraui.JsonSchema{
        {Type: cameraui.JsonSchemaTypeString, Key: "username", Title: "Username", Required: true},
        {Type: cameraui.JsonSchemaTypeString, Key: "password", Title: "Password", Format: cameraui.StringFormatPassword, Required: true},
    }, nil
}

func (p *CameraProvider) OnAdoptCamera(camera cameraui.DiscoveredCamera, settings map[string]any) (map[string]any, error) {
    var device *fakeDevice
    for i := range fakeDevices {
        if fakeDevices[i].id == camera.ID {
            device = &fakeDevices[i]
            break
        }
    }
    if device == nil {
        return nil, fmt.Errorf("unknown device: %s", camera.ID)
    }
    user, _ := settings["username"].(string)
    pass, _ := settings["password"].(string)
    rtsp := fmt.Sprintf("rtsp://%s:%s@%s/stream0", url.QueryEscape(user), url.QueryEscape(pass), device.host)
    return map[string]any{
        "name":     device.name,
        "nativeId": device.id,
        "info": map[string]any{
            "manufacturer": device.manufacturer,
            "model":        device.model,
        },
        "sources": []map[string]any{{
            "name":           "main",
            "role":           "high-resolution",
            "urls":           []string{rtsp},
            "useForSnapshot": true,
            "hotMode":        true,
            "preload":        true,
        }},
    }, nil
}
```

For asynchronous discovery (cloud OAuth callbacks, mDNS bursts), you can also push candidates directly into the UI without waiting for the next poll: `p.API.DeviceManager.PushDiscoveredCameras([]cameraui.DiscoveredCamera{...})`.

### 6.2 NotifierInterface

Register as a notification target so the host's `NotificationManager` can dispatch through you. The plugin owns its device list — the manager queries through these methods rather than maintaining a shared registry.

```go
import (
    "github.com/google/uuid"
    cameraui "github.com/cameraui/sdk/go"
)

type MyNotifier struct {
    cameraui.BasePlugin

    mu      sync.Mutex
    devices []*cameraui.NotifierDevice
}

var _ cameraui.NotifierInterface = (*MyNotifier)(nil)

func (n *MyNotifier) ConfigureCameras(_ []*cameraui.CameraDevice) error { return nil }
func (n *MyNotifier) OnCameraAdded(_ *cameraui.CameraDevice) error      { return nil }
func (n *MyNotifier) OnCameraReleased(_ string) error                    { return nil }

func (n *MyNotifier) GetDevices(ownerUserID string) ([]cameraui.NotifierDevice, error) {
    n.mu.Lock()
    defer n.mu.Unlock()
    out := make([]cameraui.NotifierDevice, 0, len(n.devices))
    for _, d := range n.devices {
        if d.OwnerUserID == ownerUserID {
            out = append(out, *d)
        }
    }
    return out, nil
}

func (n *MyNotifier) GetDevice(deviceID string) (*cameraui.NotifierDevice, error) {
    n.mu.Lock()
    defer n.mu.Unlock()
    for _, d := range n.devices {
        if d.ID == deviceID {
            return d, nil
        }
    }
    return nil, nil
}

func (n *MyNotifier) SendNotification(deviceID string, msg *cameraui.Notification) error {
    n.mu.Lock()
    var d *cameraui.NotifierDevice
    for _, x := range n.devices {
        if x.ID == deviceID {
            d = x
            break
        }
    }
    n.mu.Unlock()
    if d == nil || !d.Active {
        return nil
    }
    n.Logger.Log("[" + d.Name + "] " + msg.Title + ": " + msg.Body)
    return nil
}

func (n *MyNotifier) RegisterDevice(ownerUserID string, input map[string]any) (*cameraui.NotifierDevice, error) {
    typ, _ := input["type"].(string)
    name, _ := input["name"].(string)
    if name == "" {
        name = "Unnamed device"
    }
    if typ == "" {
        typ = "mobile"
    }
    d := &cameraui.NotifierDevice{
        ID:          uuid.NewString(),
        OwnerUserID: ownerUserID,
        Type:        typ,
        Name:        name,
        Active:      true,
    }
    n.mu.Lock()
    n.devices = append(n.devices, d)
    n.mu.Unlock()
    return d, nil
}

func (n *MyNotifier) RevokeDevice(deviceID string) error {
    n.mu.Lock()
    defer n.mu.Unlock()
    out := n.devices[:0]
    for _, d := range n.devices {
        if d.ID != deviceID {
            out = append(out, d)
        }
    }
    n.devices = out
    return nil
}

func (n *MyNotifier) UpdateDevice(deviceID string, patch map[string]any) (*cameraui.NotifierDevice, error) {
    n.mu.Lock()
    defer n.mu.Unlock()
    for _, d := range n.devices {
        if d.ID != deviceID {
            continue
        }
        if name, ok := patch["name"].(string); ok {
            d.Name = name
        }
        if active, ok := patch["active"].(bool); ok {
            d.Active = active
        }
        return d, nil
    }
    return nil, nil
}
```

`Notification.Tag` is a collapse key (e.g. `"motion:cam-1"`). The host uses it to replace an older entry with the same tag in the in-app notification list. Delivery is not throttled: every publish reaches your notifier, so map the tag to a platform collapse-id if you want the same behavior on the device. `Notification.Severity` is `cameraui.SeverityInfo | SeverityWarn | SeverityError | SeverityCritical`; map `SeverityCritical` to whatever DND-bypass mechanism your platform offers.

### 6.3 Detection interfaces

The seven detection capabilities follow a single pattern. Each interface has:

- A required `Test*` method invoked by the UI when the user uploads a clip/image and clicks "Test" — it accepts raw media bytes plus metadata and returns the same result shape the per-frame detector would.
- A `Detect*` method invoked by automations and benchmarks — it accepts an already-decoded frame (or batch).
- A `*Settings` method that returns a schema for the detection configuration UI. Return `nil` for no schema.

All seven (`MotionDetectionInterface`, `ObjectDetectionInterface`, `AudioDetectionInterface`, `FaceDetectionInterface`, `LicensePlateDetectionInterface`, `ClassifierDetectionInterface`, `ClipDetectionInterface`) share that shape. `ClipDetectionInterface` additionally requires `GetTextEmbedding(text string) (*ClipTextEmbeddingResult, error)` for semantic search.

Motion as a worked example:

```go
type MotionPlugin struct {
    cameraui.BasePlugin
}

var _ cameraui.MotionDetectionInterface = (*MotionPlugin)(nil)

func (p *MotionPlugin) TestMotion(videoData []byte, _ map[string]any) (*cameraui.MotionDetectionResponse, error) {
    detections := p.runOnEncodedClip(videoData)
    return &cameraui.MotionDetectionResponse{
        Detected:   len(detections) > 0,
        Detections: detections,
    }, nil
}

func (p *MotionPlugin) DetectMotion(frames []cameraui.VideoFrameData, _ map[string]any) (*cameraui.MotionDetectionResponse, error) {
    detections := p.runOnFrames(frames)
    return &cameraui.MotionDetectionResponse{
        Detected:   len(detections) > 0,
        Detections: detections,
    }, nil
}

func (p *MotionPlugin) MotionSettings() ([]cameraui.JsonSchema, error) {
    storeTrue := true
    return []cameraui.JsonSchema{
        {
            Type: cameraui.JsonSchemaTypeNumber, Key: "minArea", Title: "Min area (%)",
            DefaultValue: 1,
            Minimum:      cameraui.Float64(0),
            Maximum:      cameraui.Float64(100),
            Step:         cameraui.Float64(1),
            Store:        &storeTrue,
        },
    }, nil
}

func (p *MotionPlugin) runOnEncodedClip([]byte) []cameraui.Detection                    { return nil }
func (p *MotionPlugin) runOnFrames([]cameraui.VideoFrameData) []cameraui.Detection      { return nil }
```

The image-based detection interfaces (`ObjectDetectionInterface`, `FaceDetectionInterface`, `LicensePlateDetectionInterface`, `ClassifierDetectionInterface`, `ClipDetectionInterface`) take an extra `metadata cameraui.ImageMetadata` argument with `Width` / `Height` on the `Test*` method. The audio interface takes `metadata cameraui.AudioMetadata` with the `MimeType`. Otherwise the wiring is identical to the motion example above — add the matching `cameraui.PluginInterfaceX` flag to the contract and implement the `Test*` / `Detect*` / `*Settings` trio.

A detection plugin almost always implements both halves: the appropriate `*DetectorSensor` (Section 4) for the live pipeline, AND the matching `*DetectionInterface` here for UI test dialogs and ad-hoc benchmarks.

## 7. Logging

`p.Logger` is a `*cameraui.Logger`. The methods are `Log`, `Warn`, `Error`, `Success`, `Debug`, `Trace`, and `Attention` — each accepts variadic `any` arguments joined with spaces by the host. `Debug` and `Trace` are gated by the host log level.

```go
p.Logger.Log("Plugin started")
p.Logger.Success("Connected to vendor cloud as", user)
p.Logger.Warn("Falling back to substream")
p.Logger.Error("Adopt failed:", err)
```

Every `*CameraDevice` exposes `cam.Logger()` — same interface, but the output is prefixed with the camera name. Prefer it over `p.Logger` whenever the message is about a specific camera:

```go
func (p *MyPlugin) OnCameraAdded(cam *cameraui.CameraDevice) error {
    cam.Logger().Log("attached")
    return nil
}
```

## 8. Inter-plugin communication

The cleanest way for one plugin to react to another's sensors is `cam.OnSensorProperty(sensorType, property, callback)`. It auto-subscribes when a sensor of the requested type appears (now or later), unsubscribes when it goes away, and tears down everything when you dispose the returned handle. The callback receives `(value any, timestampMs int64, sensor cameraui.Sensor)`. This is the pattern Hub plugins (HomeKit, automations) use.

A complete Hub consumer that listens to motion AND doorbell on every assigned camera:

```go
type HubConsumer struct {
    cameraui.BasePlugin

    mu   sync.Mutex
    subs map[string][]*cameraui.Disposable
}

func NewHubConsumer(logger *cameraui.Logger, api *cameraui.PluginAPI, storage *cameraui.DeviceStorage) cameraui.Plugin {
    p := &HubConsumer{
        BasePlugin: cameraui.NewBasePlugin(logger, api, storage),
        subs:       make(map[string][]*cameraui.Disposable),
    }
    api.On(string(cameraui.APIEventShutdown), func(_ ...any) { p.disposeAll() })
    return p
}

func (p *HubConsumer) ConfigureCameras(cams []*cameraui.CameraDevice) error {
    for _, c := range cams {
        p.bind(c)
    }
    return nil
}

func (p *HubConsumer) OnCameraAdded(cam *cameraui.CameraDevice) error {
    p.bind(cam)
    return nil
}

func (p *HubConsumer) OnCameraReleased(cameraID string) error {
    p.mu.Lock()
    subs := p.subs[cameraID]
    delete(p.subs, cameraID)
    p.mu.Unlock()
    for _, s := range subs {
        s.Dispose()
    }
    return nil
}

func (p *HubConsumer) bind(cam *cameraui.CameraDevice) {
    onMotion := cam.OnSensorProperty(cameraui.SensorTypeMotion, "detected",
        func(value any, _ int64, _ cameraui.Sensor) {
            if v, ok := value.(bool); ok && v {
                cam.Logger().Log("motion started")
            }
        })

    onDoorbell := cam.OnSensorProperty(cameraui.SensorTypeDoorbell, "ring",
        func(value any, _ int64, _ cameraui.Sensor) {
            if v, ok := value.(bool); ok && v {
                cam.Logger().Log("doorbell rang")
            }
        })

    p.mu.Lock()
    p.subs[cam.ID()] = append(p.subs[cam.ID()], onMotion, onDoorbell)
    p.mu.Unlock()
}

func (p *HubConsumer) disposeAll() {
    p.mu.Lock()
    defer p.mu.Unlock()
    for _, subs := range p.subs {
        for _, s := range subs {
            s.Dispose()
        }
    }
    p.subs = nil
}
```

Two things to notice:

- The bridge keeps one `[]*cameraui.Disposable` per camera and disposes it in `OnCameraReleased`. This is critical — `OnSensorProperty` keeps an internal subscription alive until you call `Dispose()`.
- The bind happens in both `ConfigureCameras` AND `OnCameraAdded` for cameras that show up after startup. Same shape as for sensor-providing plugins.

For direct plugin-to-plugin RPC (e.g. asking a face plugin to compute embeddings on demand), use `p.API.CoreManager.ConnectToPlugin(name)`. It returns a proxy you can `Invoke(ctx, "MethodName", args...)` against:

```go
ctx := context.Background()
face, err := p.API.CoreManager.ConnectToPlugin("Face Plugin")
if err == nil && face != nil {
    result, err := face.Invoke(ctx, "TestFaceDetection", jpegBytes,
        cameraui.ImageMetadata{Width: 640, Height: 480}, map[string]any{})
    _ = result
    _ = err
}
```

Use `p.API.CoreManager.GetPluginsByInterface(cameraui.PluginInterfaceFaceDetection)` to discover candidate plugins by capability rather than by name.

## 9. Common pitfalls

- **Always release per-camera state in `OnCameraReleased`.** Tickers, vendor sessions, RTP sockets, `*Disposable`s from `OnSensorProperty` — drop them all. Leaking them keeps the camera object alive forever and prevents reassignment from working.
- **Don't block in `ConfigureCameras`.** It runs on the host's startup path; a slow vendor handshake delays every other plugin. Do the network work in `cameraui.APIEventFinishLaunching` instead.
- **Don't construct sensors in `NewPlugin`.** The host hasn't finished wiring up `api` / `storage` until your constructor returns and `ConfigureCameras` is called. Construct sensors inside the lifecycle hooks where you also receive the matching `*CameraDevice`.
- **Don't log frame data.** Detection paths run dozens of times per second per camera. Use `Logger.Debug` / `Logger.Trace` (host-gated) for anything per-frame, and prefer aggregated counters over per-event logs.
- **Always guard shared state.** Lifecycle hooks, sensor callbacks, and detection methods can all run concurrently. A `sync.Mutex` around your `cameras` map (and any per-camera state) is non-negotiable.
- **Return early on goroutine panics.** The SDK runtime supervises the main goroutine; panics in your own goroutines crash the whole plugin process. Wrap them in `defer func() { if r := recover(); r != nil { p.Logger.Error("panic:", r) } }()` if you can't guarantee the operation is panic-free.

## 10. Next steps

For complete production plugins to read alongside this guide, see [`plugins/`](https://github.com/seydx/camera.ui/tree/main/plugins) in the camera.ui repo. They cover everything documented above — discovery, notifier, detection, hub bridges — wired into a real UI.

For the full module-by-module surface, browse the [API Reference](api/plugin.md) — it's auto-generated from the SDK source via [`gomarkdoc`](https://github.com/princjef/gomarkdoc) and stays in sync with whatever version of `github.com/cameraui/sdk/go` you have in `go.mod`.
