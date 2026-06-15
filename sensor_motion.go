package sdk

// Property names for motion sensors.
const (
	motionPropertyDetected   = "detected"   // Whether motion is currently detected
	motionPropertyDetections = "detections" // List of detection results with bounding boxes
	motionPropertyBlocked    = "blocked"    // When true, detection updates are suppressed
)

// FrameFormat identifies the pixel layout of a video frame.
type FrameFormat string

// Supported video frame pixel formats.
const (
	FrameFormatNV12 FrameFormat = "nv12" // YUV 4:2:0 semi-planar
	FrameFormatRGB  FrameFormat = "rgb"  // 3 bytes/pixel interleaved
	FrameFormatRGBA FrameFormat = "rgba" // 4 bytes/pixel interleaved
	FrameFormatGray FrameFormat = "gray" // 1 byte/pixel grayscale
)

// DetectionLabel is a label identifying a type of detection.
type DetectionLabel = string

// DetectionLabels lists the built-in detection label types recognized across the system.
var DetectionLabels = []string{
	"motion", "person", "vehicle", "animal",
	"package", "audio",
}

// DetectionAttribute identifies the kind of a sub-detection (face, license plate, ...).
type DetectionAttribute = string

// DetectionAttributes lists the built-in detection attribute types.
var DetectionAttributes = []string{"face", "license_plate"}

// KnownEventTypes is the set of standard event types (detection labels + attributes + trigger types).
// Used to identify "other" (classifier-produced) types that fall outside this set.
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

// BoundingBox is the bounding box of a detection. All coordinates are
// normalized to 0-1 (fraction of frame dimensions), so they are independent
// of resolution.
type BoundingBox struct {
	X      float64 `msgpack:"x" json:"x"`           // X coordinate of the top-left corner (0-1)
	Y      float64 `msgpack:"y" json:"y"`           // Y coordinate of the top-left corner (0-1)
	Width  float64 `msgpack:"width" json:"width"`   // Width as a fraction of frame width (0-1)
	Height float64 `msgpack:"height" json:"height"` // Height as a fraction of frame height (0-1)
}

// Detection is a single detection result emitted by any detection sensor.
type Detection struct {
	Label      string       `msgpack:"label" json:"label"`                             // Detection label (e.g. "person", "vehicle")
	Confidence float64      `msgpack:"confidence" json:"confidence"`                   // Confidence score in the range 0-1
	Box        *BoundingBox `msgpack:"box,omitempty" json:"box,omitempty"`             // Bounding box in normalized coordinates
	Attribute  string       `msgpack:"attribute,omitempty" json:"attribute,omitempty"` // Optional sub-detection attribute (face, license_plate, or classifier-specific)
}

// VideoFrameData is the video frame payload delivered to detector sensors by
// the backend pipeline. The backend handles capture, decoding, and scaling —
// detectors only need to process the pixel buffer.
type VideoFrameData struct {
	ID        string      `msgpack:"id" json:"id"`                           // Unique frame or crop identifier used to map batch results back to inputs
	CameraID  string      `msgpack:"cameraId" json:"cameraId"`               // Camera the frame originated from
	Data      []byte      `msgpack:"data" json:"data"`                       // Raw pixel buffer
	Width     int         `msgpack:"width" json:"width"`                     // Frame width in pixels
	Height    int         `msgpack:"height" json:"height"`                   // Frame height in pixels
	Format    FrameFormat `msgpack:"format" json:"format"`                   // Pixel format (nv12, rgb, rgba, gray)
	Timestamp int64       `msgpack:"timestamp" json:"timestamp"`             // Capture timestamp in milliseconds since epoch
	Label     string      `msgpack:"label,omitempty" json:"label,omitempty"` // Trigger label propagated by the coordinator for secondary detectors
}

// MotionResult is the return value of MotionDetector.DetectMotion.
type MotionResult struct {
	Detected   bool        `msgpack:"detected" json:"detected"`     // Whether motion is detected in this frame
	Detections []Detection `msgpack:"detections" json:"detections"` // Detections emitted for this frame
}

