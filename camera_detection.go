package sdk

// MotionZone is a polygon zone that says where frame motion counts. Motion
// carries no labels, so a motion zone has none. No motion zone at all means
// motion counts everywhere.
type MotionZone struct {
	// Name is the zone display name.
	Name string `msgpack:"name" json:"name"`
	// Points are the polygon points (0-100 percentage coordinates).
	Points []Point `msgpack:"points" json:"points"`
	// Color is the zone display color (hex).
	Color string `msgpack:"color" json:"color"`
}

// ZoneLabel is what an object zone can list: a detection label, or an attribute
// that gates identification.
type ZoneLabel = string

// ObjectZone is a polygon zone that says which object types count where. With
// at least one include object zone, an object counts only inside such a zone
// and only when its label is listed there.
type ObjectZone struct {
	// Name is the zone display name.
	Name string `msgpack:"name" json:"name"`
	// Points are the polygon points (0-100 percentage coordinates).
	Points []Point `msgpack:"points" json:"points"`
	// Type is the intersection detection type.
	Type ZoneType `msgpack:"type" json:"type"`
	// Labels are the labels that count in this zone. Besides the detection labels,
	// "face" and "license_plate" decide whether an object here is identified at
	// all, so a zone can watch a street without recognizing anyone on it.
	Labels []ZoneLabel `msgpack:"labels" json:"labels"`
	// Color is the zone display color (hex).
	Color string `msgpack:"color" json:"color"`
}

// PrivacyZone is a polygon zone camera.ui covers in live view, playback and
// its pictures. DropDetections decides whether detections inside are dropped
// too or whether the camera keeps watching an area it does not show.
type PrivacyZone struct {
	// Name is the zone display name.
	Name string `msgpack:"name" json:"name"`
	// Points are the polygon points (0-100 percentage coordinates).
	Points []Point `msgpack:"points" json:"points"`
	// DropDetections drops detections inside the zone. Default: true.
	DropDetections bool `msgpack:"dropDetections" json:"dropDetections"`
}

// PrivacyFallback decides what happens to a picture whose privacy zones could
// not be applied, for example on a pixel format we cannot write.
type PrivacyFallback = string

// Supported privacy fallbacks.
const (
	PrivacyFallbackSend PrivacyFallback = "send" // ship it unmasked, the user can delete it
	PrivacyFallbackDrop PrivacyFallback = "drop" // no picture at all rather than an unmasked one
)

// CameraZones holds everything the zone editor draws, one list per purpose.
// Motion decides where frame motion counts, Object which types count where,
// Privacy where nothing is looked at, Alert which types notify from where,
// and Lines reports objects crossing them.
type CameraZones struct {
	// PrivacyFallback decides what happens to a picture the privacy zones could not be applied to.
	PrivacyFallback PrivacyFallback `msgpack:"privacyFallback" json:"privacyFallback"`
	Motion          []MotionZone    `msgpack:"motion" json:"motion"`
	Object          []ObjectZone    `msgpack:"object" json:"object"`
	Privacy         []PrivacyZone   `msgpack:"privacy" json:"privacy"`
	Alert           []AlertZone     `msgpack:"alert" json:"alert"`
	Lines           []DetectionLine `msgpack:"lines" json:"lines"`
}

// AlertZoneMatch decides when an object counts as inside an alert zone.
type AlertZoneMatch = string

// Supported alert zone match modes.
const (
	AlertZoneMatchAnchor    AlertZoneMatch = "anchor"    // where the object stands (bottom center of its box)
	AlertZoneMatchIntersect AlertZoneMatch = "intersect" // its box touches the zone
	AlertZoneMatchContain   AlertZoneMatch = "contain"   // its box lies fully inside the zone
)

// AlertZone is a polygon zone that never filters detections: a label
// selected here only sends push notifications while an object of that
// label is inside the zone.
type AlertZone struct {
	// Name is the zone display name.
	Name string `msgpack:"name" json:"name"`
	// Points are the polygon points (0-100 percentage coordinates).
	Points []Point `msgpack:"points" json:"points"`
	// Labels are the labels that alert from inside this zone (empty = every label alerts here).
	Labels []DetectionLabel `msgpack:"labels" json:"labels"`
	// Faces are the faces that may push from inside this zone. Nil leaves faces out
	// of the decision, an empty list lets every recognized face push, otherwise only
	// the listed identities do. "unknown" covers everyone the recognition could not
	// name, including people whose face was never captured.
	Faces *[]string `msgpack:"faces,omitempty" json:"faces,omitempty"`
	// Plates are the plates that may push from inside this zone, same rules as Faces.
	// Plates are OCR text, so the list is free-form rather than picked from a roster.
	Plates *[]string `msgpack:"plates,omitempty" json:"plates,omitempty"`
	// Match decides when an object counts as inside. Default: contain.
	Match AlertZoneMatch `msgpack:"match" json:"match"`
	// Color is the zone display color (hex).
	Color string `msgpack:"color" json:"color"`
}

