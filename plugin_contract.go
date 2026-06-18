package sdk

// PluginRole identifies the role a plugin plays in the system. The role
// decides which lifecycle hooks the host invokes and which contract
// validations apply (see plugin_helper.go).
type PluginRole string

const (
	// PluginRoleHub is a cloud-service integration that manages its own
	// cameras end-to-end via a vendor account. The hub owns camera creation,
	// streaming and sensors; it cannot expose sensors for cameras owned by
	// other plugins.
	PluginRoleHub PluginRole = "hub"
	// PluginRoleSensorProvider adds sensors to existing cameras without
	// owning the camera itself. Typical use: a detection plugin that
	// consumes another plugin's video frames and emits motion / object /
	// face detections back into the system.
	PluginRoleSensorProvider PluginRole = "sensorProvider"
	// PluginRoleCameraController manages cameras and their media streams
	// (ONVIF, RTSP, generic IP, ...). The plugin is responsible for stream
	// URLs, PTZ, snapshots, and the lifecycle hooks in BasePlugin. It does
	// not produce sensors for foreign cameras.
	PluginRoleCameraController PluginRole = "cameraController"
	// PluginRoleCameraAndSensorProvider is the combined role: plugin both
	// manages cameras and exposes sensors (its own cameras and, when
	// consumes is set, also foreign cameras).
	PluginRoleCameraAndSensorProvider PluginRole = "cameraAndSensorProvider"
)

// PluginInterface is a capability flag a plugin advertises in its contract.
// The host uses these to decide which RPC handlers to wire up and which UI
// affordances to show.
type PluginInterface string

const (
	// PluginInterfaceMotionDetection — plugin implements
	// MotionDetectionInterface (video-based motion detection).
	PluginInterfaceMotionDetection PluginInterface = "MotionDetection"
	// PluginInterfaceObjectDetection — plugin implements
	// ObjectDetectionInterface (e.g. person, vehicle, animal).
	PluginInterfaceObjectDetection PluginInterface = "ObjectDetection"
	// PluginInterfaceAudioDetection — plugin implements
	// AudioDetectionInterface (event/keyword audio detection).
	PluginInterfaceAudioDetection PluginInterface = "AudioDetection"
	// PluginInterfaceFaceDetection — plugin implements FaceDetectionInterface
	// (face localisation + embeddings). The NVR owns matching against
	// enrolled faces; the plugin only emits detections + embeddings.
	PluginInterfaceFaceDetection PluginInterface = "FaceDetection"
	// PluginInterfaceLicensePlateDetection — plugin implements
	// LicensePlateDetectionInterface (plate localisation + OCR).
	PluginInterfaceLicensePlateDetection PluginInterface = "LicensePlateDetection"
	// PluginInterfaceClassifierDetection — plugin implements
	// ClassifierDetectionInterface (generic image classification emitting
	// attribute/label pairs).
	PluginInterfaceClassifierDetection PluginInterface = "ClassifierDetection"
	// PluginInterfaceClipDetection — plugin implements ClipDetectionInterface
	// (CLIP image and text embeddings used for semantic search).
	PluginInterfaceClipDetection PluginInterface = "ClipDetection"
	// PluginInterfaceDiscoveryProvider — plugin implements DiscoveryProvider
	// and can scan the network for new cameras and adopt them. Only valid
	// for camera-controlling roles.
	PluginInterfaceDiscoveryProvider PluginInterface = "DiscoveryProvider"
	// PluginInterfaceNVR — plugin implements NVRInterface, persisting events
	// and recordings and serving them back to the UI / mobile clients.
	// Exactly one plugin per host fills this role at runtime.
	PluginInterfaceNVR PluginInterface = "NVR"
	// PluginInterfaceNotifier — plugin implements NotifierInterface
	// (GetDevices, SendNotification, ...). Lets the central
	// NotificationManager dispatch notifications to this plugin regardless
	// of role. See plugin_notifier.go.
	PluginInterfaceNotifier PluginInterface = "Notifier"
	// PluginInterfaceOAuthCapable — plugin implements the OAuthCapable base
	// interface (GetOAuthMetadata, GetOAuthState, Disconnect) plus at least
	// one of the flow sub-interfaces below. See plugin_oauth.go.
	PluginInterfaceOAuthCapable PluginInterface = "OAuthCapable"
	// PluginInterfaceOAuthDeviceFlow — plugin implements
	// OAuthDeviceFlowCapable (RFC 8628 Device Authorization Grant).
	PluginInterfaceOAuthDeviceFlow PluginInterface = "OAuthDeviceFlow"
	// PluginInterfaceOAuthAuthCodeFlow — plugin implements
	// OAuthAuthCodeFlowCapable (Authorization Code Flow + PKCE).
	PluginInterfaceOAuthAuthCodeFlow PluginInterface = "OAuthAuthCodeFlow"
	// PluginInterfaceOAuthClientCredentials — plugin implements
	// OAuthClientCredentialsCapable (user-supplied client_id + client_secret).
	PluginInterfaceOAuthClientCredentials PluginInterface = "OAuthClientCredentials"
)

