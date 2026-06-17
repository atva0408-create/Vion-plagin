package sdk

// ImageMetadata is image metadata passed to detector test methods.
type ImageMetadata struct {
	Width  int `msgpack:"width" json:"width"`
	Height int `msgpack:"height" json:"height"`
}

// AudioMetadata is audio metadata passed to audio detector test methods.
type AudioMetadata struct {
	MimeType string `msgpack:"mimeType" json:"mimeType"`
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
	// this specific discovered camera.
	OnGetCameraSettings(camera DiscoveredCamera) ([]JsonSchema, error)
	// OnAdoptCamera probes the device with the user-provided settings and
	// returns the camera configuration the host should persist. The host
	// then creates the camera and invokes the plugin's OnCameraAdded.
	OnAdoptCamera(camera DiscoveredCamera, cameraSettings map[string]any) (map[string]any, error)
}

// MotionDetectionInterface is implemented by plugins that perform video-based
// motion detection. The host invokes TestMotion from the UI test panel and
// DetectMotion from automation / benchmarking pipelines.
type MotionDetectionInterface interface {
	// TestMotion runs detection on a raw video buffer captured by the UI
	// test panel and returns the result for preview rendering.
	TestMotion(videoData []byte, config map[string]any) (*MotionDetectionResponse, error)
	// DetectMotion runs detection on already-decoded VideoFrameData.
	// Called from automation / benchmark pipelines that supply pre-decoded
	// frames directly to avoid re-encoding.
	DetectMotion(frames []VideoFrameData, config map[string]any) (*MotionDetectionResponse, error)
	// MotionSettings returns the JSON schema used to render the
	// motion-detection settings form in the UI. Return nil for no schema.
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
	// object-detection settings form in the UI. Return nil for no schema.
	ObjectSettings() ([]JsonSchema, error)
}

// AudioDetectionInterface is implemented by plugins that perform audio event
// or keyword detection.
type AudioDetectionInterface interface {
	// TestAudio runs detection on an audio buffer captured by the UI test
	// panel; metadata carries the input MIME type (mpeg/wav/ogg).
	TestAudio(audioData []byte, metadata AudioMetadata, config map[string]any) (*AudioDetectionResponse, error)
	// AudioSettings returns the JSON schema used to render the
	// audio-detection settings form in the UI. Return nil for no schema.
	AudioSettings() ([]JsonSchema, error)
}

// FaceDetectionInterface is implemented by plugins that locate faces and
// emit per-face embeddings. The NVR owns matching against enrolled faces;
// the plugin only emits raw detections + embeddings.
type FaceDetectionInterface interface {
	// TestFaces runs face detection on a single image captured by the UI
	// test panel and returns the result for preview rendering.
	TestFaces(imageData []byte, metadata ImageMetadata, config map[string]any) (*FaceDetectionResponse, error)
	// DetectFaces runs face detection on a pre-decoded video frame.
	DetectFaces(frame VideoFrameData, config map[string]any) (*FaceDetectionResponse, error)
	// FaceSettings returns the JSON schema for the face-detection settings
	// form in the UI. Return nil for no schema.
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
	// settings form in the UI. Return nil for no schema.
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
	// classifier-detection settings form in the UI. Return nil for no
	// schema.
	ClassifierSettings() ([]JsonSchema, error)
}

// ClipTextEmbeddingResult is the return type for
// ClipDetectionInterface.GetTextEmbedding — a single embedding vector plus
// the model name used to produce it (so downstream code can refuse to mix
// embeddings from different models).
type ClipTextEmbeddingResult struct {
	Embedding      []float64 `msgpack:"embedding" json:"embedding"`
	EmbeddingModel string    `msgpack:"embeddingModel" json:"embeddingModel"`
}

// ClipDetectionInterface is implemented by plugins that generate CLIP
// image and text embeddings used for semantic search over recorded events.
type ClipDetectionInterface interface {
	// TestClipEmbedding runs the CLIP image branch on a single image
	// captured by the UI test panel.
	TestClipEmbedding(imageData []byte, metadata ImageMetadata, config map[string]any) (*ClipResult, error)
	// DetectClipEmbedding runs the CLIP image branch on a pre-decoded
	// video frame.
	DetectClipEmbedding(frame VideoFrameData, config map[string]any) (*ClipResult, error)
	// GetTextEmbedding runs the CLIP text branch and returns a single
	// embedding vector usable for semantic-search queries against
	// previously stored image embeddings.
	GetTextEmbedding(text string) (*ClipTextEmbeddingResult, error)
	// ClipSettings returns the JSON schema for the CLIP settings form in
	// the UI. Return nil for no schema.
	ClipSettings() ([]JsonSchema, error)
}

// MotionDetectionResponse is the result of a motion detection run. VideoData
// optionally carries an annotated re-encoded clip for the UI test panel.
type MotionDetectionResponse struct {
	Detected   bool        `msgpack:"detected" json:"detected"`
	Detections []Detection `msgpack:"detections" json:"detections"`
	VideoData  []byte      `msgpack:"videoData,omitempty" json:"videoData,omitempty"`
}

// ObjectDetectionResponse is the result of an object detection run.
type ObjectDetectionResponse struct {
	Detected   bool        `msgpack:"detected" json:"detected"`
	Detections []Detection `msgpack:"detections" json:"detections"`
}

// AudioDetectionResponse is the result of an audio detection run. Decibels
// is optional and reports the measured loudness when the plugin computes it.
type AudioDetectionResponse struct {
	Detected   bool        `msgpack:"detected" json:"detected"`
	Detections []Detection `msgpack:"detections" json:"detections"`
	Decibels   float64     `msgpack:"decibels,omitempty" json:"decibels,omitempty"`
}

// FaceDetectionResponse is the result of a face detection run.
// EmbeddingModel names the model that produced the embeddings so the NVR can
// refuse to mix different models when matching.
type FaceDetectionResponse struct {
	Detected       bool            `msgpack:"detected" json:"detected"`
	Detections     []FaceDetection `msgpack:"detections" json:"detections"`
	EmbeddingModel string          `msgpack:"embeddingModel,omitempty" json:"embeddingModel,omitempty"`
}

// LicensePlateDetectionResponse is the result of a license plate detection
// run.
type LicensePlateDetectionResponse struct {
	Detected   bool                    `msgpack:"detected" json:"detected"`
	Detections []LicensePlateDetection `msgpack:"detections" json:"detections"`
}

// ClassifierDetectionResponse is the result of a classifier detection run.
type ClassifierDetectionResponse struct {
	Detected   bool                  `msgpack:"detected" json:"detected"`
	Detections []ClassifierDetection `msgpack:"detections" json:"detections"`
}
