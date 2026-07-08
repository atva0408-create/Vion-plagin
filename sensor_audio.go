package sdk

// AudioLabel is one of the built-in audio labels or any custom string emitted
// by an audio detector.
type AudioLabel = string

// BaseAudioLabels lists the built-in audio label types recognized across the system.
var BaseAudioLabels = []string{
	"doorbell", "glass_break", "siren", "speaking",
	"gunshot", "dog_bark", "baby_cry", "alarm",
	"scream", "cat", "car_alarm", "smoke_alarm",
}

const (
	audioPropertyDetected   = "detected"
	audioPropertyDetections = "detections"
	audioPropertyDecibels   = "decibels"
)

// AudioFormat identifies the sample format of an audio buffer.
type AudioFormat string

// Supported audio sample formats.
const (
	AudioFormatPCM16   AudioFormat = "pcm16"   // 16-bit signed integer PCM
	AudioFormatFloat32 AudioFormat = "float32" // 32-bit float
)

// AudioFrameData is audio frame data delivered to audio detector sensors by
// the backend pipeline.
type AudioFrameData struct {
	CameraID   string      `msgpack:"cameraId" json:"cameraId"`     // Camera the frame originated from
	Data       []byte      `msgpack:"data" json:"data"`             // Raw audio sample buffer
	SampleRate int         `msgpack:"sampleRate" json:"sampleRate"` // Sample rate of the buffer in Hz
	Channels   int         `msgpack:"channels" json:"channels"`     // Channel count of the buffer (typically 1 = mono)
	Format     AudioFormat `msgpack:"format" json:"format"`         // Sample format: pcm16 = 16-bit signed integer PCM, float32 = 32-bit float
	Decibels   float64     `msgpack:"decibels" json:"decibels"`     // Pre-computed decibel level for this frame, if available
	Timestamp  int64       `msgpack:"timestamp" json:"timestamp"`   // Capture timestamp in milliseconds since epoch
}

// AudioResult is the return value of AudioDetector.DetectAudio.
type AudioResult struct {
	Detected   bool        `msgpack:"detected" json:"detected"`     // Whether an audio event is detected in this frame
	Detections []Detection `msgpack:"detections" json:"detections"` // Detections emitted for this frame
	Decibels   float64     `msgpack:"decibels" json:"decibels"`     // Optional decibel level computed for this frame
}

// AudioDetector is implemented by plugins that classify audio events. The
// runtime resamples and buffers audio to match ModelSpec before each call.
type AudioDetector interface {
	// ModelSpec declares the expected audio input format.
	ModelSpec() AudioModelSpec
	// DetectAudio analyzes a single audio frame and returns the audio result.
	DetectAudio(audio AudioFrameData) (*AudioResult, error)
}

// AudioSensor reports audio events and decibel levels.
//
// Plugin authors call ReportDetections to push detected audio events (the
// `detected` flag is auto-derived from the list) and SetDecibels to publish
// the audio level.
type AudioSensor struct {
	BaseSensor
}

func NewAudioSensor(name string) *AudioSensor {
	s := &AudioSensor{BaseSensor: NewBaseSensor(name)}
	s.writeState(map[string]any{
		audioPropertyDetected:   false,
		audioPropertyDetections: []Detection{},
		audioPropertyDecibels:   0.0,
	})
	return s
}

func (s *AudioSensor) GetType() SensorType { return SensorTypeAudio }

func (s *AudioSensor) GetCategory() SensorCategory { return SensorCategorySensor }

func (s *AudioSensor) ToJSON() sensorJSON { return s.toBaseJSON(s.GetType(), s.GetCategory()) }

func (s *AudioSensor) IsDetected() bool {
	v, _ := s.GetValue(audioPropertyDetected).(bool)
	return v
}

func (s *AudioSensor) GetDetections() []Detection {
	v, _ := s.GetValue(audioPropertyDetections).([]Detection)
	return v
}

func (s *AudioSensor) GetDecibels() float64 {
	v, _ := s.GetValue(audioPropertyDecibels).(float64)
	return v
}

// ReportDetections reports detected audio events.
//
//   - ReportDetections(true, nil) — audio detected without specifics. The SDK
//     synthesizes a single full-frame "audio" detection.
//   - ReportDetections(true, [...]) — audio detected with explicit detections.
//   - ReportDetections(false, nil) — clear.
//
// Example:
//
//	sensor.ReportDetections(true, []Detection{
//	    {Label: "glass_break", Confidence: 0.91, Box: &BoundingBox{X: 0, Y: 0, Width: 1, Height: 1}},
//	})
//	sensor.ReportDetections(false, nil)
func (s *AudioSensor) ReportDetections(detected bool, detections []Detection) {
	list := normalizeReportedDetections(detected, detections, "audio", "")
	s.writeState(map[string]any{
		audioPropertyDetected:   detected,
		audioPropertyDetections: list,
	})
}

// ClearDetections explicitly clears audio detection state (detected = false, detections = []).
func (s *AudioSensor) ClearDetections() {
	s.ReportDetections(false, nil)
}

// SetDecibels updates the current audio level (in decibels).
//
// Example:
//
//	sensor.SetDecibels(72)
func (s *AudioSensor) SetDecibels(value float64) {
	s.writeState(map[string]any{audioPropertyDecibels: value})
}

// UpdateValue is a no-op for read-only audio sensors.
func (s *AudioSensor) UpdateValue(property string, value any) error {
	return nil
}

// AudioDetectorSensor is an audio sensor that consumes audio frames from the
// backend pipeline. Pair with an AudioDetector implementation.
type AudioDetectorSensor struct {
	AudioSensor
}

func NewAudioDetectorSensor(name string) *AudioDetectorSensor {
	s := &AudioDetectorSensor{AudioSensor: *NewAudioSensor(name)}
	s.requiresFrames = true
	return s
}
