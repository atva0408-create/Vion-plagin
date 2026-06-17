package sdk

// FrameFormat identifies the pixel layout of a video frame.
type FrameFormat string

// Supported video frame pixel formats.
const (
	FrameFormatNV12 FrameFormat = "nv12" // YUV 4:2:0 semi-planar
	FrameFormatRGB  FrameFormat = "rgb"  // 3 bytes/pixel interleaved
	FrameFormatRGBA FrameFormat = "rgba" // 4 bytes/pixel interleaved
	FrameFormatGray FrameFormat = "gray" // 1 byte/pixel grayscale
)

// DetectionLabel is a label identifying a type of detection.
type DetectionLabel = string

// DetectionLabels lists the built-in detection label types recognized across the system.
var DetectionLabels = []string{
	"motion", "person", "vehicle", "animal",
	"package", "audio",
}

// DetectionAttribute identifies the kind of a sub-detection (face, license plate, ...).
type DetectionAttribute = string

// DetectionAttributes lists the built-in detection attribute types.
var DetectionAttributes = []string{"face", "license_plate"}

// KnownEventTypes is the set of standard event types (detection labels + attributes + trigger types).
// Used to identify "other" (classifier-produced) types that fall outside this set.
var KnownEventTypes = func() map[string]struct{} {
	m := make(map[string]struct{})
	for _, l := range DetectionLabels {
		m[l] = struct{}{}
	}
	for _, a := range DetectionAttributes {
		m[a] = struct{}{}
	}
	for _, t := range []string{
		EventTriggerMotion, EventTriggerAudio, EventTriggerContact,
		EventTriggerDoorbell, EventTriggerSwitch, EventTriggerLight,
		EventTriggerSiren, EventTriggerSecuritySystem,
	} {
		m[t] = struct{}{}
	}
	return m
}()

// BoundingBox is the bounding box of a detection. All coordinates are
// normalized to 0-1 (fraction of frame dimensions), so they are independent
// of resolution.
type BoundingBox struct {
	X      float64 `msgpack:"x" json:"x"`           // X coordinate of the top-left corner (0-1)
	Y      float64 `msgpack:"y" json:"y"`           // Y coordinate of the top-left corner (0-1)
	Width  float64 `msgpack:"width" json:"width"`   // Width as a fraction of frame width (0-1)
	Height float64 `msgpack:"height" json:"height"` // Height as a fraction of frame height (0-1)
}

// Detection is a single detection result emitted by any detection sensor.
type Detection struct {
	Label      string       `msgpack:"label" json:"label"`                             // Detection label (e.g. "person", "vehicle")
	Confidence float64      `msgpack:"confidence" json:"confidence"`                   // Confidence score in the range 0-1
	Box        *BoundingBox `msgpack:"box,omitempty" json:"box,omitempty"`             // Bounding box in normalized coordinates
	Attribute  string       `msgpack:"attribute,omitempty" json:"attribute,omitempty"` // Optional sub-detection attribute (face, license_plate, or classifier-specific)
}

// VideoFrameData is the video frame payload delivered to detector sensors by
// the backend pipeline. The backend handles capture, decoding, and scaling —
// detectors only need to process the pixel buffer.
type VideoFrameData struct {
	ID        string      `msgpack:"id" json:"id"`                           // Unique frame or crop identifier used to map batch results back to inputs
	CameraID  string      `msgpack:"cameraId" json:"cameraId"`               // Camera the frame originated from
	Data      []byte      `msgpack:"data" json:"data"`                       // Raw pixel buffer
	Width     int         `msgpack:"width" json:"width"`                     // Frame width in pixels
	Height    int         `msgpack:"height" json:"height"`                   // Frame height in pixels
	Format    FrameFormat `msgpack:"format" json:"format"`                   // Pixel format (nv12, rgb, rgba, gray)
	Timestamp int64       `msgpack:"timestamp" json:"timestamp"`             // Capture timestamp in milliseconds since epoch
	Label     string      `msgpack:"label,omitempty" json:"label,omitempty"` // Trigger label propagated by the coordinator for secondary detectors
}
