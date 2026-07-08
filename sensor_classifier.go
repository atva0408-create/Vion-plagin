package sdk

// Property names of a classifier sensor.
const (
	classifierPropertyDetected   = "detected"   // Whether any classification result is active
	classifierPropertyDetections = "detections" // List of classification results with labels and confidence
	classifierPropertyLabels     = "labels"     // Unique labels of the current detections (auto-derived when reporting detections)
)

// ClassifierDetection is a classifier detection result with an open
// attribute for classifier categories. The Attribute field of the embedded
// Detection holds the classifier category (e.g. "bird", "delivery").
type ClassifierDetection struct {
	Detection
	SubAttribute string `msgpack:"subAttribute" json:"subAttribute"` // Classifier sub-category (e.g. "woodpecker", "amazon")
}

// ClassifierResult is the return value of ClassifierDetector.DetectClassifications.
type ClassifierResult struct {
	Detected   bool                  `msgpack:"detected" json:"detected"`     // Whether any classification result is emitted for this frame
	Detections []ClassifierDetection `msgpack:"detections" json:"detections"` // Detections emitted for this frame
}

// ClassifierDetector is implemented by plugins that run image classification
// models against pre-cropped trigger regions.
type ClassifierDetector interface {
	// ModelSpec declares the expected input dimensions and trigger labels. The
	// runtime scales frames to match.
	ModelSpec() ModelSpec
	// DetectClassifications classifies a batch of pre-cropped, pre-scaled
	// trigger regions and must return exactly one ClassifierResult per input
	// frame, in the same order.
	DetectClassifications(frames []VideoFrameData) ([]ClassifierResult, error)
}

// ClassifierSensor reports classification results from image analysis.
//
// Plugin authors call ReportDetections to push classification results. The
// `detected` flag and `labels` are auto-derived from the detection list.
type ClassifierSensor struct{ BaseSensor }

func NewClassifierSensor(name string) *ClassifierSensor {
	s := &ClassifierSensor{BaseSensor: NewBaseSensor(name)}
	s.writeState(map[string]any{
		classifierPropertyDetected:   false,
		classifierPropertyDetections: []ClassifierDetection{},
		classifierPropertyLabels:     []string{},
	})
	return s
}

func (s *ClassifierSensor) GetType() SensorType { return SensorTypeClassifier }

func (s *ClassifierSensor) GetCategory() SensorCategory { return SensorCategorySensor }

func (s *ClassifierSensor) ToJSON() sensorJSON { return s.toBaseJSON(s.GetType(), s.GetCategory()) }

// IsDetected reports whether any classification result is currently active.
func (s *ClassifierSensor) IsDetected() bool {
	v, _ := s.GetValue(classifierPropertyDetected).(bool)
	return v
}

// GetDetections returns the current classification results.
func (s *ClassifierSensor) GetDetections() []ClassifierDetection {
	v, _ := s.GetValue(classifierPropertyDetections).([]ClassifierDetection)
	return v
}

// GetLabels returns the unique labels of the current detections.
func (s *ClassifierSensor) GetLabels() []string {
	v, _ := s.GetValue(classifierPropertyLabels).([]string)
	return v
}

// ReportDetections reports classification results. The `detected` flag and
// `labels` are auto-derived from the detection list.
//
//   - ReportDetections(true, nil) — generic classification trigger; the SDK
//     synthesizes a single full-frame detection with empty attribute and
//     sub-attribute.
//   - ReportDetections(true, [...]) — explicit classifier detections.
//   - ReportDetections(false, nil) — clear.
//
// Example:
//
//	sensor.ReportDetections(true, []ClassifierDetection{
//	    {Detection: Detection{Label: "animal", Confidence: 0.88, Box: &BoundingBox{X: 0.1, Y: 0.2, Width: 0.3, Height: 0.4}, Attribute: "bird"}, SubAttribute: "woodpecker"},
//	})
//	sensor.ReportDetections(false, nil)
func (s *ClassifierSensor) ReportDetections(detected bool, detections []ClassifierDetection) {
	var list []ClassifierDetection
	switch {
	case !detected:
		list = []ClassifierDetection{}
	case len(detections) > 0:
		list = detections
	default:
		list = []ClassifierDetection{{
			Detection: Detection{
				Label:      "motion",
				Confidence: 1,
				Box:        &BoundingBox{X: 0, Y: 0, Width: 1, Height: 1},
			},
		}}
	}
	labels := dedupClassifierLabels(list)
	s.writeState(map[string]any{
		classifierPropertyDetected:   detected,
		classifierPropertyDetections: list,
		classifierPropertyLabels:     labels,
	})
}

// ClearDetections explicitly clears classifier state (detected = false, detections = [], labels = []).
func (s *ClassifierSensor) ClearDetections() {
	s.ReportDetections(false, nil)
}

// UpdateValue is a no-op for read-only classifier sensors. State is reported via ReportDetections.
func (s *ClassifierSensor) UpdateValue(property string, value any) error {
	return nil
}

// ClassifierDetectorSensor is a classifier sensor that consumes video frames
// from the backend pipeline. Pair with a ClassifierDetector implementation.
type ClassifierDetectorSensor struct {
	ClassifierSensor
}

func NewClassifierDetectorSensor(name string) *ClassifierDetectorSensor {
	s := &ClassifierDetectorSensor{ClassifierSensor: *NewClassifierSensor(name)}
	s.requiresFrames = true
	return s
}

func dedupClassifierLabels(detections []ClassifierDetection) []string {
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
