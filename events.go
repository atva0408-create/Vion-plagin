package sdk

// This file defines the internal RPC payload types exchanged between the
// host and plugins on the various event subjects declared in namespaces.go.
// Plugin authors typically do not construct these directly; they are
// produced/consumed by the SDK runtime when bridging RPC events into
// typed callbacks.

// cameraEventMessage is the internal RPC payload for a camera lifecycle
// event published by the host.
type cameraEventMessage struct {
	Type string `msgpack:"type"`
	Data any    `msgpack:"data,omitempty"`
}

// sensorControllerEventMessage is the internal RPC payload for a
// sensor-controller event (sensor added/removed/refreshed/etc.).
type sensorControllerEventMessage struct {
	Type string `msgpack:"type"`
	Data any    `msgpack:"data,omitempty"`
}

// sensorAddedEventData is the internal RPC payload for a "sensor:added"
// event.
type sensorAddedEventData struct {
	Sensor storedSensorData   `msgpack:"sensor"`
	State  sensorInitialState `msgpack:"state"`
}

// sensorRemovedEventData is the internal RPC payload for a
// "sensor:removed" event.
type sensorRemovedEventData struct {
	SensorID   string     `msgpack:"sensorId"`
	SensorType SensorType `msgpack:"sensorType"`
}

// sensorRefreshedState is the current state of a sensor as returned by
// getSensorStates() over RPC.
type sensorRefreshedState struct {
	Type         SensorType     `msgpack:"type"`
	Properties   map[string]any `msgpack:"properties,omitempty"`
	Capabilities []string       `msgpack:"capabilities,omitempty"`
	DisplayName  string         `msgpack:"displayName,omitempty"`
}

// sensorAssignmentChangedData is the internal RPC payload for a
// "sensor:assignmentChanged" event.
type sensorAssignmentChangedData struct {
	CameraID   string     `msgpack:"cameraId"`
	PluginID   string     `msgpack:"pluginId"`
	SensorType SensorType `msgpack:"sensorType"`
	Assigned   bool       `msgpack:"assigned"`
}

// sensorInitialState is the initial state of a sensor at registration
// time, included in "sensor:added" payloads.
type sensorInitialState struct {
	Online       bool           `msgpack:"online"`
	Properties   map[string]any `msgpack:"properties,omitempty"`
	Capabilities []string       `msgpack:"capabilities,omitempty"`
}

// storedSensorData is the persisted sensor record as sent by the host.
type storedSensorData struct {
	ID             string         `msgpack:"id"`
	Type           SensorType     `msgpack:"type"`
	Name           string         `msgpack:"name"`
	DisplayName    string         `msgpack:"displayName"`
	PluginID       string         `msgpack:"pluginId"`
	Properties     map[string]any `msgpack:"properties,omitempty"`
	Capabilities   []string       `msgpack:"capabilities,omitempty"`
	RequiresFrames bool           `msgpack:"requiresFrames,omitempty"`
}

// sensorEventMessage is the internal RPC payload for per-sensor events
// (property:changed, capabilities:changed, displayName:changed).
//
// Data is decoded as map[string]any to avoid msgpack reflection panics
// when the inner Value field is typed as `any`.
type sensorEventMessage struct {
	Type string         `msgpack:"type"`
	Data map[string]any `msgpack:"data"`
}

// deviceManagerEventMessage is the internal RPC payload for a
// device-manager event (cameraAdded/cameraReleased/etc.).
type deviceManagerEventMessage struct {
	Type string `msgpack:"type"`
	Data any    `msgpack:"data,omitempty"`
}

// cameraAddedEventData is the internal RPC payload for a "cameraAdded"
// event.
type cameraAddedEventData struct {
	Camera Camera `msgpack:"camera"`
}

// cameraReleasedEventData is the internal RPC payload for a
// "cameraReleased" event.
type cameraReleasedEventData struct {
	CameraID string `msgpack:"cameraId"`
}

// detectionEventMessage is the internal RPC payload for a detection event
// published on the camera's detection event subject.
type detectionEventMessage struct {
	Type DetectionEventType `msgpack:"type" json:"type"`
	Data DetectionEvent     `msgpack:"data" json:"data"`
}
