# Types

Shared utility types: the `Logger` interface every plugin and camera exposes, and pointer-helper functions (`Bool`, `Int`, `Float64`) used by JSON schemas with optional numeric / boolean fields.

!!! note
    The reference below is auto-generated from Go doc comments via [`gomarkdoc`](https://github.com/princjef/gomarkdoc). Re-run `scripts/gen-api-docs.sh` to refresh it.

## Constants

<a name="BatteryCapabilityLowBattery"></a>BatteryCapability defines optional capabilities for battery info sensors.

	const (
	    BatteryCapabilityLowBattery = "lowBattery" // Sensor reports low-battery alerts
	    BatteryCapabilityCharging   = "charging"   // Sensor reports charging state
	)

<a name="LightCapabilityBrightness"></a>LightCapability defines optional capabilities for light controls.

	const (
	    LightCapabilityBrightness = "brightness" // Light supports brightness adjustment (0–100)
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

<a name="ErrNoValue"></a>

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



	type Logger struct {
	    // contains filtered or unexported fields
	}

<a name="Logger.Attention"></a>
### func \(\*Logger\) Attention

	func (l *Logger) Attention(args ...any)



<a name="Logger.CreateLogger"></a>
### func \(\*Logger\) CreateLogger

	func (l *Logger) CreateLogger(opts *loggerOptions) *Logger



<a name="Logger.Debug"></a>
### func \(\*Logger\) Debug

	func (l *Logger) Debug(args ...any)



<a name="Logger.Error"></a>
### func \(\*Logger\) Error

	func (l *Logger) Error(args ...any)



<a name="Logger.Log"></a>
### func \(\*Logger\) Log

	func (l *Logger) Log(args ...any)



<a name="Logger.Success"></a>
### func \(\*Logger\) Success

	func (l *Logger) Success(args ...any)



<a name="Logger.Trace"></a>
### func \(\*Logger\) Trace

	func (l *Logger) Trace(args ...any)



<a name="Logger.Warn"></a>
### func \(\*Logger\) Warn

	func (l *Logger) Warn(args ...any)



<a name="ModelSpec"></a>