// MotionDetector is implemented by plugins that analyze video frames for motion.
// The runtime calls DetectMotion at the configured frame interval and applies
// the returned MotionResult to the associated MotionSensor.
type MotionDetector interface {
	// DetectMotion analyzes a single video frame and returns the motion result.
	DetectMotion(frame VideoFrameData) (*MotionResult, error)
}

// MotionSensor reports motion state and detection results.
//
// Plugin authors call ReportDetections to push detection results. The
// `detected` flag is auto-derived from the detection list. `blocked` is
// read-only and is set by the backend (dwell logic) — ReportDetections
// becomes a no-op while the sensor is blocked.
type MotionSensor struct {
	BaseSensor
}

// NewMotionSensor creates a new MotionSensor with the given name.
func NewMotionSensor(name string) *MotionSensor {
	s := &MotionSensor{BaseSensor: NewBaseSensor(name)}
	s.writeState(map[string]any{
		motionPropertyDetected:   false,
		motionPropertyDetections: []Detection{},
		motionPropertyBlocked:    false,
	})
	return s
}

// GetType returns SensorTypeMotion.
func (s *MotionSensor) GetType() SensorType { return SensorTypeMotion }

// GetCategory returns SensorCategorySensor.
func (s *MotionSensor) GetCategory() SensorCategory { return SensorCategorySensor }

// ToJSON serializes this sensor to a JSON-safe representation for RPC transport.
func (s *MotionSensor) ToJSON() sensorJSON { return s.toBaseJSON(s.GetType(), s.GetCategory()) }

// IsDetected reports whether motion is currently detected.
func (s *MotionSensor) IsDetected() bool {
	v, _ := s.GetValue(motionPropertyDetected).(bool)
	return v
}

// IsBlocked reports whether the sensor is currently blocked by the backend dwell logic.
func (s *MotionSensor) IsBlocked() bool {
	v, _ := s.GetValue(motionPropertyBlocked).(bool)
	return v
}

// ReportDetections reports a motion detection result.
//
//   - ReportDetections(true, nil) — motion detected without bounding box.
//     The SDK synthesizes a single full-frame "motion" detection.
//   - ReportDetections(true, [...]) — motion detected with explicit detections.
//   - ReportDetections(false, nil) — no motion (clears detections).
//
// No-op while the sensor is blocked by the backend dwell logic.
//
// Example:
//
//	sensor.ReportDetections(true, []Detection{
//	    {Label: "motion", Confidence: 0.85, Box: &BoundingBox{X: 0.1, Y: 0.2, Width: 0.3, Height: 0.4}},
//	})
//	sensor.ReportDetections(false, nil)
func (s *MotionSensor) ReportDetections(detected bool, detections []Detection) {
	if s.IsBlocked() {
		return
	}
	list := normalizeReportedDetections(detected, detections, "motion", "")
	s.writeState(map[string]any{
		motionPropertyDetected:   detected,
		motionPropertyDetections: list,
	})
}

// ClearDetections explicitly clears motion state (detected = false, detections = []).
func (s *MotionSensor) ClearDetections() {
	s.ReportDetections(false, nil)
}

// UpdateValue is a no-op for read-only motion sensors. State is reported via ReportDetections.
func (s *MotionSensor) UpdateValue(property string, value any) error {
	return nil
}

// MotionDetectorSensor is a motion sensor that consumes video frames from the
// backend pipeline. Pair with a MotionDetector implementation; the backend
// invokes the detector at the configured frame interval and forwards results
// to this sensor.
type MotionDetectorSensor struct {
	MotionSensor
}

// NewMotionDetectorSensor creates a new MotionDetectorSensor with the given name.
func NewMotionDetectorSensor(name string) *MotionDetectorSensor {
	s := &MotionDetectorSensor{MotionSensor: *NewMotionSensor(name)}
	s.requiresFrames = true
	return s
}
