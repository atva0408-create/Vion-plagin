# Types

Shared utility types: the `Logger` interface every plugin and camera exposes, and pointer-helper functions (`Bool`, `Int`, `Float64`) used by JSON schemas with optional numeric / boolean fields.

!!! note
    The reference below is auto-generated from Go doc comments via [`gomarkdoc`](https://github.com/princjef/gomarkdoc). Re-run `scripts/gen-api-docs.sh` to refresh it.

## Constants

<a name="BatteryCapabilityLowBattery"></a>BatteryCapability defines optional capabilities for battery info sensors.

	const (
	    BatteryCapabilityLowBattery = "lowBattery"
	    BatteryCapabilityCharging   = "charging"
	)

<a name="LightCapabilityBrightness"></a>LightCapability defines optional capabilities for light controls.

	const (
	    LightCapabilityBrightness = "brightness"
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

	var DetectionLabels = []string{
	    "motion", "person", "vehicle", "animal",
	    "package", "audio",
	}

<a name="ErrNoValue"></a>ErrNoValue is returned by FirstValueFrom when the source completes without emitting.

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

<a name="Bool"></a>

## func Bool

	func Bool(v bool) *bool

Bool returns a pointer to the given bool value. Use this for optional pointer fields in JsonSchema \(e.g., Store: sdk.Bool\(true\)\).

<a name="BuildSnapshotUrl"></a>

## func Float64

	func Float64(v float64) *float64

Float64 returns a pointer to the given float64 value. Use this for optional pointer fields in JsonSchema \(e.g., Minimum: sdk.Float64\(0.5\)\).

<a name="GetContractValidationErrors"></a>

## func Int

	func Int(v int) *int

Int returns a pointer to the given int value. Use this for optional pointer fields in JsonSchema \(e.g., MinLength: sdk.Int\(5\)\).

<a name="IsHub"></a>

## type Logger

Logger emits structured JSON log lines on stdout for the parent \(host\) process to parse, classify, and forward to the configured log sinks.

Each entry is wrapped in a childLogMessage envelope and contains the severity level, message text, optional prefix/suffix, and the target \(plugin/camera/sensor\) the entry belongs to.

Severity levels mirror the LoggerService interface in the other SDKs:

- log: general informational message \(default level\).
- warn: potential problem that does not stop execution.
- error: a failure or unexpected condition.
- success: confirmation of a completed operation.
- debug: diagnostic detail; only emitted when DebugEnabled is true.
- trace: very fine\-grained diagnostic detail; only emitted when TraceEnabled is true.
- attention: highlighted message that should stand out in the log stream.

	type Logger struct {
	    // contains filtered or unexported fields
	}

<a name="Logger.Attention"></a>
### func \(\*Logger\) Attention

	func (l *Logger) Attention(args ...any)

Attention writes an attention\-level \(highlighted message that should stand out in the log stream\) entry.

<a name="Logger.CreateLogger"></a>
### func \(\*Logger\) CreateLogger

	func (l *Logger) CreateLogger(opts *loggerOptions) *Logger

CreateLogger derives a child logger that inherits the parent's prefix, pluginID and debug/trace toggles, but uses a fresh suffix and target identification \(typically a camera or sensor scope\).

<a name="Logger.Debug"></a>
### func \(\*Logger\) Debug

	func (l *Logger) Debug(args ...any)

Debug writes a debug\-level \(diagnostic detail\) entry. Only emitted when DebugEnabled is true on the logger.

<a name="Logger.Error"></a>
### func \(\*Logger\) Error

	func (l *Logger) Error(args ...any)

Error writes an error\-level \(failure or unexpected condition\) entry.

<a name="Logger.Log"></a>
### func \(\*Logger\) Log

	func (l *Logger) Log(args ...any)

Log writes an info\-level \(general informational\) entry.

<a name="Logger.Success"></a>
### func \(\*Logger\) Success

	func (l *Logger) Success(args ...any)

Success writes a success\-level \(confirmation of a completed operation\) entry.

<a name="Logger.Trace"></a>
### func \(\*Logger\) Trace

	func (l *Logger) Trace(args ...any)

Trace writes a trace\-level \(very fine\-grained diagnostic detail\) entry. Only emitted when TraceEnabled is true on the logger.

<a name="Logger.Warn"></a>
### func \(\*Logger\) Warn

	func (l *Logger) Warn(args ...any)

Warn writes a warning\-level \(potential problem that does not stop execution\) entry.

<a name="ModelSpec"></a>
