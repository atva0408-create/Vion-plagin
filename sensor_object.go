package sdk

// Property names of an object detection sensor.
const (
	objectPropertyDetected   = "detected"   // Whether any object is currently detected
	objectPropertyDetections = "detections" // List of detected objects with labels and bounding boxes
	objectPropertyLabels     = "labels"     // Unique labels of the current detections (auto-derived when reporting detections)
)

// TrackVelocity is the signed centroid velocity vector in normalized units
// per frame. Positive X = moving right, positive Y = moving down. Consumers
// doing motion prediction (PTZ autotrack, trajectory estimation) should use
// this instead of deriving velocity from frame-to-frame position deltas.
type TrackVelocity struct {
	X float64 `msgpack:"x" json:"x"`
	Y float64 `msgpack:"y" json:"y"`
}

// TrackedDetection extends Detection with tracking metadata (stable IDs,
// velocity). Tracking fields are omitempty — plugins return plain Detection,
// and the server-side tracker fills these in.
type TrackedDetection struct {
	Detection
	TrackId       *int           `msgpack:"trackId,omitempty" json:"trackId,omitempty"`             // Stable sequential ID for this object across frames
	TrackAge      *int           `msgpack:"trackAge,omitempty" json:"trackAge,omitempty"`           // Number of frames this object has been continuously tracked
	TrackSpeed    *float64       `msgpack:"trackSpeed,omitempty" json:"trackSpeed,omitempty"`       // Velocity magnitude in normalized units per frame; 0 = stationary
	TrackVelocity *TrackVelocity `msgpack:"trackVelocity,omitempty" json:"trackVelocity,omitempty"` // Signed centroid velocity vector in normalized units per frame
	TrackLost     *bool          `msgpack:"trackLost,omitempty" json:"trackLost,omitempty"`         // True if the object was not matched in the current frame
}

// ObjectResult is the return value of ObjectDetector.DetectObjects.
type ObjectResult struct {
	Detected   bool               `msgpack:"detected" json:"detected"`     // Whether any object is detected in this frame
	Detections []TrackedDetection `msgpack:"detections" json:"detections"` // Detections emitted for this frame
}

// ObjectDetector is implemented by plugins that detect objects in video
// frames. The runtime scales frames to match ModelSpec before each call.
type ObjectDetector interface {
	// ModelSpec declares the expected input dimensions.
	ModelSpec() ObjectModelSpec
	// DetectObjects analyzes a single video frame and returns the object result.
	DetectObjects(frame VideoFrameData) (*ObjectResult, error)
}

func dedupLabels(detections []TrackedDetection) []string {
	seen := make(map[string]struct{})
	result := make([]string, 0, len(detections))
	for _, d := range detections {
		if d.Label == "" {
			continue
		}
		if _, ok := seen[d.Label]; ok {
			continue
		}
		seen[d.Label] = struct{}{}
		result = append(result, d.Label)
	}
	return result
}

// ObjectSensor reports detected objects (person, vehicle, animal, etc.).
//
// Plugin authors call ReportDetections to push detection results. The
// `detected` flag and `labels` are auto-derived from the detection list.
type ObjectSensor struct {
	BaseSensor
}

func NewObjectSensor(name string) *ObjectSensor {
	s := &ObjectSensor{BaseSensor: NewBaseSensor(name)}
	s.writeState(map[string]any{
		objectPropertyDetected:   false,
		objectPropertyDetections: []TrackedDetection{},
		objectPropertyLabels:     []string{},
	})
	return s
}

func (s *ObjectSensor) GetType() SensorType { return SensorTypeObject }

func (s *ObjectSensor) GetCategory() SensorCategory { return SensorCategorySensor }

func (s *ObjectSensor) ToJSON() sensorJSON { return s.toBaseJSON(s.GetType(), s.GetCategory()) }

// IsDetected reports whether any object is currently detected.
func (s *ObjectSensor) IsDetected() bool {
	v, _ := s.GetValue(objectPropertyDetected).(bool)
	return v
}

// GetDetections returns the current object detections.
func (s *ObjectSensor) GetDetections() []TrackedDetection {
	v, _ := s.GetValue(objectPropertyDetections).([]TrackedDetection)
	return v
}

// GetLabels returns the unique labels of the current detections.
func (s *ObjectSensor) GetLabels() []string {
	v, _ := s.GetValue(objectPropertyLabels).([]string)
	return v
}

// ReportDetections reports detected objects. The `detected` flag and `labels`
// are auto-derived from the detection list.
//
//   - ReportDetections(true, nil) — generic trigger; synthesizes a single
//     full-frame "motion" detection as a fallback.
//   - ReportDetections(true, [...]) — explicit detections.
//   - ReportDetections(false, nil) — clear.
//
// Example:
//
//	sensor.ReportDetections(true, []TrackedDetection{
//	    {Detection: Detection{Label: "person", Confidence: 0.92, Box: &BoundingBox{X: 0.1, Y: 0.2, Width: 0.3, Height: 0.4}}},
//	})
//	sensor.ReportDetections(false, nil)
func (s *ObjectSensor) ReportDetections(detected bool, detections []TrackedDetection) {
	var list []TrackedDetection
	switch {
	case !detected:
		list = []TrackedDetection{}
	case len(detections) > 0:
		list = detections
	default:
		list = []TrackedDetection{{
			Detection: Detection{
				Label:      "motion",
				Confidence: 1,
				Box:        &BoundingBox{X: 0, Y: 0, Width: 1, Height: 1},
			},
		}}
	}
	labels := dedupLabels(list)
	s.writeState(map[string]any{
		objectPropertyDetected:   detected,
		objectPropertyDetections: list,
		objectPropertyLabels:     labels,
	})
}

// ClearDetections explicitly clears detection state (detected = false, detections = [], labels = []).
func (s *ObjectSensor) ClearDetections() {
	s.ReportDetections(false, nil)
}

// UpdateValue is a no-op for read-only object sensors. State is reported via ReportDetections.
func (s *ObjectSensor) UpdateValue(property string, value any) error {
	return nil
}

// ObjectDetectorSensor is an object sensor that consumes video frames from
// the backend pipeline. Pair with an ObjectDetector implementation.
type ObjectDetectorSensor struct {
	ObjectSensor
}

func NewObjectDetectorSensor(name string) *ObjectDetectorSensor {
	s := &ObjectDetectorSensor{ObjectSensor: *NewObjectSensor(name)}
	s.requiresFrames = true
	return s
}
