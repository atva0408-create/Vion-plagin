package sdk

// Property names for motion sensors.
const (
	motionPropertyDetected   = "detected"   // Whether motion is currently detected
	motionPropertyDetections = "detections" // List of detection results with bounding boxes
	motionPropertyBlocked    = "blocked"    // When true, detection updates are suppressed
)

// MotionResult is the return value of MotionDetector.DetectMotion.
type MotionResult struct {
	Detected   bool        `msgpack:"detected" json:"detected"`     // Whether motion is detected in this frame. Ignored by the backend, which re-derives it from the detections
	Detections []Detection `msgpack:"detections" json:"detections"` // Detections emitted for this frame
}

// MotionDetector is implemented by plugins that analyze video frames for motion.
// The runtime calls DetectMotion at the configured frame interval, zone-filters
// the returned detections and applies them to the associated MotionSensor.
// Detected is re-derived from the surviving detections, so a result with no
// detections reports no motion.
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

func NewMotionSensor(name string) *MotionSensor {
	s := &MotionSensor{BaseSensor: NewBaseSensor(name)}
	s.writeState(map[string]any{
		motionPropertyDetected:   false,
		motionPropertyDetections: []Detection{},
		motionPropertyBlocked:    false,
	})
	return s
}

func (s *MotionSensor) GetType() SensorType { return SensorTypeMotion }

func (s *MotionSensor) GetCategory() SensorCategory { return SensorCategorySensor }

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

// GetDetections returns the current motion detections.
func (s *MotionSensor) GetDetections() []Detection {
	v, _ := s.GetValue(motionPropertyDetections).([]Detection)
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

func NewMotionDetectorSensor(name string) *MotionDetectorSensor {
	s := &MotionDetectorSensor{MotionSensor: *NewMotionSensor(name)}
	s.requiresFrames = true
	return s
}
