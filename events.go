package sdk

type cameraEventMessage struct {
	Type string `msgpack:"type"`
	Data any    `msgpack:"data,omitempty"`
}

type sensorControllerEventMessage struct {
	Type string `msgpack:"type"`
	Data any    `msgpack:"data,omitempty"`
}

type sensorAddedEventData struct {
	Sensor storedSensorData   `msgpack:"sensor"`
	State  sensorInitialState `msgpack:"state"`
}

type sensorRemovedEventData struct {
	SensorID   string     `msgpack:"sensorId"`
	SensorType SensorType `msgpack:"sensorType"`
}

type sensorRefreshedState struct {
	Type         SensorType     `msgpack:"type"`
	Properties   map[string]any `msgpack:"properties,omitempty"`
	Capabilities []string       `msgpack:"capabilities,omitempty"`
	DisplayName  string         `msgpack:"displayName,omitempty"`
}

type sensorAssignmentChangedData struct {
	CameraID   string     `msgpack:"cameraId"`
	PluginID   string     `msgpack:"pluginId"`
	SensorType SensorType `msgpack:"sensorType"`
	Assigned   bool       `msgpack:"assigned"`
}

type sensorInitialState struct {
	Online       bool           `msgpack:"online"`
	Properties   map[string]any `msgpack:"properties,omitempty"`
	Capabilities []string       `msgpack:"capabilities,omitempty"`
}

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

// Data is decoded as map[string]any to avoid msgpack reflection panics when the
// inner Value field is typed as `any`.
type sensorEventMessage struct {
	Type string         `msgpack:"type"`
	Data map[string]any `msgpack:"data"`
}

type deviceManagerEventMessage struct {
	Type string `msgpack:"type"`
	Data any    `msgpack:"data,omitempty"`
}

type cameraAddedEventData struct {
	Camera Camera `msgpack:"camera"`
}

type cameraReleasedEventData struct {
	CameraID string `msgpack:"cameraId"`
}

type detectionEventMessage struct {
	Type DetectionEventType `msgpack:"type" json:"type"`
	Data DetectionEvent     `msgpack:"data" json:"data"`
}
