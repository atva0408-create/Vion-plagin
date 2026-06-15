package sdk

// PluginStatus reports the lifecycle state of the plugin process as seen by
// the host. Sent over the private bootstrap channel during startup and
// shutdown (see run.go).
type PluginStatus string

const (
	// PluginStatusReady is sent after the plugin process has connected and
	// registered its message handler — it is now waiting for the start
	// command from the host.
	PluginStatusReady PluginStatus = "ready"
	// PluginStatusStarting indicates the plugin is currently bootstrapping
	// (constructing managers, opening storage, configuring cameras).
	PluginStatusStarting PluginStatus = "starting"
	// PluginStatusStarted is sent once ConfigureCameras has returned and the
	// plugin is fully operational.
	PluginStatusStarted PluginStatus = "started"
	// PluginStatusStopping indicates the plugin is in graceful shutdown.
	PluginStatusStopping PluginStatus = "stopping"
	// PluginStatusStopped indicates the plugin has finished shutdown and the
	// process is about to exit.
	PluginStatusStopped PluginStatus = "stopped"
	// PluginStatusError is sent when the plugin failed to start; an `Error`
	// message accompanies it.
	PluginStatusError PluginStatus = "error"
	// PluginStatusUnknown is the zero-value placeholder.
	PluginStatusUnknown PluginStatus = "unknown"
	// PluginStatusDisabled indicates the plugin is installed but disabled
	// in the host configuration.
	PluginStatusDisabled PluginStatus = "disabled"
)

// pluginCommand is a host-issued control command delivered over the private
// bootstrap channel.
type pluginCommand string

const (
	// pluginCommandStart asks the plugin to start its main work — payload is
	// a processLoadMessage with the assigned cameras and storage paths.
	pluginCommandStart pluginCommand = "start"
	// pluginCommandStop asks the plugin to shut down gracefully.
	pluginCommandStop pluginCommand = "stop"
)

// APIEvent identifies a lifecycle event emitted on the PluginAPI eventEmitter.
// Plugins subscribe with api.On(string(APIEventX), handler) to react to
// host-driven phase changes.
type APIEvent string

const (
	// APIEventFinishLaunching is emitted exactly once after the plugin has
	// been constructed, all assigned cameras have been wired up, and
	// ConfigureCameras has returned. Use it to start background work that
	// must wait until the camera set is stable (timers, model warm-up,
	// outbound connections).
	APIEventFinishLaunching APIEvent = "finishLaunching"
	// APIEventShutdown is emitted when the host is tearing the plugin down
	// (graceful stop, reload or process exit). Listeners must release
	// resources synchronously enough to finish before the host kills the
	// process — open files, sockets, timers, child processes.
	APIEventShutdown APIEvent = "shutdown"
	// APIEventCloudAccountChanged is emitted when the user-level cloud
	// account is connected or disconnected. Plugins that depend on cloud
	// credentials use this to (re)authenticate or pause work.
	APIEventCloudAccountChanged APIEvent = "cloudAccountChanged"
)

// PluginRole identifies the role a plugin plays in the system. The role
// decides which lifecycle hooks the host invokes and which contract
// validations apply (see contract.go).
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
	// of role. See notifier.go.
	PluginInterfaceNotifier PluginInterface = "Notifier"
	// PluginInterfaceOAuthCapable — plugin implements the OAuthCapable base
	// interface (GetOAuthMetadata, GetOAuthState, Disconnect) plus at least
	// one of the flow sub-interfaces below. See interface_oauth.go.
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

// PluginContract is the manifest contract a plugin declares so the host
// knows what it does and what it needs at load time. Validated by
// ValidateContract (contract.go) before the plugin is started.
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

// PluginStorage carries the storage paths the host hands to the plugin
// during the start handshake. Only used inside the bootstrap message; plugin
// code should read PluginAPI.StoragePath instead.
type PluginStorage struct {
	// InstallPath is the read-only directory where the plugin binary /
	// package was installed by the host.
	InstallPath string `msgpack:"installPath" json:"installPath"`
	// StoragePath is the writable directory the plugin owns for caches,
	// models, sqlite/bolt files. The same string is exposed as
	// PluginAPI.StoragePath.
	StoragePath string `msgpack:"storagePath" json:"storagePath"`
}

// Plugin is the lifecycle contract every camera.ui plugin must implement.
// The host calls these methods in a strict order: ConfigureCameras once at
// startup, then OnCameraAdded / OnCameraReleased as the user adds or removes
// cameras at runtime.
type Plugin interface {
	// ConfigureCameras is called once on startup with every camera that is
	// already assigned to this plugin. The plugin should attach handlers,
	// open vendor sessions, and warm up models. Returning an error aborts
	// plugin startup.
	ConfigureCameras(cameras []*CameraDevice) error
	// OnCameraAdded is called whenever a camera is assigned to this plugin
	// at runtime — after a discovery adoption (DiscoveryProvider.OnAdoptCamera)
	// or after the user re-assigns an existing camera in the UI. The plugin
	// should set up the same per-camera state as in ConfigureCameras.
	OnCameraAdded(camera *CameraDevice) error
	// OnCameraReleased is called when a camera is unassigned from this
	// plugin or deleted from the system. The plugin must release per-camera
	// resources (sessions, timers, decoders) before returning.
	OnCameraReleased(cameraID string) error
}

// pluginConstructor is the function the host calls to instantiate the
// plugin. It receives the per-plugin Logger, the PluginAPI handle, and a
// DeviceStorage scoped to the plugin itself (per-camera storage is created
// later via the DeviceManager).
type pluginConstructor func(logger *Logger, api *PluginAPI, storage *DeviceStorage) Plugin

// StorageSchemaProvider is an optional interface plugins can implement to
// register a JSON schema for their plugin-level storage. The host renders it
// as a settings form in the UI.
type StorageSchemaProvider interface {
	// StorageSchema returns the schemas describing the plugin-level config.
	// Called once after plugin construction; see run.go.
	StorageSchema() []JsonSchema
}

// BasePlugin embeds the three dependencies every plugin needs (logger, API
// handle, storage). Embed it in your plugin struct to avoid repeating that
// boilerplate.
//
// Example:
//
//	type MyPlugin struct {
//	    sdk.BasePlugin
//	    cameras map[string]*sdk.CameraDevice
//	}
//
//	func NewPlugin(logger *sdk.Logger, api *sdk.PluginAPI, storage *sdk.DeviceStorage) sdk.Plugin {
//	    return &MyPlugin{
//	        BasePlugin: sdk.NewBasePlugin(logger, api, storage),
//	        cameras:    make(map[string]*sdk.CameraDevice),
//	    }
//	}
type BasePlugin struct {
	// Logger is the per-plugin logger; messages are tagged with the plugin
	// name and forwarded to the host.
	Logger *Logger
	// API is the PluginAPI handle injected by the host (managers + lifecycle
	// eventEmitter).
	API *PluginAPI
	// Storage is the plugin-level storage instance (per-camera storage is
	// obtained via API.DeviceManager).
	Storage *DeviceStorage
}

// NewBasePlugin builds a BasePlugin value from the constructor arguments.
// Use it inside your pluginConstructor implementation.
func NewBasePlugin(logger *Logger, api *PluginAPI, storage *DeviceStorage) BasePlugin {
	return BasePlugin{
		Logger:  logger,
		API:     api,
		Storage: storage,
	}
}
