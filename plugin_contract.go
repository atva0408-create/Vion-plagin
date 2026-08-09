package sdk

// PluginRole identifies the role a plugin plays in the system. The role
// decides which lifecycle hooks the host invokes and which contract
// validations apply.
type PluginRole string

const (
	// PluginRoleHub is a cross-camera aggregator (smart-home bridge,
	// recorder). It owns no cameras and provides no sensors.
	PluginRoleHub PluginRole = "hub"
	// PluginRoleSensorProvider adds sensors to cameras owned by other
	// plugins, for example a detector running on foreign video frames.
	PluginRoleSensorProvider PluginRole = "sensorProvider"
	// PluginRoleCameraController manages cameras and their media streams:
	// stream URLs, PTZ, snapshots. It provides no sensors for foreign cameras.
	PluginRoleCameraController PluginRole = "cameraController"
	// PluginRoleCameraAndSensorProvider manages cameras and exposes sensors,
	// on its own cameras and, with Consumes set, on foreign ones.
	PluginRoleCameraAndSensorProvider PluginRole = "cameraAndSensorProvider"
)

// PluginInterface is a capability flag a plugin advertises in its contract.
// The host uses these to decide which RPC handlers to wire up and which UI
// affordances to show.
type PluginInterface string

const (
	// PluginInterfaceMotionDetection marks a plugin implementing
	// MotionDetectionInterface (video-based motion detection).
	PluginInterfaceMotionDetection PluginInterface = "MotionDetection"
	// PluginInterfaceObjectDetection marks a plugin implementing
	// ObjectDetectionInterface (e.g. person, vehicle, animal).
	PluginInterfaceObjectDetection PluginInterface = "ObjectDetection"
	// PluginInterfaceAudioDetection marks a plugin implementing
	// AudioDetectionInterface (event/keyword audio detection).
	PluginInterfaceAudioDetection PluginInterface = "AudioDetection"
	// PluginInterfaceFaceDetection marks a plugin implementing
	// FaceDetectionInterface (face localisation + embeddings). Matching
	// against enrolled faces happens in the NVR.
	PluginInterfaceFaceDetection PluginInterface = "FaceDetection"
	// PluginInterfaceLicensePlateDetection marks a plugin implementing
	// LicensePlateDetectionInterface (plate localisation + OCR).
	PluginInterfaceLicensePlateDetection PluginInterface = "LicensePlateDetection"
	// PluginInterfaceClassifierDetection marks a plugin implementing
	// ClassifierDetectionInterface (generic image classification emitting
	// attribute/label pairs).
	PluginInterfaceClassifierDetection PluginInterface = "ClassifierDetection"
	// PluginInterfaceClipDetection marks a plugin implementing
	// ClipDetectionInterface (CLIP image and text embeddings used for
	// semantic search).
	PluginInterfaceClipDetection PluginInterface = "ClipDetection"
	// PluginInterfaceDiscoveryProvider marks a plugin implementing
	// DiscoveryProvider (network scan + adoption). Only valid for
	// camera-controlling roles.
	PluginInterfaceDiscoveryProvider PluginInterface = "DiscoveryProvider"
	// PluginInterfaceNVR marks a plugin implementing NVRInterface (events and
	// recordings). Exactly one plugin per host fills this role at runtime.
	PluginInterfaceNVR PluginInterface = "NVR"
	// PluginInterfaceNotifier marks a plugin implementing NotifierInterface,
	// so the NotificationManager can dispatch notifications to it.
	PluginInterfaceNotifier PluginInterface = "Notifier"
	// PluginInterfaceOAuthCapable marks a plugin implementing the OAuthCapable
	// base interface plus at least one of the flow sub-interfaces below.
	PluginInterfaceOAuthCapable PluginInterface = "OAuthCapable"
	// PluginInterfaceOAuthDeviceFlow marks a plugin implementing
	// OAuthDeviceFlowCapable (RFC 8628 Device Authorization Grant).
	PluginInterfaceOAuthDeviceFlow PluginInterface = "OAuthDeviceFlow"
	// PluginInterfaceOAuthAuthCodeFlow marks a plugin implementing
	// OAuthAuthCodeFlowCapable (Authorization Code Flow + PKCE).
	PluginInterfaceOAuthAuthCodeFlow PluginInterface = "OAuthAuthCodeFlow"
	// PluginInterfaceOAuthClientCredentials marks a plugin implementing
	// OAuthClientCredentialsCapable (user-supplied client_id + client_secret).
	PluginInterfaceOAuthClientCredentials PluginInterface = "OAuthClientCredentials"
)

