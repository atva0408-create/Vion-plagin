package sdk

// PropertyChangeEvent is emitted when a camera property changes.
type PropertyChangeEvent struct {
	Property  string
	OldCamera Camera
	NewCamera Camera
}

type sensorEvent struct {
	SensorID   string
	SensorType SensorType
}

// DetectionEventData wraps a detection event with its lifecycle type.
type DetectionEventData struct {
	Type  DetectionEventType
	Event DetectionEvent
}

// SensorPropertyChange is emitted when a sensor property value changes.
type SensorPropertyChange struct {
	Property  string
	Value     any
	Timestamp int64
}
