package sdk

// PluginAPI is injected into the plugin at runtime and exposes the system
// services the plugin is allowed to talk to. It also acts as an eventEmitter
// for plugin lifecycle events (see APIEvent constants in plugin.go).
type PluginAPI struct {
	*eventEmitter
	// CoreManager exposes system-level operations such as the FFmpeg path
	// and server addresses.
	CoreManager *CoreManager
	// DeviceManager owns the camera devices assigned to this plugin and
	// publishes camera-state changes.
	DeviceManager *DeviceManager
	// DownloadManager mints token-protected download URLs for files the
	// plugin wants to expose to the UI.
	DownloadManager *DownloadManager
	// NotificationManager publishes notifications into the host so they fan
	// out to every installed Notifier-plugin and the in-app UI. Requires
	// CapabilityPublishNotifications in the plugin contract.
	NotificationManager *NotificationManager
	// StoragePath is the absolute path to the plugin's writable storage
	// directory (created and cleaned up by the host).
	StoragePath string
	// storageController is the internal handle used by the SDK to create
	// per-component DeviceStorage instances.
	storageController *StorageController
}

// newPluginAPI creates a new PluginAPI instance. Only called by the SDK
// runtime in run.go after the host has handed over the plugin's storage
// paths and bootstrapped the RPC managers.
func newPluginAPI(
	coreManager *CoreManager,
	deviceManager *DeviceManager,
	downloadManager *DownloadManager,
	notificationManager *NotificationManager,
	storageController *StorageController,
	storagePath string,
) *PluginAPI {
	return &PluginAPI{
		eventEmitter:        newEventEmitter(),
		CoreManager:         coreManager,
		DeviceManager:       deviceManager,
		DownloadManager:     downloadManager,
		NotificationManager: notificationManager,
		storageController:   storageController,
		StoragePath:         storagePath,
	}
}