// PluginCapability is a permission a plugin requests so it can call a
// host-provided system feature. Each capability gates one outgoing SDK call.
// Calls without the matching capability are rejected by the host.
type PluginCapability string

const (
	// CapabilityPublishNotifications allows api.NotificationManager.Publish.
	// Without it the host drops published notifications and logs an error.
	CapabilityPublishNotifications PluginCapability = "publishNotifications"
)

// PythonVersion is the Python interpreter major.minor version a Python plugin
// requires. The host ensures a matching interpreter exists in its venv pool
// before launching the plugin; Node and Go plugins ignore this field.
type PythonVersion = string

const (
	// PythonVersion311 requests a CPython 3.11 interpreter.
	PythonVersion311 PythonVersion = "3.11"
	// PythonVersion312 requests a CPython 3.12 interpreter.
	PythonVersion312 PythonVersion = "3.12"
)

// ProtocolLevel is the compatibility level of the plugin surface: the
// plugin-facing API and the plugin wire protocol. Bumped only on breaking
// changes, never for additive features. The CLI stamps the level a plugin was
// built against into its bundle (`cameraui.protocolLevel` in the bundle
// package.json); the server compares that stamp with its own level and
// refuses to start plugins outside its supported range.
const ProtocolLevel = 2

// PluginContract is the manifest contract a plugin declares so the host knows
// what it does and what it needs at load time. Validated before the plugin is
// started.
type PluginContract struct {
	// Name is the stable, unique identifier: registry key, log prefix and
	// storage namespace.
	Name string `msgpack:"name" json:"name"`
	// Role is the plugin's role (see PluginRole).
	Role PluginRole `msgpack:"role,omitempty" json:"role,omitempty"`
	// Provides lists the sensor types the plugin produces. Empty for hubs and
	// pure camera-controllers, required for sensor providers.
	Provides []SensorType `msgpack:"provides" json:"provides"`
	// Consumes lists the sensor types the plugin reads from other plugins
	// (e.g. a face plugin consuming camera video frames).
	Consumes []SensorType `msgpack:"consumes" json:"consumes"`
	// Interfaces are the capability flags the plugin implements (see
	// PluginInterface).
	Interfaces []PluginInterface `msgpack:"interfaces,omitempty" json:"interfaces,omitempty"`
	// Capabilities are the permissions the plugin requests to call host system
	// features (see PluginCapability).
	Capabilities []PluginCapability `msgpack:"capabilities,omitempty" json:"capabilities,omitempty"`
	// PythonVersion is the required Python interpreter version for Python
	// plugins. Ignored by Node and Go plugins.
	PythonVersion PythonVersion `msgpack:"pythonVersion,omitempty" json:"pythonVersion,omitempty"`
	// Dependencies are extra dependencies installed into the plugin's runtime
	// (Go module paths, PyPI or npm names).
	Dependencies []string `msgpack:"dependencies,omitempty" json:"dependencies,omitempty"`
}

// PluginInfo is a lightweight handle identifying an installed plugin, used in
// RPC payloads and managers to refer to the plugin without shipping its full
// state.
type PluginInfo struct {
	// ID is the unique runtime ID assigned by the host (stable across
	// restarts).
	ID string `msgpack:"id" json:"id"`
	// Name is the plugin package name (matches PluginContract.Name).
	Name string `msgpack:"name" json:"name"`
	// Contract is the full contract the plugin was loaded with.
	Contract PluginContract `msgpack:"contract" json:"contract"`
}
