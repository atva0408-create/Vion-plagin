package sdk

// ImageMetadata is image metadata passed to detector test methods.
type ImageMetadata struct {
	// Width is the image width in pixels.
	Width int `msgpack:"width" json:"width"`
	// Height is the image height in pixels.
	Height int `msgpack:"height" json:"height"`
}

// AudioMetadata is audio metadata passed to audio detector test methods.
type AudioMetadata struct {
	// MimeType is the container format of the audio buffer.
	MimeType string `msgpack:"mimeType" json:"mimeType"`
}

// MotionDetectionResponse is the result of a motion detection run.
type MotionDetectionResponse struct {
	// Detected is true when the run produced at least one detection.
	Detected bool `msgpack:"detected" json:"detected"`
	// Detections are the motion regions found in the input.
	Detections []Detection `msgpack:"detections" json:"detections"`
	// VideoData is an annotated re-encoded clip for the UI test panel, when
	// the plugin renders one.
	VideoData []byte `msgpack:"videoData,omitempty" json:"videoData,omitempty"`
}

// ObjectDetectionResponse is the result of an object detection run.
type ObjectDetectionResponse struct {
	// Detected is true when the run produced at least one detection.
	Detected bool `msgpack:"detected" json:"detected"`
	// Detections are the detected objects with label, score and bounding box.
	Detections []Detection `msgpack:"detections" json:"detections"`
}

// AudioDetectionResponse is the result of an audio detection run.
type AudioDetectionResponse struct {
	// Detected is true when the run produced at least one detection.
	Detected bool `msgpack:"detected" json:"detected"`
	// Detections are the detected audio events.
	Detections []Detection `msgpack:"detections" json:"detections"`
	// Decibels is the loudness of the analysed buffer in dBFS.
	Decibels float64 `msgpack:"decibels,omitempty" json:"decibels,omitempty"`
}

// FaceDetectionResponse is the result of a face detection run.
type FaceDetectionResponse struct {
	// Detected is true when the run produced at least one detection.
	Detected bool `msgpack:"detected" json:"detected"`
	// Detections are the detected faces, each with its embedding.
	Detections []FaceDetection `msgpack:"detections" json:"detections"`
	// EmbeddingModel is the model that produced the embeddings; consumers
	// must not mix models.
	EmbeddingModel string `msgpack:"embeddingModel,omitempty" json:"embeddingModel,omitempty"`
}

// LicensePlateDetectionResponse is the result of a license plate detection
// run.
type LicensePlateDetectionResponse struct {
	// Detected is true when the run produced at least one detection.
	Detected bool `msgpack:"detected" json:"detected"`
	// Detections are the detected plates with their OCR text.
	Detections []LicensePlateDetection `msgpack:"detections" json:"detections"`
}

// ClassifierDetectionResponse is the result of a classifier detection run.
type ClassifierDetectionResponse struct {
	// Detected is true when the run produced at least one classification.
	Detected bool `msgpack:"detected" json:"detected"`
	// Detections are the attribute/label pairs the classifier emitted.
	Detections []ClassifierDetection `msgpack:"detections" json:"detections"`
}

// ClipTextEmbeddingResult is the result of a CLIP text embedding request.
type ClipTextEmbeddingResult struct {
	// Embedding is the embedding vector for the query text.
	Embedding []float64 `msgpack:"embedding" json:"embedding"`
	// EmbeddingModel is the model that produced the embedding; consumers must
	// not mix models.
	EmbeddingModel string `msgpack:"embeddingModel" json:"embeddingModel"`
	// ScoreBand is the [floor, ceiling] of raw text-image cosine scores for
	// this model; consumers map scores to a 0..1 relevance scale and treat a
	// missing band as score 0.
	ScoreBand []float64 `msgpack:"scoreBand" json:"scoreBand"`
}

