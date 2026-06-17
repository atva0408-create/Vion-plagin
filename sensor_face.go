package sdk

// Property names of a face detection sensor.
const (
	facePropertyDetected   = "detected"   // Whether any face is currently detected
	facePropertyDetections = "detections" // List of detected faces with optional identity, embedding, and thumbnail
)

// FaceDetection is a face detection result, extending Detection with
// face-specific fields. The Attribute field of the embedded Detection is
// fixed to "face".
type FaceDetection struct {
	Detection
	Identity  string    `msgpack:"identity,omitempty" json:"identity,omitempty"`   // Recognized identity name, if matched against known faces
	Embedding []float64 `msgpack:"embedding,omitempty" json:"embedding,omitempty"` // Face embedding vector for recognition/comparison
	Thumbnail []byte    `msgpack:"thumbnail,omitempty" json:"thumbnail,omitempty"` // JPEG thumbnail crop of the detected face
}

// FaceResult is the return value of FaceDetector.DetectFaces.
type FaceResult struct {
	Detected   bool            `msgpack:"detected" json:"detected"`     // Whether any face is detected in this frame
	Detections []FaceDetection `msgpack:"detections" json:"detections"` // Detections emitted for this frame
}

// FaceDetector is implemented by plugins that perform face detection and
// recognition on pre-cropped person regions.
type FaceDetector interface {
	// ModelSpec declares the expected input dimensions and trigger labels. The
	// runtime scales frames to match.
	ModelSpec() ModelSpec
	// DetectFaces analyzes a batch of pre-cropped, pre-scaled person regions
	// and must return exactly one FaceResult per input frame, in the same order.
	DetectFaces(frames []VideoFrameData) ([]FaceResult, error)
}

// FaceSensor reports detected faces and optional identity matches.
//
// Plugin authors call ReportDetections to push detected faces. The
// `detected` flag is auto-derived from the detection list.
type FaceSensor struct{ BaseSensor }

// NewFaceSensor creates a new FaceSensor with the given name.
func NewFaceSensor(name string) *FaceSensor {
	s := &FaceSensor{BaseSensor: NewBaseSensor(name)}
	s.writeState(map[string]any{
		facePropertyDetected:   false,
		facePropertyDetections: []FaceDetection{},
	})
	return s
}

// GetType returns SensorTypeFace.
func (s *FaceSensor) GetType() SensorType { return SensorTypeFace }

// GetCategory returns SensorCategorySensor.
func (s *FaceSensor) GetCategory() SensorCategory { return SensorCategorySensor }

// ToJSON serializes this sensor to a JSON-safe representation for RPC transport.
func (s *FaceSensor) ToJSON() sensorJSON { return s.toBaseJSON(s.GetType(), s.GetCategory()) }

// IsDetected reports whether any face is currently detected.
func (s *FaceSensor) IsDetected() bool {
	v, _ := s.GetValue(facePropertyDetected).(bool)
	return v
}

// ReportDetections reports detected faces.
//
//   - ReportDetections(true, nil) — face detected without specifics; the SDK
//     synthesizes a single full-frame face detection without identity.
//   - ReportDetections(true, [...]) — explicit face detections with
//     identity, embedding, and/or thumbnail.
//   - ReportDetections(false, nil) — clear.
//
// Example:
//
//	sensor.ReportDetections(true, []FaceDetection{
//	    {Detection: Detection{Label: "person", Confidence: 0.94, Box: &BoundingBox{X: 0.4, Y: 0.2, Width: 0.15, Height: 0.25}, Attribute: "face"}, Identity: "Alice"},
//	})
//	sensor.ReportDetections(false, nil)
func (s *FaceSensor) ReportDetections(detected bool, detections []FaceDetection) {
	var list []FaceDetection
	switch {
	case !detected:
		list = []FaceDetection{}
	case len(detections) > 0:
		list = detections
	default:
		list = []FaceDetection{{
			Detection: Detection{
				Label:      "person",
				Confidence: 1,
				Box:        &BoundingBox{X: 0, Y: 0, Width: 1, Height: 1},
				Attribute:  "face",
			},
		}}
	}
	s.writeState(map[string]any{
		facePropertyDetected:   detected,
		facePropertyDetections: list,
	})
}

// ClearDetections explicitly clears face detection state (detected = false, detections = []).
func (s *FaceSensor) ClearDetections() {
	s.ReportDetections(false, nil)
}

// UpdateValue is a no-op for read-only face sensors. State is reported via ReportDetections.
func (s *FaceSensor) UpdateValue(property string, value any) error {
	return nil
}

// FaceDetectorSensor is a face sensor that consumes video frames from the
// backend pipeline. Pair with a FaceDetector implementation.
type FaceDetectorSensor struct {
	FaceSensor
}

// NewFaceDetectorSensor creates a new FaceDetectorSensor with the given name.
func NewFaceDetectorSensor(name string) *FaceDetectorSensor {
	s := &FaceDetectorSensor{FaceSensor: *NewFaceSensor(name)}
	s.requiresFrames = true
	return s
}
