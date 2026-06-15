package sdk

// DetectionEventState is the lifecycle state of a detection event.
type DetectionEventState = string

const (
	DetectionEventStateActive DetectionEventState = "active"
	DetectionEventStateEnded  DetectionEventState = "ended"
)

// EventTriggerType is the type of an event trigger.
type EventTriggerType = string

const (
	EventTriggerMotion         EventTriggerType = "motion"
	EventTriggerAudio          EventTriggerType = "audio"
	EventTriggerContact        EventTriggerType = "contact"
	EventTriggerDoorbell       EventTriggerType = "doorbell"
	EventTriggerSwitch         EventTriggerType = "switch"
	EventTriggerLight          EventTriggerType = "light"
	EventTriggerSiren          EventTriggerType = "siren"
	EventTriggerSecuritySystem EventTriggerType = "security_system"
	EventTriggerLineCrossing   EventTriggerType = "line-crossing"
)

// DetectionEventType is the lifecycle phase of a detection event message.
type DetectionEventType = string

const (
	DetectionEventStart         DetectionEventType = "start"
	DetectionEventEnd           DetectionEventType = "end"
	DetectionEventUpdate        DetectionEventType = "update"
	DetectionEventSegmentStart  DetectionEventType = "segment-start"
	DetectionEventSegmentUpdate DetectionEventType = "segment-update"
	DetectionEventSegmentEnd    DetectionEventType = "segment-end"
)

// EventDescription is an AI-generated description of a detection event.
type EventDescription struct {
	// Title is a brief title of what occurred.
	Title string `msgpack:"title" json:"title"`
	// Description is a chronological narrative of the scene.
	Description string `msgpack:"description" json:"description"`
	// Summary is a two-sentence notification-friendly summary.
	Summary string `msgpack:"summary" json:"summary"`
	// ThreatLevel is the threat level: 0 = normal, 1 = suspicious, 2 = threat.
	ThreatLevel int `msgpack:"threatLevel" json:"threatLevel"`
}

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
	// ExpectedEndTime is the expected event end time (Unix ms) — the latest dwell expiry across all
	// currently-active triggers. Monotonically non-decreasing during the event lifetime.
	// Updated on each update / segment-* message.
	ExpectedEndTime int64 `msgpack:"expectedEndTime,omitempty" json:"expectedEndTime,omitempty"`
	// Thumbnail is a full-frame downscaled JPEG captured at event start. Inline only
	// on the first message that delivers it (start or the first update); the NVR
	// plugin persists it and clients fetch it on demand via GetEventThumbnails.
	Thumbnail []byte `msgpack:"thumbnail,omitempty" json:"thumbnail,omitempty"`
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
	// Thumbnail is the best-selected JPEG scene thumbnail for this segment. Only present on 'end' events.
	Thumbnail []byte `msgpack:"thumbnail,omitempty" json:"thumbnail,omitempty"`
	// Detections are the object detections in this segment.
	Detections []EventDetection `msgpack:"detections" json:"detections"`
	// Attributes are unified attributes (faces, plates, classifications).
	Attributes []EventAttribute `msgpack:"attributes" json:"attributes"`
	// Zones lists the names of detection zones any detection in this segment overlapped (deduplicated).
	Zones []string `msgpack:"zones,omitempty" json:"zones,omitempty"`
	// Description is an AI-generated description for this segment.
	Description *EventDescription `msgpack:"description,omitempty" json:"description,omitempty"`
}

// EventDetection is an aggregated object detection within a segment.
type EventDetection struct {
	// Label is the detection label (e.g. "person", "car").
	Label string `msgpack:"label" json:"label"`
	// Score is the best confidence score.
	Score float64 `msgpack:"score" json:"score"`
	// MaxCount is the maximum simultaneous count in a single frame.
	MaxCount int `msgpack:"maxCount" json:"maxCount"`
	// Box is the bounding box of the highest-confidence detection (normalized 0-1).
	Box *BoundingBox `msgpack:"box,omitempty" json:"box,omitempty"`
	// Thumbnail is the best-selected JPEG thumbnail crop. Only present on 'end' events.
	Thumbnail []byte `msgpack:"thumbnail,omitempty" json:"thumbnail,omitempty"`
	// TrackID is the object tracker ID (links this detection across frames).
	TrackID int `msgpack:"trackId,omitempty" json:"trackId,omitempty"`
	// Moving indicates whether the object was moving (true) or stationary (false).
	Moving *bool `msgpack:"moving,omitempty" json:"moving,omitempty"`
}

// EventAttribute is a unified attribute within a segment (face identity, license plate, classifier result).
type EventAttribute struct {
	// Type is the attribute type ('face', 'license_plate', or classifier-specific like 'bird').
	Type string `msgpack:"type" json:"type"`
	// Label is the identity name, plate text, or classification label.
	Label string `msgpack:"label" json:"label"`
	// Confidence is the detection confidence (0-1).
	Confidence float64 `msgpack:"confidence,omitempty" json:"confidence,omitempty"`
	// Thumbnail is the best-selected JPEG thumbnail crop. Only present on 'end' events.
	Thumbnail []byte `msgpack:"thumbnail,omitempty" json:"thumbnail,omitempty"`
	// Embedding is the face embedding vector for unknown face persistence. Only present for face attributes.
	Embedding []float64 `msgpack:"embedding,omitempty" json:"embedding,omitempty"`
	// EmbeddingModel is the embedding model identifier. Only present for face attributes with embedding.
	EmbeddingModel string `msgpack:"embeddingModel,omitempty" json:"embeddingModel,omitempty"`
	// ClipEmbedding is the CLIP embedding vector for semantic search. Only present for clip attributes.
	ClipEmbedding []float64 `msgpack:"clipEmbedding,omitempty" json:"clipEmbedding,omitempty"`
	// ClipEmbeddingModel is the CLIP embedding model identifier. Only present for clip attributes with embedding.
	ClipEmbeddingModel string `msgpack:"clipEmbeddingModel,omitempty" json:"clipEmbeddingModel,omitempty"`
	// ParentTrackID is the parent object's tracker ID (links this attribute to its parent detection).
	ParentTrackID int `msgpack:"parentTrackId,omitempty" json:"parentTrackId,omitempty"`
}
