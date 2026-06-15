package sdk

import "fmt"

// This file defines the RPC namespaces (NATS subjects) used for inter-plugin
// and host/plugin communication. Each "Namespaces" struct groups the subjects
// belonging to a single conceptual scope (manager, plugin, camera, sensor,
// detection event, ...). The corresponding `GetXxxNamespaces` constructors
// derive concrete subject strings from the relevant identifiers.

// coreManagerNamespaces holds RPC namespaces for the core manager
// (host-level event subject and request/response RPC).
type coreManagerNamespaces struct {
	CoreManagerSubject string
	CoreManagerRPC     string
}

// deviceManagerNamespaces holds RPC namespaces for the device manager
// (camera lifecycle: added/released/refreshed events and RPC).
type deviceManagerNamespaces struct {
	DeviceManagerSubject string
	DeviceManagerRPC     string
}

// discoveryManagerNamespaces holds RPC namespaces for the discovery manager
// (camera discovery probes and results).
type discoveryManagerNamespaces struct {
	DiscoveryManagerSubject string
	DiscoveryManagerRPC     string
}

// downloadManagerNamespaces holds the RPC namespace used to register and
// query downloadable artifacts (snapshots, exports, notification images).
type downloadManagerNamespaces struct {
	DownloadManagerRPC string
}

// notificationManagerNamespaces holds the NATS subject the host listens on
// for plugin-published notifications.
type notificationManagerNamespaces struct {
	NotificationsPublishSubject string
}

// pluginNamespaces holds the per-plugin RPC namespaces: device-manager
// subscription, the child process RPC, the child lifecycle subject, and the
// per-plugin storage RPC.
type pluginNamespaces struct {
	PluginDeviceManagerSubject string
	PluginChildRPC             string
	PluginChild                string
	PluginStorageRPC           string
}

// cameraNamespaces holds RPC namespaces scoped to a single camera (event
// subject and the camera controller RPC).
type cameraNamespaces struct {
	CameraSubject       string
	CameraControllerRPC string
}

// pluginCameraNamespaces holds RPC namespaces a plugin uses to talk to its
// camera implementation: camera interfaces, camera-scoped storage, and the
// raw implementation RPC.
type pluginCameraNamespaces struct {
	CameraInterfacesRPC string
	CameraStorageRPC    string
	CameraImplRPC       string
}

// pluginSensorNamespaces holds RPC namespaces scoped to a single sensor
// owned by a plugin (currently only the per-sensor storage RPC).
type pluginSensorNamespaces struct {
	SensorStorageRPC string
}

// sensorControllerNamespaces holds the RPC namespaces of the per-camera
// sensor controller (event subject and request/response RPC).
type sensorControllerNamespaces struct {
	SensorSubject string
	SensorRPC     string
}

// sensorEventNamespaces holds the event subject for a single sensor
// (property/capability/displayName changes).
type sensorEventNamespaces struct {
	SensorSubject string
}

// sensorProviderNamespaces holds the RPC namespace exposed by a plugin's
// sensor implementation.
type sensorProviderNamespaces struct {
	SensorRPC string
}

// detectionEventNamespaces holds the event subject on which a camera's
// detection events are published.
type detectionEventNamespaces struct {
	DetectionEventSubject string
}

// getDetectionEventNamespaces returns the detection event subject for the
// given camera.
//
//   - cameraID: target camera identifier.
func getDetectionEventNamespaces(cameraID string) detectionEventNamespaces {
	return detectionEventNamespaces{
		DetectionEventSubject: fmt.Sprintf("camera.%s.events.subject", cameraID),
	}
}

// frameWorkerDetectionNamespaces holds the RPC namespace used by the
// FrameWorker DetectionCoordinator.
type frameWorkerDetectionNamespaces struct {
	DetectionRPC string
}

// getFrameWorkerDetectionNamespaces returns the FrameWorker
// DetectionCoordinator RPC namespace for the given camera.
//
//   - cameraID: target camera identifier.
func getFrameWorkerDetectionNamespaces(cameraID string) frameWorkerDetectionNamespaces {
	return frameWorkerDetectionNamespaces{
		DetectionRPC: fmt.Sprintf("camera.%s.frameWorker.detection.rpc", cameraID),
	}
}

// getCoreManagerNamespaces returns the global core-manager namespaces.
func getCoreManagerNamespaces() coreManagerNamespaces {
	return coreManagerNamespaces{
		CoreManagerSubject: "coreManager.subscriber",
		CoreManagerRPC:     "coreManager.rpc",
	}
}

// getDeviceManagerNamespaces returns the global device-manager namespaces.
func getDeviceManagerNamespaces() deviceManagerNamespaces {
	return deviceManagerNamespaces{
		DeviceManagerSubject: "deviceManager.subscriber",
		DeviceManagerRPC:     "deviceManager.rpc",
	}
}