// PluginCapability is a permission a plugin requests so it can call a
// host-provided system feature. Each capability gates one outgoing SDK
// call — calls without the matching capability are rejected by the host.
type PluginCapability string

const (
	// CapabilityPublishNotifications grants the plugin permission to call
	// api.NotificationManager.Publish. Without this capability the host
	// silently drops published notifications and logs an error.
	CapabilityPublishNotifications PluginCapability = "publishNotifications"
)

// PythonVersion is the Python interpreter major.minor version a Python plugin
// requires. The host ensures a matching interpreter exists in its venv pool
// before launching the plugin; Node and Go plugins ignore this field.
type PythonVersion = string

const (
	PythonVersion311 PythonVersion = "3.11"
	PythonVersion312 PythonVersion = "3.12"
)

// PluginContract is the manifest contract a plugin declares so the host
// knows what it does and what it needs at load time. Validated by
// ValidateContract (plugin_helper.go) before the plugin is started.
type PluginContract struct {
	// Name is the stable, unique identifier for the plugin instance — used
	// as the registry key, log prefix and the storage namespace.
	Name string `msgpack:"name" json:"name"`
	// Role is the plugin's role (see PluginRole).
	Role PluginRole `msgpack:"role,omitempty" json:"role,omitempty"`
	// Provides lists the sensor types the plugin produces. Empty for hubs
	// and pure camera-controllers; required for sensor providers.
	Provides []SensorType `msgpack:"provides" json:"provides"`
	// Consumes lists the sensor types the plugin reads from other plugins
	// (e.g. a face plugin consumes camera video frames).
	Consumes []SensorType `msgpack:"consumes" json:"consumes"`
	// Interfaces are the capability flags the plugin implements (see
	// PluginInterface).
	Interfaces []PluginInterface `msgpack:"interfaces,omitempty" json:"interfaces,omitempty"`
	// Capabilities are permissions the plugin requests to call host system
	// features (see PluginCapability). The host enforces these — calls
	// without a matching capability are rejected.
	Capabilities []PluginCapability `msgpack:"capabilities,omitempty" json:"capabilities,omitempty"`
	// PythonVersion is the required Python interpreter version for Python
	// plugins. Ignored by Node / Go plugins.
	PythonVersion PythonVersion `msgpack:"pythonVersion,omitempty" json:"pythonVersion,omitempty"`
	// Dependencies are extra package dependencies installed into the
	// plugin's runtime (Go module paths for Go plugins; PyPI / npm names
	// for Python and Node plugins).
	Dependencies []string `msgpack:"dependencies,omitempty" json:"dependencies,omitempty"`
}

// PluginInfo is a lightweight handle identifying an installed plugin — used
// in RPC payloads and managers to refer to the plugin without shipping its
// full state.
type PluginInfo struct {
	// ID is the unique runtime ID assigned by the host (stable across
	// restarts).
	ID string `msgpack:"id" json:"id"`
	// Name is the plugin package name (matches PluginContract.Name).
	Name string `msgpack:"name" json:"name"`
	// Contract is the full contract the plugin was loaded with.
	Contract PluginContract `msgpack:"contract" json:"contract"`
}
