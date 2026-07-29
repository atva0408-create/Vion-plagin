package sdk

// PluginAPI is injected into the plugin at runtime and exposes the system
// services the plugin is allowed to talk to. It also acts as an eventEmitter
// for plugin lifecycle events (see APIEvent).
//
// Example:
//
//	ffmpeg, err := api.CoreManager.GetFFmpegPath()
type PluginAPI struct {
	*eventEmitter
	// CoreManager exposes system-level operations: the FFmpeg path and the
	// server addresses used for media URLs (HTTP/RTSP).
	CoreManager *CoreManager
	// DeviceManager owns the camera devices assigned to this plugin and
	// publishes camera-state changes.
	DeviceManager *DeviceManager
	// SensorManager registers standalone sensors: entities of their own,
	// persisted across restarts, assignable to cameras by the user.
	SensorManager *SensorManager
	// DownloadManager mints token-protected download URLs for files the
	// plugin exposes to the UI (clip exports, snapshots).
	DownloadManager *DownloadManager
	// NotificationManager publishes notifications to every installed notifier
	// and the in-app UI. Requires CapabilityPublishNotifications.
	NotificationManager *NotificationManager
	// StoragePath is the absolute path to the plugin's writable storage
	// directory, created and cleaned up by the host.
	StoragePath string

	storageController *StorageController
}

func newPluginAPI(
	coreManager *CoreManager,
	deviceManager *DeviceManager,
	sensorManager *SensorManager,
	downloadManager *DownloadManager,
	notificationManager *NotificationManager,
	storageController *StorageController,
	storagePath string,
) *PluginAPI {
	return &PluginAPI{
		eventEmitter:        newEventEmitter(),
		CoreManager:         coreManager,
		DeviceManager:       deviceManager,
		SensorManager:       sensorManager,
		DownloadManager:     downloadManager,
		NotificationManager: notificationManager,
		storageController:   storageController,
		StoragePath:         storagePath,
	}
}
