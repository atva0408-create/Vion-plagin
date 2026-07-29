package sdk

// PluginStatus reports the lifecycle state of the plugin process as seen by
// the host.
type PluginStatus string

const (
	// PluginStatusReady means the process is up and waiting for the start
	// command.
	PluginStatusReady PluginStatus = "ready"
	// PluginStatusStarting means the host is launching the process.
	PluginStatusStarting PluginStatus = "starting"
	// PluginStatusStarted means startup finished and the plugin is running.
	PluginStatusStarted PluginStatus = "started"
	// PluginStatusStopping means teardown is in progress.
	PluginStatusStopping PluginStatus = "stopping"
	// PluginStatusStopped means the process exited normally.
	PluginStatusStopped PluginStatus = "stopped"
	// PluginStatusError means startup or the process itself failed.
	PluginStatusError PluginStatus = "error"
	// PluginStatusUnknown means the host has no status for the plugin.
	PluginStatusUnknown PluginStatus = "unknown"
	// PluginStatusDisabled means the user turned the plugin off.
	PluginStatusDisabled PluginStatus = "disabled"
)

type pluginCommand string

const (
	pluginCommandStart pluginCommand = "start"
	pluginCommandStop  pluginCommand = "stop"
)

// APIEvent identifies a lifecycle event emitted on the PluginAPI eventEmitter.
// Plugins subscribe with api.On(string(APIEventX), handler) to react to
// host-driven phase changes.
type APIEvent string

const (
	// APIEventFinishLaunching is emitted once after every assigned camera is
	// wired up and ConfigureCameras returned. Start timers and warm-ups here.
	APIEventFinishLaunching APIEvent = "finishLaunching"
	// APIEventShutdown is emitted when the host tears the plugin down.
	// Release files, sockets, timers and child processes now.
	APIEventShutdown APIEvent = "shutdown"
)

// PluginStorage carries the storage paths the host hands to the plugin during
// the start handshake. Plugin code should read PluginAPI.StoragePath instead.
type PluginStorage struct {
	// InstallPath is where the plugin package itself is installed.
	InstallPath string `msgpack:"installPath" json:"installPath"`
	// StoragePath is the plugin's writable storage directory.
	StoragePath string `msgpack:"storagePath" json:"storagePath"`
}

// Plugin is the lifecycle contract every camera.ui plugin must implement.
// The host calls these methods in a strict order: ConfigureCameras once at
// startup, then OnCameraAdded / OnCameraReleased as the user adds or removes
// cameras at runtime.
type Plugin interface {
	// ConfigureCameras is called once on startup with every camera that is
	// already assigned to this plugin. Attach handlers, open vendor sessions,
	// warm up models here. Returning an error aborts plugin startup.
	ConfigureCameras(cameras []*CameraDevice) error
	// OnCameraAdded is called whenever a camera is assigned to this plugin at
	// runtime, after a discovery adoption (DiscoveryProvider.OnAdoptCamera) or
	// after the user re-assigns an existing camera. Set up the same per-camera
	// state as in ConfigureCameras.
	OnCameraAdded(camera *CameraDevice) error
	// OnCameraReleased is called when a camera is unassigned from this plugin
	// or deleted from the system. Release per-camera resources (sessions,
	// timers, decoders) before returning.
	OnCameraReleased(cameraID string) error
}

// StorageSchemaProvider is an optional interface plugins can implement to
// register a JSON schema for their plugin-level storage. The host renders it
// as a settings form in the UI.
type StorageSchemaProvider interface {
	// StorageSchema returns the schema for the plugin-level settings form.
	StorageSchema() []JsonSchema
}

type pluginConstructor func(logger *Logger, api *PluginAPI, storage *DeviceStorage) Plugin

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
	// Logger writes to the host log, prefixed with the plugin name.
	Logger *Logger
	// API is the handle to the host services the plugin may call.
	API *PluginAPI
	// Storage is the plugin-level storage the host persists.
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