// DiscoveryProvider is implemented by plugins that can scan the network for
// new cameras and adopt them. Only plugins with a camera-controlling role
// (CameraController or CameraAndSensorProvider) are queried for discovery.
type DiscoveryProvider interface {
	// OnDiscoverCameras scans the network and returns the cameras the
	// plugin can offer for adoption. Called by the host on demand (UI
	// rescan button) or on a polling schedule.
	OnDiscoverCameras() ([]DiscoveredCamera, error)
	// OnGetCameraSettings returns a JSON schema describing the form fields
	// (credentials, transport options, ...) the user must fill in to adopt
	// this discovered camera.
	OnGetCameraSettings(camera DiscoveredCamera) ([]JsonSchema, error)
	// OnAdoptCamera probes the device with the user-provided settings and
	// returns the camera configuration the host should persist. The host
	// then creates the camera and invokes the plugin's OnCameraAdded.
	OnAdoptCamera(camera DiscoveredCamera, cameraSettings map[string]any) (map[string]any, error)
}

// MotionDetectionInterface is implemented by plugins that perform video-based
// motion detection. The host invokes TestMotion from the UI test panel and
// DetectMotion from automation / benchmark pipelines.
type MotionDetectionInterface interface {
	// TestMotion runs detection on a raw video buffer captured by the UI
	// test panel and returns the result for preview rendering.
	TestMotion(videoData []byte, config map[string]any) (*MotionDetectionResponse, error)
	// DetectMotion runs detection on already-decoded frames, supplied by
	// automation / benchmark pipelines to avoid re-encoding.
	DetectMotion(frames []VideoFrameData, config map[string]any) (*MotionDetectionResponse, error)
	// MotionSettings returns the JSON schema used to render the
	// motion-detection settings form in the UI, or nil for no schema.
	MotionSettings() ([]JsonSchema, error)
}

// ObjectDetectionInterface is implemented by plugins that perform object
// detection (person, vehicle, animal, ...).
type ObjectDetectionInterface interface {
	// TestObjects runs detection on a single image captured by the UI test
	// panel; metadata carries the image dimensions.
	TestObjects(imageData []byte, metadata ImageMetadata, config map[string]any) (*ObjectDetectionResponse, error)
	// DetectObjects runs detection on a pre-decoded video frame. Called
	// from automation / benchmark pipelines.
	DetectObjects(frame VideoFrameData, config map[string]any) (*ObjectDetectionResponse, error)
	// ObjectSettings returns the JSON schema used to render the
	// object-detection settings form in the UI, or nil for no schema.
	ObjectSettings() ([]JsonSchema, error)
}

// AudioDetectionInterface is implemented by plugins that perform audio event
// or keyword detection.
type AudioDetectionInterface interface {
	// TestAudio runs detection on an audio buffer captured by the UI test
	// panel; metadata carries the input MIME type.
	TestAudio(audioData []byte, metadata AudioMetadata, config map[string]any) (*AudioDetectionResponse, error)
	// DetectAudio runs detection on a pre-decoded audio frame. Called from
	// automation / benchmark pipelines.
	DetectAudio(audio AudioFrameData, config map[string]any) (*AudioDetectionResponse, error)
	// AudioSettings returns the JSON schema used to render the
	// audio-detection settings form in the UI, or nil for no schema.
	AudioSettings() ([]JsonSchema, error)
}

// FaceDetectionInterface is implemented by plugins that locate faces and emit
// per-face embeddings. The NVR owns matching against enrolled faces, the
// plugin only emits raw detections and embeddings.
type FaceDetectionInterface interface {
	// TestFaces runs face detection on a single image captured by the UI
	// test panel and returns the result for preview rendering.
	TestFaces(imageData []byte, metadata ImageMetadata, config map[string]any) (*FaceDetectionResponse, error)
	// DetectFaces runs face detection on a pre-decoded video frame.
	DetectFaces(frame VideoFrameData, config map[string]any) (*FaceDetectionResponse, error)
	// FaceSettings returns the JSON schema for the face-detection settings
	// form in the UI, or nil for no schema.
	FaceSettings() ([]JsonSchema, error)
}

