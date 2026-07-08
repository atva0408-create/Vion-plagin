package sdk

// PluginStatus reports the lifecycle state of the plugin process as seen by
// the host.
type PluginStatus string

const (
	PluginStatusReady    PluginStatus = "ready"
	PluginStatusStarting PluginStatus = "starting"
	PluginStatusStarted  PluginStatus = "started"
	PluginStatusStopping PluginStatus = "stopping"
	PluginStatusStopped  PluginStatus = "stopped"
	PluginStatusError    PluginStatus = "error"
	PluginStatusUnknown  PluginStatus = "unknown"
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
)

// PluginStorage carries the storage paths the host hands to the plugin
// during the start handshake. Plugin code should read PluginAPI.StoragePath
// instead.
type PluginStorage struct {
	InstallPath string `msgpack:"installPath" json:"installPath"`
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

type pluginConstructor func(logger *Logger, api *PluginAPI, storage *DeviceStorage) Plugin

// StorageSchemaProvider is an optional interface plugins can implement to
// register a JSON schema for their plugin-level storage. The host renders it
// as a settings form in the UI.
type StorageSchemaProvider interface {
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
	Logger  *Logger
	API     *PluginAPI
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