// DetectionLine is a virtual tripwire for line crossing detection.
// The two points define grab-handle positions; the actual crossing line
// is perpendicular through their midpoint.
type DetectionLine struct {
	// Name is the line display name.
	Name string `msgpack:"name" json:"name"`
	// Points are the grab-handle positions (0-100%). The crossing line is perpendicular through the midpoint.
	Points [2]Point `msgpack:"points" json:"points"`
	// Direction controls which crossing direction(s) trigger events.
	Direction LineDirection `msgpack:"direction" json:"direction"`
	// Labels are the labels to filter (empty = all labels).
	Labels []DetectionLabel `msgpack:"labels" json:"labels"`
	// Color is the line display color (hex).
	Color string `msgpack:"color" json:"color"`
}

// MotionDetectionSettings is the motion detection settings.
type MotionDetectionSettings struct {
	// Resolution is the detection resolution quality.
	Resolution MotionResolution `msgpack:"resolution" json:"resolution"`
	// Timeout is the motion dwell time in seconds.
	Timeout int `msgpack:"timeout" json:"timeout"`
}

// ObjectDetectionSettings is the object detection settings.
type ObjectDetectionSettings struct {
	// Confidence is the minimum confidence threshold (0.3 - 1.0).
	Confidence float64 `msgpack:"confidence" json:"confidence"`
	// SuppressStatic suppresses events from objects that stay stationary across events (e.g. parked cars). Defaults to true.
	SuppressStatic *bool `msgpack:"suppressStatic,omitempty" json:"suppressStatic,omitempty"`
	// Timeout is the object dwell time in seconds for camera-based object sensors that
	// report a detection without a matching end report. Frame-based detection ignores this. Defaults to 15.
	Timeout *int `msgpack:"timeout,omitempty" json:"timeout,omitempty"`
}

// AudioDetectionSettings is the audio detection settings.
type AudioDetectionSettings struct {
	// MinDecibels is the minimum volume threshold in dBFS (-100 to 0). Audio below this level is skipped.
	MinDecibels float64 `msgpack:"minDecibels" json:"minDecibels"`
	// Timeout is the audio dwell time in seconds.
	Timeout int `msgpack:"timeout" json:"timeout"`
	// Confidence is the minimum confidence threshold (0 - 1) for a labelled audio detection to count.
	Confidence *float64 `msgpack:"confidence,omitempty" json:"confidence,omitempty"`
}

// SensorTriggerSettings is the sensor trigger settings (contact, doorbell,
// switch, light, etc.).
type SensorTriggerSettings struct {
	// Timeout is the sensor trigger timeout in seconds.
	Timeout int `msgpack:"timeout" json:"timeout"`
	// Triggers are sensor entity ids that also trigger the detection cascade (in addition to motion/audio).
	Triggers []string `msgpack:"triggers" json:"triggers"`
}

// FaceDetectionSettings is the face detection settings.
type FaceDetectionSettings struct {
	// Confidence is the minimum confidence threshold (0 - 1) for a face to count.
	Confidence *float64 `msgpack:"confidence,omitempty" json:"confidence,omitempty"`
}

// LicensePlateDetectionSettings is the license plate detection settings.
type LicensePlateDetectionSettings struct {
	// Confidence is the minimum text recognition confidence (0 - 1) for a plate read to count.
	Confidence *float64 `msgpack:"confidence,omitempty" json:"confidence,omitempty"`
	// MinLength is the minimum plate text length, shorter reads are dropped as fragments.
	MinLength *int `msgpack:"minLength,omitempty" json:"minLength,omitempty"`
}

