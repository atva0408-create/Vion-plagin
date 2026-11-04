package sdk

// FaceEmbeddingResult is the return value of FaceEmbedder.EmbedFaces.
type FaceEmbeddingResult struct {
	Embedding      []float64 `msgpack:"embedding" json:"embedding"`                     // Embedding vector for the face in this crop, empty when no face could be embedded
	EmbeddingModel string    `msgpack:"embeddingModel" json:"embeddingModel"`           // Identifier of the embedding model that produced the vector
	Landmarks      []Point   `msgpack:"landmarks,omitempty" json:"landmarks,omitempty"` // The five points the face was aligned on, in 0 - 1 of the input image: right eye, left eye, nose, right and left mouth corner
	Quality        float64   `msgpack:"quality,omitempty" json:"quality,omitempty"`     // How sure the model is that those points sit on a face (0 - 1)
}

// FaceEmbedder is implemented by plugins that turn a face crop into a vector
// for recognition against enrolled faces.
type FaceEmbedder interface {
	// ModelSpec declares the expected input dimensions and trigger labels.
	ModelSpec() ModelSpec
	// EmbedFaces embeds a batch of face crops, each padded around the
	// detected box and scaled to ModelSpec().Input. Must return exactly one
	// FaceEmbeddingResult per input frame, in the same order; return an empty
	// Embedding for a crop the model could not use.
	EmbedFaces(frames []VideoFrameData) ([]FaceEmbeddingResult, error)
}

// FaceEmbedderSensor is a frame-only sensor that turns face crops into
// vectors. Pair with a FaceEmbedder implementation.
//
// The crop comes from the face detector's box, cut from the source frame, so
// the sensor runs after face detection rather than on the raw scene. Vectors
// from different models are not comparable, which is why every result carries
// its embedding model.
type FaceEmbedderSensor struct{ BaseSensor }

// NewFaceEmbedderSensor creates a face embedder sensor with the given name and options.
func NewFaceEmbedderSensor(name string, opts ...SensorOption) *FaceEmbedderSensor {
	s := &FaceEmbedderSensor{BaseSensor: NewBaseSensor(name, opts...)}
	s.requiresFrames = true
	return s
}

func (s *FaceEmbedderSensor) GetType() SensorType         { return SensorTypeFaceEmbedder }
func (s *FaceEmbedderSensor) GetCategory() SensorCategory { return SensorCategorySensor }
func (s *FaceEmbedderSensor) ToJSON() sensorJSON          { return s.toBaseJSON(s.GetType(), s.GetCategory()) }

// UpdateValue on a read-only sensor: external writes are ignored.
func (s *FaceEmbedderSensor) UpdateValue(property string, value any) error {
	return nil
}