// getDiscoveryManagerNamespaces returns the global discovery-manager
// namespaces.
func getDiscoveryManagerNamespaces() discoveryManagerNamespaces {
	return discoveryManagerNamespaces{
		DiscoveryManagerSubject: "discoveryManager.subscriber",
		DiscoveryManagerRPC:     "discoveryManager.rpc",
	}
}

// getDownloadManagerNamespaces returns the global download-manager
// namespaces.
func getDownloadManagerNamespaces() downloadManagerNamespaces {
	return downloadManagerNamespaces{
		DownloadManagerRPC: "downloadManager.rpc",
	}
}

// getNotificationManagerNamespaces returns the global notification-manager
// namespaces.
func getNotificationManagerNamespaces() notificationManagerNamespaces {
	return notificationManagerNamespaces{
		NotificationsPublishSubject: "notifications.publish",
	}
}

// getPluginNamespaces returns the per-plugin namespaces.
//
//   - pluginID: target plugin identifier.
func getPluginNamespaces(pluginID string) pluginNamespaces {
	return pluginNamespaces{
		PluginDeviceManagerSubject: fmt.Sprintf("plugin.%s.deviceManager.subscriber", pluginID),
		PluginChildRPC:             fmt.Sprintf("plugin.%s.child.rpc", pluginID),
		PluginChild:                fmt.Sprintf("plugin.%s.child", pluginID),
		PluginStorageRPC:           fmt.Sprintf("plugin.%s.storage.rpc", pluginID),
	}
}

// getCameraNamespaces returns the per-camera namespaces.
//
//   - cameraID: target camera identifier.
func getCameraNamespaces(cameraID string) cameraNamespaces {
	return cameraNamespaces{
		CameraSubject:       fmt.Sprintf("camera.%s.subscriber", cameraID),
		CameraControllerRPC: fmt.Sprintf("camera.%s.controller.rpc", cameraID),
	}
}

// getPluginCameraNamespaces returns the namespaces a plugin uses for its
// camera implementation.
//
//   - pluginID: owning plugin identifier.
//   - cameraID: target camera identifier.
func getPluginCameraNamespaces(pluginID, cameraID string) pluginCameraNamespaces {
	return pluginCameraNamespaces{
		CameraInterfacesRPC: fmt.Sprintf("plugin.%s.camera.%s.cameraInterfaces.rpc", pluginID, cameraID),
		CameraStorageRPC:    fmt.Sprintf("plugin.%s.camera.%s.cameraStorage.rpc", pluginID, cameraID),
		CameraImplRPC:       fmt.Sprintf("plugin.%s.camera.%s.impl.rpc", pluginID, cameraID),
	}
}

// getPluginSensorNamespaces returns the namespaces a plugin uses for a
// single sensor.
//
//   - pluginID: owning plugin identifier.
//   - cameraID: parent camera identifier.
//   - sensorID: target sensor identifier.
func getPluginSensorNamespaces(pluginID, cameraID, sensorID string) pluginSensorNamespaces {
	return pluginSensorNamespaces{
		SensorStorageRPC: fmt.Sprintf("plugin.%s.camera.%s.sensor.%s.storage.rpc", pluginID, cameraID, sensorID),
	}
}

// getSensorControllerNamespaces returns the per-camera sensor-controller
// namespaces.
//
//   - cameraID: target camera identifier.
func getSensorControllerNamespaces(cameraID string) sensorControllerNamespaces {
	return sensorControllerNamespaces{
		SensorSubject: fmt.Sprintf("camera.%s.sensors.subject", cameraID),
		SensorRPC:     fmt.Sprintf("camera.%s.sensors.rpc", cameraID),
	}
}

// getSensorEventNamespaces returns the per-sensor event subject.
//
//   - cameraID: parent camera identifier.
//   - sensorID: target sensor identifier.
func getSensorEventNamespaces(cameraID, sensorID string) sensorEventNamespaces {
	return sensorEventNamespaces{
		SensorSubject: fmt.Sprintf("camera.%s.sensor.%s.subject", cameraID, sensorID),
	}
}

// getSensorProviderNamespaces returns the namespaces of a plugin-owned
// sensor implementation.
//
//   - pluginID: owning plugin identifier.
//   - cameraID: parent camera identifier.
//   - sensorID: target sensor identifier.
func getSensorProviderNamespaces(pluginID, cameraID, sensorID string) sensorProviderNamespaces {
	return sensorProviderNamespaces{
		SensorRPC: fmt.Sprintf("plugin.%s.camera.%s.sensor.%s.rpc", pluginID, cameraID, sensorID),
	}
}