// CameraDetectionSettings is the combined detection settings for a camera.
type CameraDetectionSettings struct {
	// Motion is the motion detection settings.
	Motion MotionDetectionSettings `msgpack:"motion" json:"motion"`
	// Object is the object detection settings.
	Object ObjectDetectionSettings `msgpack:"object" json:"object"`
	// Audio is the audio detection settings.
	Audio AudioDetectionSettings `msgpack:"audio" json:"audio"`
	// Face is the face detection settings.
	Face *FaceDetectionSettings `msgpack:"face,omitempty" json:"face,omitempty"`
	// LicensePlate is the license plate detection settings.
	LicensePlate *LicensePlateDetectionSettings `msgpack:"licensePlate,omitempty" json:"licensePlate,omitempty"`
	// Sensor is the sensor trigger settings.
	Sensor SensorTriggerSettings `msgpack:"sensor" json:"sensor"`
	// CascadeDetection enables the detection cascade.
	CascadeDetection *bool `msgpack:"cascadeDetection,omitempty" json:"cascadeDetection,omitempty"`
	// CascadeTimeout is the cascade hold-open window in seconds.
	CascadeTimeout *int `msgpack:"cascadeTimeout,omitempty" json:"cascadeTimeout,omitempty"`
	// Snooze indicates whether detections are snoozed (paused).
	Snooze bool `msgpack:"snooze,omitempty" json:"snooze,omitempty"`
}

// PtzAutotrackSettings is the PTZ autotracking settings: the camera follows
// detected objects automatically.
type PtzAutotrackSettings struct {
	// Enabled toggles PTZ autotracking.
	Enabled bool `msgpack:"enabled" json:"enabled"`
	// TargetLabels are the object labels to track (e.g. "person", "vehicle").
	TargetLabels []string `msgpack:"targetLabels" json:"targetLabels"`
	// MinConfidence is the minimum detection confidence to track (0.3 - 1.0).
	MinConfidence float64 `msgpack:"minConfidence" json:"minConfidence"`
	// TriggerDeadZone is the dead zone around frame center (0 - 0.3).
	// No motor command is issued while the target is inside this zone.
	TriggerDeadZone float64 `msgpack:"triggerDeadZone" json:"triggerDeadZone"`
	// TrackingSpeed is how aggressively the camera moves to re-center the target (1 - 5).
	// Higher reaches full pan/tilt speed at a smaller off-center error.
	TrackingSpeed float64 `msgpack:"trackingSpeed" json:"trackingSpeed"`
	// LeadMs is the motion prediction (0 - 4000): aim this many milliseconds ahead
	// along the target's measured velocity, covering the time the camera needs to
	// move and settle. 0 disables prediction.
	LeadMs float64 `msgpack:"leadMs" json:"leadMs"`
	// PanRate is the camera pan-rate calibration (0.1 - 3): assumed pan travel at
	// full motor speed in normalized frame-widths per second. Lower it if the
	// camera stops short of the target, raise it if it overshoots.
	PanRate float64 `msgpack:"panRate" json:"panRate"`
	// ReturnToHome enables returning to the home position when no target is found for HomeWaitMs.
	ReturnToHome bool `msgpack:"returnToHome" json:"returnToHome"`
	// HomeWaitMs is how long to wait (ms) without a target before returning home.
	HomeWaitMs int `msgpack:"homeWaitMs" json:"homeWaitMs"`
	// MinTargetSize is the smallest target to start following, as a fraction of
	// the frame height (0 - 0.5). 0 disables the limit.
	MinTargetSize *float64 `msgpack:"minTargetSize,omitempty" json:"minTargetSize,omitempty"`
	// MaxTargetSize is the largest target to keep following, as a fraction of the
	// frame height (0 - 1). Above it the camera holds its position. 0 disables the limit.
	MaxTargetSize *float64 `msgpack:"maxTargetSize,omitempty" json:"maxTargetSize,omitempty"`
	// ActiveHours are the hours the camera is allowed to follow. Outside them
	// autotracking rests.
	ActiveHours *TimeWindow `msgpack:"activeHours,omitempty" json:"activeHours,omitempty"`
}

// TimeWindow is a daily time window, given in the timezone it was configured in.
type TimeWindow struct {
	// From is the start time as "HH:mm".
	From string `msgpack:"from" json:"from"`
	// To is the end time as "HH:mm". A time before From wraps around midnight.
	To string `msgpack:"to" json:"to"`
	// Timezone is the IANA timezone the times are read in, e.g. "Europe/Berlin".
	Timezone string `msgpack:"timezone" json:"timezone"`
}
