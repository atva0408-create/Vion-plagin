package sdk

// PropertyChangeEvent is emitted when a camera property changes.
type PropertyChangeEvent struct {
	// Property is the json name of the changed camera field.
	Property string
	// OldCamera is the camera state before the change.
	OldCamera Camera
	// NewCamera is the camera state after the change.
	NewCamera Camera
}

// DetectionEventData wraps a detection event with its lifecycle type.
type DetectionEventData struct {
	// Type is the lifecycle phase of the message.
	Type DetectionEventType
	// Event is the aggregated detection event.
	Event DetectionEvent
}

// SensorPropertyChange is emitted when a sensor property value changes.
type SensorPropertyChange struct {
	// Property is the property name.
	Property string
	// Value is the new property value.
	Value any
	// Timestamp is when the value was set (Unix ms).
	Timestamp int64
}
