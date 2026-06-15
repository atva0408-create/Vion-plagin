package sdk

// DiscoveryProvider is implemented by plugins that can scan the network for
// new cameras and adopt them. Only plugins with a camera-controlling role
// (CameraController or CameraAndSensorProvider) are queried for discovery.
type DiscoveryProvider interface {
	// OnDiscoverCameras scans the network and returns the cameras the
	// plugin can offer for adoption. Called by the host on demand (UI
	// rescan button) or on a polling schedule.
	OnDiscoverCameras() ([]DiscoveredCamera, error)
	// OnGetCameraSettings returns a JSON schema describing the form fields
	// (credentials, transport options, ...) the user must fill in to adopt
	// this specific discovered camera.
	OnGetCameraSettings(camera DiscoveredCamera) ([]JsonSchema, error)
	// OnAdoptCamera probes the device with the user-provided settings and
	// returns the camera configuration the host should persist. The host
	// then creates the camera and invokes the plugin's OnCameraAdded.
	OnAdoptCamera(camera DiscoveredCamera, cameraSettings map[string]any) (map[string]any, error)
}
