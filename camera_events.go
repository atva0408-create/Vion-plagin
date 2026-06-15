package sdk

// PropertyChangeEvent is emitted when a camera property changes.
type PropertyChangeEvent struct {
	// Property is the JSON name of the property that changed.
	Property string
	// OldCamera is the camera snapshot before the change.
	OldCamera Camera
	// NewCamera is the camera snapshot after the change.
	NewCamera Camera
}

// sensorEvent is emitted when a sensor from another plugin is added or removed.
type sensorEvent struct {
	SensorID   string
	SensorType SensorType
}

// DetectionEventData wraps a detection event with its lifecycle type.
// Emitted to OnDetectionEvent subscribers for each start/update/end/segment-* message.
type DetectionEventData struct {
	Type  DetectionEventType
	Event DetectionEvent
}

// SensorPropertyChange is emitted when a sensor property value changes.
type SensorPropertyChange struct {
	Property string
	Value    any
	// Timestamp is the Unix milliseconds timestamp from the server propertyChangedEvent.
	Timestamp int64
}