// LicensePlateDetectionInterface is implemented by plugins that locate
// license plates and run OCR on them.
type LicensePlateDetectionInterface interface {
	// TestPlates runs detection on a single image captured by the UI test
	// panel and returns the result for preview rendering.
	TestPlates(imageData []byte, metadata ImageMetadata, config map[string]any) (*LicensePlateDetectionResponse, error)
	// DetectLicensePlates runs detection on a pre-decoded video frame.
	DetectLicensePlates(frame VideoFrameData, config map[string]any) (*LicensePlateDetectionResponse, error)
	// PlateSettings returns the JSON schema for the license-plate-detection
	// settings form in the UI, or nil for no schema.
	PlateSettings() ([]JsonSchema, error)
}

// ClassifierDetectionInterface is implemented by plugins that run a generic
// image classifier and emit attribute/label pairs (e.g. weather, scene,
// activity).
type ClassifierDetectionInterface interface {
	// TestClassifier runs classification on a single image captured by the
	// UI test panel and returns the result for preview rendering.
	TestClassifier(imageData []byte, metadata ImageMetadata, config map[string]any) (*ClassifierDetectionResponse, error)
	// DetectClassifications runs classification on a pre-decoded video frame.
	DetectClassifications(frame VideoFrameData, config map[string]any) (*ClassifierDetectionResponse, error)
	// ClassifierSettings returns the JSON schema for the
	// classifier-detection settings form in the UI, or nil for no schema.
	ClassifierSettings() ([]JsonSchema, error)
}

// ClipDetectionPluginResponse is the result of a CLIP image embedding run.
type ClipDetectionPluginResponse struct {
	// Embeddings are the embedding vectors generated for the input.
	Embeddings []ClipEmbedding `msgpack:"embeddings" json:"embeddings"`
	// EmbeddingModel is the model that produced the embeddings; consumers
	// must not mix models.
	EmbeddingModel string `msgpack:"embeddingModel" json:"embeddingModel"`
	// ScoreBand is the [floor, ceiling] of raw text-image cosine scores for
	// this model; consumers map scores to a 0..1 relevance scale and treat a
	// missing band as score 0.
	ScoreBand []float64 `msgpack:"scoreBand" json:"scoreBand"`
}

// ClipDetectionInterface is implemented by plugins that generate CLIP
// image and text embeddings used for semantic search over recorded events.
type ClipDetectionInterface interface {
	// TestClipEmbedding runs the CLIP image branch on a single image
	// captured by the UI test panel.
	TestClipEmbedding(imageData []byte, metadata ImageMetadata, config map[string]any) (*ClipDetectionPluginResponse, error)
	// DetectClipEmbedding runs the CLIP image branch on a pre-decoded
	// video frame.
	DetectClipEmbedding(frame VideoFrameData, config map[string]any) (*ClipDetectionPluginResponse, error)
	// EmbedImages runs the CLIP image branch over a batch of encoded images
	// (JPEG/PNG): one result per input in the same order, nil where decoding
	// or embedding failed. Meant for re-indexing stored images after an
	// embedding-model change.
	EmbedImages(images [][]byte, config map[string]any) ([]*ClipDetectionPluginResponse, error)
	// GetTextEmbedding runs the CLIP text branch and returns a vector usable
	// for semantic-search queries against stored image embeddings.
	GetTextEmbedding(text string) (*ClipTextEmbeddingResult, error)
	// GetTextEmbeddings runs the CLIP text branch once per embedding space
	// the plugin can currently serve, the configured search model first.
	// Lets semantic search also cover embeddings produced by an older model
	// during a transition.
	GetTextEmbeddings(text string) ([]*ClipTextEmbeddingResult, error)
	// ClipSettings returns the JSON schema for the CLIP settings form in
	// the UI, or nil for no schema.
	ClipSettings() ([]JsonSchema, error)
}
