package sdk

// DetectionZone is a polygon zone that restricts or drops detections.
type DetectionZone struct {
	// Name is the zone display name.
	Name string `msgpack:"name" json:"name"`
	// Points are the polygon points (0-100 percentage coordinates).
	Points []Point `msgpack:"points" json:"points"`
	// Type is the intersection detection type.
	Type ZoneType `msgpack:"type" json:"type"`
	// Filter is the include/exclude filter mode.
	Filter ZoneFilter `msgpack:"filter" json:"filter"`
	// Labels are the labels to filter (empty = all labels).
	Labels []DetectionLabel `msgpack:"labels" json:"labels"`
	// IsPrivacyMask indicates an ignore zone: detections fully inside it are dropped.
	IsPrivacyMask bool `msgpack:"isPrivacyMask" json:"isPrivacyMask"`
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

// MotionDetectionSettings is motion detection configuration.
type MotionDetectionSettings struct {
	// Resolution is the detection resolution quality.
	Resolution MotionResolution `msgpack:"resolution" json:"resolution"`
	// Timeout is the motion dwell time in seconds.
	Timeout int `msgpack:"timeout" json:"timeout"`
}

// ObjectDetectionSettings is object detection configuration.
type ObjectDetectionSettings struct {
	// Confidence is the minimum confidence threshold (0.3 - 1.0).
	Confidence float64 `msgpack:"confidence" json:"confidence"`
	// SuppressStatic suppresses events from objects that stay stationary across events (e.g. parked cars). Defaults to true.
	SuppressStatic *bool `msgpack:"suppressStatic,omitempty" json:"suppressStatic,omitempty"`
}

// AudioDetectionSettings is audio detection configuration.
type AudioDetectionSettings struct {
	// MinDecibels is the minimum volume threshold in dBFS (-100 to 0). Audio below this level is skipped.
	MinDecibels float64 `msgpack:"minDecibels" json:"minDecibels"`
	// Timeout is the audio dwell time in seconds.
	Timeout int `msgpack:"timeout" json:"timeout"`
}

// SensorTriggerRef is a stable reference to a sensor for cascade trigger configuration.
// Uses composite key (sensorType + sensorName + pluginId) instead of UUID
// so references survive plugin restarts.
type SensorTriggerRef struct {
	// SensorType is the sensor type (e.g. "contact", "doorbell").
	SensorType SensorType `msgpack:"sensorType" json:"sensorType"`
	// SensorName is the sensor name (stable across restarts).
	SensorName string `msgpack:"sensorName" json:"sensorName"`
	// PluginID is the plugin ID that provides this sensor.
	PluginID string `msgpack:"pluginId" json:"pluginId"`
}

// SensorTriggerSettings is configuration for sensor cascade triggers (contact, doorbell, switch, light, etc.).
type SensorTriggerSettings struct {
	// Timeout is the sensor trigger timeout in seconds.
	Timeout int `msgpack:"timeout" json:"timeout"`
	// Triggers are sensors that also trigger the detection cascade (in addition to motion/audio).
	Triggers []SensorTriggerRef `msgpack:"triggers" json:"triggers"`
}

// FaceDetectionSettings is the face detection settings.
type FaceDetectionSettings struct {
	// Confidence is the minimum confidence threshold (0 - 1) for a face to count.
	Confidence float64 `msgpack:"confidence,omitempty" json:"confidence,omitempty"`
}

// LicensePlateDetectionSettings is the license plate detection settings.
type LicensePlateDetectionSettings struct {
	// Confidence is the minimum text recognition confidence (0 - 1) for a plate read to count.
	Confidence float64 `msgpack:"confidence,omitempty" json:"confidence,omitempty"`
	// MinLength is the minimum plate text length, shorter reads are dropped as fragments.
	MinLength int `msgpack:"minLength,omitempty" json:"minLength,omitempty"`
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
	CascadeTimeout int `msgpack:"cascadeTimeout,omitempty" json:"cascadeTimeout,omitempty"`
	// Snooze indicates whether detections are snoozed (paused).
	Snooze bool `msgpack:"snooze,omitempty" json:"snooze,omitempty"`
}

// PtzAutotrackSettings configures automatic PTZ tracking of detected objects.
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
}
