package sdk

// ClipEmbedding is a CLIP embedding result for a detected region.
type ClipEmbedding struct {
	Label     string      `msgpack:"label" json:"label"`         // Detection label this embedding was computed for (e.g. "person", "vehicle")
	Box       BoundingBox `msgpack:"box" json:"box"`             // Bounding box of the detected region in normalized coordinates
	Embedding []float64   `msgpack:"embedding" json:"embedding"` // CLIP embedding vector
}

// ClipResult is the return value of ClipDetector.DetectEmbeddings.
type ClipResult struct {
	Embeddings     []ClipEmbedding `msgpack:"embeddings" json:"embeddings"`         // Embeddings emitted for this frame
	EmbeddingModel string          `msgpack:"embeddingModel" json:"embeddingModel"` // Identifier of the embedding model used to produce the vectors
}

// ClipDetector is implemented by plugins that generate CLIP embeddings for
// downstream semantic search.
type ClipDetector interface {
	// ModelSpec declares the expected input dimensions and trigger labels.
	ModelSpec() ModelSpec
	// DetectEmbeddings produces CLIP embeddings for a batch of frames, each
	// scaled to ModelSpec().Input: normally a trigger region cropped by the
	// upstream object detector, but the whole scene when no decoded frame is
	// available. Must return exactly one ClipResult per input frame, in the
	// same order; use VideoFrameData.Label to tag the emitted embedding.
	DetectEmbeddings(frames []VideoFrameData) ([]ClipResult, error)
}

// ClipDetectorSensor is a frame-only sensor that generates CLIP embeddings
// from video frames. Pair with a ClipDetector implementation.
type ClipDetectorSensor struct{ BaseSensor }

// NewClipDetectorSensor creates a CLIP detector sensor with the given name and options.
func NewClipDetectorSensor(name string, opts ...SensorOption) *ClipDetectorSensor {
	s := &ClipDetectorSensor{BaseSensor: NewBaseSensor(name, opts...)}
	s.requiresFrames = true
	return s
}

func (s *ClipDetectorSensor) GetType() SensorType         { return SensorTypeClip }
func (s *ClipDetectorSensor) GetCategory() SensorCategory { return SensorCategorySensor }
func (s *ClipDetectorSensor) ToJSON() sensorJSON          { return s.toBaseJSON(s.GetType(), s.GetCategory()) }

// UpdateValue on a read-only sensor: external writes are ignored.
func (s *ClipDetectorSensor) UpdateValue(property string, value any) error {
	return nil
}
