package sdk

// VideoInputSpec describes the expected video input dimensions and pixel
// format for a detector model.
type VideoInputSpec struct {
	Width  int         `msgpack:"width" json:"width"`   // Expected frame width in pixels
	Height int         `msgpack:"height" json:"height"` // Expected frame height in pixels
	Format FrameFormat `msgpack:"format" json:"format"` // Pixel format: rgb = 3 bytes/pixel, gray = 1 byte/pixel, nv12 = YUV semi-planar
}

// AudioInputSpec describes the expected audio input format for an audio
// detector model.
type AudioInputSpec struct {
	SampleRate      int         `msgpack:"sampleRate" json:"sampleRate"`                               // Sample rate in Hz the model expects
	Channels        int         `msgpack:"channels" json:"channels"`                                   // Channel count the model expects (typically 1 = mono)
	Format          AudioFormat `msgpack:"format" json:"format"`                                       // Sample format (pcm16 = 16-bit signed PCM, float32 = 32-bit float)
	SamplesPerFrame int         `msgpack:"samplesPerFrame,omitempty" json:"samplesPerFrame,omitempty"` // Number of samples per audio frame; the backend buffers audio to deliver exactly this many samples per call
}

// ModelSpec describes a detection model with fixed output labels (face,
// classifier, license plate). It declares the input shape the backend should
// produce and the trigger labels that should activate this detector.
type ModelSpec struct {
	Input          VideoInputSpec `msgpack:"input" json:"input"`                                       // Required input frame dimensions and pixel format
	TriggerLabels  []string       `msgpack:"triggerLabels" json:"triggerLabels"`                       // Labels emitted by an upstream object detector that activate this detector
	EmbeddingModel string         `msgpack:"embeddingModel,omitempty" json:"embeddingModel,omitempty"` // Embedding model identifier, required for face recognition and CLIP: embeddings are stored and matched under this id
}

// ObjectModelSpec describes an object detection model. Only declares input
// dimensions — the output label set is dynamic and comes from the model itself.
type ObjectModelSpec struct {
	Input VideoInputSpec `msgpack:"input" json:"input"` // Required input frame dimensions and pixel format
}

// AudioModelSpec describes an audio detection model.
type AudioModelSpec struct {
	Input AudioInputSpec `msgpack:"input" json:"input"` // Required input audio format
}
