package sdk

// Property names of a license plate detection sensor.
const (
	licensePlatePropertyDetected   = "detected"   // Whether any license plate is currently detected
	licensePlatePropertyDetections = "detections" // List of detected plates with OCR text
)

// LicensePlateDetection is a license plate detection result, extending
// Detection with OCR fields. The Attribute field of the embedded Detection
// is fixed to "license_plate".
type LicensePlateDetection struct {
	Detection
	PlateText string `msgpack:"plateText,omitempty" json:"plateText,omitempty"` // Recognized plate text (e.g. "ABC 1234")
}

// LicensePlateResult is the return value of LicensePlateDetector.DetectLicensePlates.
type LicensePlateResult struct {
	Detected   bool                    `msgpack:"detected" json:"detected"`     // Whether any license plate is detected in this frame
	Detections []LicensePlateDetection `msgpack:"detections" json:"detections"` // Detections emitted for this frame
}

// LicensePlateDetector is implemented by plugins that perform license plate
// detection and OCR on pre-cropped vehicle regions.
type LicensePlateDetector interface {
	// ModelSpec declares the expected input dimensions and trigger labels. The
	// runtime scales frames to match.
	ModelSpec() ModelSpec
	// DetectLicensePlates analyzes a batch of pre-cropped, pre-scaled vehicle
	// regions and must return exactly one LicensePlateResult per input frame,
	// in the same order.
	DetectLicensePlates(frames []VideoFrameData) ([]LicensePlateResult, error)
}

// LicensePlateSensor reports detected license plates and OCR results.
//
// Plugin authors call ReportDetections to push detected plates. The
// `detected` flag is auto-derived from the detection list.
type LicensePlateSensor struct{ BaseSensor }

// NewLicensePlateSensor creates a new LicensePlateSensor with the given name.
func NewLicensePlateSensor(name string) *LicensePlateSensor {
	s := &LicensePlateSensor{BaseSensor: NewBaseSensor(name)}
	s.writeState(map[string]any{
		licensePlatePropertyDetected:   false,
		licensePlatePropertyDetections: []LicensePlateDetection{},
	})
	return s
}

// GetType returns SensorTypeLicensePlate.
func (s *LicensePlateSensor) GetType() SensorType { return SensorTypeLicensePlate }

// GetCategory returns SensorCategorySensor.
func (s *LicensePlateSensor) GetCategory() SensorCategory { return SensorCategorySensor }

// ToJSON serializes this sensor to a JSON-safe representation for RPC transport.
func (s *LicensePlateSensor) ToJSON() sensorJSON {
	return s.toBaseJSON(s.GetType(), s.GetCategory())
}

// IsDetected reports whether any license plate is currently detected.
func (s *LicensePlateSensor) IsDetected() bool {
	v, _ := s.GetValue(licensePlatePropertyDetected).(bool)
	return v
}

// ReportDetections reports detected license plates.
//
//   - ReportDetections(true, nil) — plate detected without specifics; the SDK
//     synthesizes a single full-frame detection with empty plateText.
//   - ReportDetections(true, [...]) — explicit plate detections with OCR text.
//   - ReportDetections(false, nil) — clear.
//
// Example:
//
//	sensor.ReportDetections(true, []LicensePlateDetection{
//	    {Detection: Detection{Label: "vehicle", Confidence: 0.93, Box: &BoundingBox{X: 0.2, Y: 0.5, Width: 0.2, Height: 0.08}, Attribute: "license_plate"}, PlateText: "ABC 1234"},
//	})
//	sensor.ReportDetections(false, nil)
func (s *LicensePlateSensor) ReportDetections(detected bool, detections []LicensePlateDetection) {
	var list []LicensePlateDetection
	switch {
	case !detected:
		list = []LicensePlateDetection{}
	case len(detections) > 0:
		list = detections
	default:
		list = []LicensePlateDetection{{
			Detection: Detection{
				Label:      "vehicle",
				Confidence: 1,
				Box:        &BoundingBox{X: 0, Y: 0, Width: 1, Height: 1},
				Attribute:  "license_plate",
			},
		}}
	}
	s.writeState(map[string]any{
		licensePlatePropertyDetected:   detected,
		licensePlatePropertyDetections: list,
	})
}

// ClearDetections explicitly clears license plate state (detected = false, detections = []).
func (s *LicensePlateSensor) ClearDetections() {
	s.ReportDetections(false, nil)
}

// UpdateValue is a no-op for read-only license plate sensors. State is reported via ReportDetections.
func (s *LicensePlateSensor) UpdateValue(property string, value any) error {
	return nil
}

// LicensePlateDetectorSensor is a license plate sensor that consumes video
// frames from the backend pipeline. Pair with a LicensePlateDetector
// implementation.
type LicensePlateDetectorSensor struct {
	LicensePlateSensor
}

// NewLicensePlateDetectorSensor creates a new LicensePlateDetectorSensor with the given name.
func NewLicensePlateDetectorSensor(name string) *LicensePlateDetectorSensor {
	s := &LicensePlateDetectorSensor{LicensePlateSensor: *NewLicensePlateSensor(name)}
	s.requiresFrames = true
	return s
}
