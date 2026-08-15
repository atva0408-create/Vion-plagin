# Types

Shared utility types: the `Logger` interface every plugin and camera exposes, and pointer-helper functions (`Bool`, `Int`, `Float64`) used by JSON schemas with optional numeric / boolean fields.

!!! note
    The reference below is auto-generated from Go doc comments via [`gomarkdoc`](https://github.com/princjef/gomarkdoc). Re-run `scripts/gen-api-docs.sh` to refresh it.

## Constants

<a name="BatteryCapabilityLowBattery"></a>Optional capabilities of a battery info sensor.

	const (
	    BatteryCapabilityLowBattery = "lowBattery" // Sensor reports low-battery alerts
	    BatteryCapabilityCharging   = "charging"   // Sensor reports charging state
	)

<a name="LightCapabilityBrightness"></a>Optional capabilities of a light control.

	const (
	    LightCapabilityBrightness = "brightness" // Light supports brightness adjustment (0-100)
	)

<a name="ProtocolLevel"></a>ProtocolLevel is the compatibility level of the plugin surface: the plugin\-facing API and the plugin wire protocol. Bumped only on breaking changes, never for additive features. The CLI stamps the level a plugin was built against into its bundle \(\`cameraui.protocolLevel\` in the bundle package.json\); the server compares that stamp with its own level and refuses to start plugins outside its supported range.

	const ProtocolLevel = 2

<a name="SirenCapabilityVolume"></a>Optional capabilities of a siren control.

	const (
	    SirenCapabilityVolume = "volume" // Siren supports volume adjustment (0-100)
	)

## Variables

<a name="BaseAudioLabels"></a>BaseAudioLabels lists the built\-in audio label types recognized across the system.

	var BaseAudioLabels = []string{
	    "doorbell", "glass_break", "siren", "speaking",
	    "gunshot", "dog_bark", "baby_cry", "alarm",
	    "scream", "cat", "car_alarm", "smoke_alarm",
	}

<a name="DetectionAttributes"></a>DetectionAttributes lists the built\-in detection attribute types.

	var DetectionAttributes = []string{"face", "license_plate"}

<a name="DetectionLabels"></a>DetectionLabels lists the built\-in detection label types recognized across the system.

	var DetectionLabels = append(append([]string{"motion"}, ObjectDetectionLabels...), "audio")

<a name="ErrNoValue"></a>ErrNoValue is returned by FirstValueFrom when the source completes before it emits a value.

	var ErrNoValue = errors.New("observable completed without emitting a value")

<a name="KnownEventTypes"></a>KnownEventTypes is the set of standard event types \(detection labels \+ attributes \+ trigger types\). Used to identify "other" \(classifier\-produced\) types that fall outside this set.

	var KnownEventTypes = func() map[string]struct{} {
	    m := make(map[string]struct{})
	    for _, l := range DetectionLabels {
	        m[l] = struct{}{}
	    }
	    for _, a := range DetectionAttributes {
	        m[a] = struct{}{}
	    }
	    for _, t := range []string{
	        EventTriggerMotion, EventTriggerAudio, EventTriggerContact,
	        EventTriggerDoorbell, EventTriggerSwitch, EventTriggerLight,
	        EventTriggerSiren, EventTriggerSecuritySystem,
	    } {
	        m[t] = struct{}{}
	    }
	    return m
	}()

<a name="ObjectDetectionLabels"></a>ObjectDetectionLabels lists the object\-detection labels the detector groups its classes into.

	var ObjectDetectionLabels = []string{"person", "vehicle", "animal", "package"}

<a name="Bool"></a>

## func Bool

	func Bool(v bool) *bool

Bool returns a pointer to v, for the optional pointer fields of JsonSchema \(e.g. Store: sdk.Bool\(true\)\).

<a name="BuildSnapshotUrl"></a>

## func Float64

	func Float64(v float64) *float64

Float64 returns a pointer to v, for the optional pointer fields of JsonSchema \(e.g. Minimum: sdk.Float64\(0.5\)\).

<a name="GetContractValidationErrors"></a>

## func Int

	func Int(v int) *int

Int returns a pointer to v, for the optional pointer fields of JsonSchema \(e.g. MinLength: sdk.Int\(5\)\).

<a name="IsHub"></a>

## type Logger

Logger writes structured log entries to stdout, where the host picks them up and routes them to its own sinks. Debug and Trace are dropped unless the matching level is enabled for the plugin.

Accessed via the embedded BasePlugin.Logger from within a plugin.

	type Logger struct {
	    // contains filtered or unexported fields
	}

<a name="Logger.Attention"></a>
### func \(\*Logger\) Attention

	func (l *Logger) Attention(args ...any)

Attention writes a highlighted entry that stands out in the log stream.

<a name="Logger.CreateLogger"></a>
### func \(\*Logger\) CreateLogger

	func (l *Logger) CreateLogger(opts *loggerOptions) *Logger

CreateLogger derives a child logger for a specific target \(camera, sensor\). Prefix, plugin id and the debug/trace levels are inherited.

<a name="Logger.Debug"></a>
### func \(\*Logger\) Debug

	func (l *Logger) Debug(args ...any)

Debug writes a diagnostic entry, dropped unless debug logging is enabled.

<a name="Logger.Error"></a>
### func \(\*Logger\) Error

	func (l *Logger) Error(args ...any)

Error writes an entry for a failure or unexpected condition.

<a name="Logger.Log"></a>
### func \(\*Logger\) Log

	func (l *Logger) Log(args ...any)

Log writes an informational entry. Arguments are formatted and joined with spaces.

Example:

	p.Logger.Log("connected to", host)
	

<a name="Logger.Success"></a>
### func \(\*Logger\) Success

	func (l *Logger) Success(args ...any)

Success writes an entry confirming a completed operation.

<a name="Logger.Trace"></a>
### func \(\*Logger\) Trace

	func (l *Logger) Trace(args ...any)

Trace writes a fine\-grained diagnostic entry, dropped unless trace logging is enabled.

<a name="Logger.Warn"></a>
### func \(\*Logger\) Warn

	func (l *Logger) Warn(args ...any)

Warn writes an entry for a problem that does not stop execution.

<a name="ModelRuntime"></a>
