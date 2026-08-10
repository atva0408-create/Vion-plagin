package sdk

// DetectionEvent is an aggregated detection event with lifecycle (start -> update -> end).
// Groups individual sensor detections into structured events.
type DetectionEvent struct {
	// ID is the unique event ID.
	ID string `msgpack:"id" json:"id"`
	// CameraID is the camera that produced this event.
	CameraID string `msgpack:"cameraId" json:"cameraId"`
	// State is the event lifecycle state.
	State DetectionEventState `msgpack:"state" json:"state"`
	// StartTime is the event start time (Unix ms).
	StartTime int64 `msgpack:"startTime" json:"startTime"`
	// EndTime is the event end time (Unix ms, only when ended).
	EndTime int64 `msgpack:"endTime,omitempty" json:"endTime,omitempty"`
	// LastUpdate is the last activity timestamp (Unix ms).
	LastUpdate int64 `msgpack:"lastUpdate" json:"lastUpdate"`
	// Types lists the detection types present in this event (for filtering).
	Types []string `msgpack:"types" json:"types"`
	// Triggers are the event triggers (motion/audio/sensor/line-crossing).
	Triggers []EventTrigger `msgpack:"triggers" json:"triggers"`
	// Segments are detection segments (object detection phases).
	// For segment-* messages: contains only the current segment.
	// For start/end messages: empty.
	Segments []EventSegment `msgpack:"segments" json:"segments"`
	// SegmentIndex is the index of the segment in segments[0] for segment-* messages.
	SegmentIndex int `msgpack:"segmentIndex,omitempty" json:"segmentIndex,omitempty"`
	// ExpectedEndTime is the expected event end time (Unix ms): the latest dwell expiry across all
	// currently-active triggers. Monotonically non-decreasing during the event lifetime.
	// Updated on each update / segment-* message.
	ExpectedEndTime int64 `msgpack:"expectedEndTime,omitempty" json:"expectedEndTime,omitempty"`
}

// EventTrigger is an event trigger (motion, audio, sensor, or line-crossing).
type EventTrigger struct {
	// Type is the trigger type.
	Type EventTriggerType `msgpack:"type" json:"type"`
	// Label is the audio label (e.g. "doorbell", "glass_break").
	Label string `msgpack:"label,omitempty" json:"label,omitempty"`
	// Score is the best confidence score.
	Score float64 `msgpack:"score,omitempty" json:"score,omitempty"`
	// FirstSeen is the first detection time (Unix ms).
	FirstSeen int64 `msgpack:"firstSeen" json:"firstSeen"`
	// LastSeen is the last detection time (Unix ms).
	LastSeen int64 `msgpack:"lastSeen" json:"lastSeen"`
	// LineName is the name of the crossed line (only for line-crossing triggers).
	LineName string `msgpack:"lineName,omitempty" json:"lineName,omitempty"`
	// CrossingDirection is the crossing direction (only for line-crossing triggers).
	CrossingDirection string `msgpack:"crossingDirection,omitempty" json:"crossingDirection,omitempty"`
	// TrackID is the track ID of the object that crossed (only for line-crossing triggers).
	TrackID int `msgpack:"trackId,omitempty" json:"trackId,omitempty"`
}

// EventSegment is a contiguous object detection phase within an event.
type EventSegment struct {
	// FirstSeen is the segment start time (Unix ms).
	FirstSeen int64 `msgpack:"firstSeen" json:"firstSeen"`
	// LastSeen is the segment end time (Unix ms).
	LastSeen int64 `msgpack:"lastSeen" json:"lastSeen"`
	// Detections are the object detections in this segment.
	Detections []EventDetection `msgpack:"detections" json:"detections"`
	// Attributes are unified attributes (faces, plates, classifications).
	Attributes []EventAttribute `msgpack:"attributes" json:"attributes"`
	// Zones lists the names of detection zones any detection in this segment overlapped (deduplicated).
	Zones []string `msgpack:"zones,omitempty" json:"zones,omitempty"`
}

// EventDetection is an aggregated object detection within a segment.
type EventDetection struct {
	// Label is the detection label (e.g. "person", "car").
	Label string `msgpack:"label" json:"label"`
	// Score is the best confidence score.
	Score float64 `msgpack:"score" json:"score"`
	// MaxCount is the maximum simultaneous count in a single frame.
	MaxCount int `msgpack:"maxCount" json:"maxCount"`
	// Moving indicates whether the object was moving (true) or stationary (false).
	Moving *bool `msgpack:"moving,omitempty" json:"moving,omitempty"`
	// Path is where the tracked object entered and left the frame within this segment.
	Path *DetectionPath `msgpack:"path,omitempty" json:"path,omitempty"`
}

// DetectionPath holds the normalized box centers (0-1) of a tracked object's
// first and last sighting in a segment.
type DetectionPath struct {
	EnterX float64 `msgpack:"enterX" json:"enterX"`
	EnterY float64 `msgpack:"enterY" json:"enterY"`
	ExitX  float64 `msgpack:"exitX" json:"exitX"`
	ExitY  float64 `msgpack:"exitY" json:"exitY"`
}

// EventAttribute is a unified attribute within a segment (face identity, license plate, classifier result).
type EventAttribute struct {
	// Type is the attribute type ('face', 'license_plate', or classifier-specific like 'bird').
	Type string `msgpack:"type" json:"type"`
	// Label is the identity name, plate text, or classification label.
	Label string `msgpack:"label" json:"label"`
	// Confidence is the detection confidence (0-1).
	Confidence float64 `msgpack:"confidence,omitempty" json:"confidence,omitempty"`
}
