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
