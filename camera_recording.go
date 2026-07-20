package sdk

// RecordingMode selects how recordings are captured.
type RecordingMode string

// Recording modes.
const (
	// RecordingModeContinuous records around the clock.
	RecordingModeContinuous RecordingMode = "continuous"
	// RecordingModeEvent records only around detections, padded by the pre-buffer.
	RecordingModeEvent RecordingMode = "event"
	// RecordingModeAdhoc records only when started manually.
	RecordingModeAdhoc RecordingMode = "adhoc"
)

// RecordingSource is a stream tier to record.
type RecordingSource string

// Recording sources.
const (
	// RecordingSourceHigh is the high resolution stream.
	RecordingSourceHigh RecordingSource = "high"
	// RecordingSourceMid is the mid resolution stream.
	RecordingSourceMid RecordingSource = "mid"
	// RecordingSourceLow is the low resolution stream.
	RecordingSourceLow RecordingSource = "low"
)

// CameraRecordingSettings is the recording configuration for a camera.
type CameraRecordingSettings struct {
	// Enabled reports whether recording is enabled.
	Enabled bool `msgpack:"enabled" json:"enabled"`
	// Mode is the recording mode.
	Mode RecordingMode `msgpack:"mode,omitempty" json:"mode"`
	// PreBuffer is the seconds of video kept before an event (event mode, 0 - 60).
	PreBuffer float64 `msgpack:"preBuffer,omitempty" json:"preBuffer"`
	// Sources are the stream tiers to record.
	Sources []RecordingSource `msgpack:"sources,omitempty" json:"sources,omitempty"`
}
