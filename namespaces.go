package sdk

import "fmt"

type coreManagerNamespaces struct {
	CoreManagerSubject string
	CoreManagerRPC     string
}

type deviceManagerNamespaces struct {
	DeviceManagerSubject string
	DeviceManagerRPC     string
}

type discoveryManagerNamespaces struct {
	DiscoveryManagerSubject string
	DiscoveryManagerRPC     string
}

type downloadManagerNamespaces struct {
	DownloadManagerRPC string
}

type notificationManagerNamespaces struct {
	NotificationsPublishSubject string
}

type pluginNamespaces struct {
	PluginDeviceManagerSubject string
	PluginChildRPC             string
	PluginChild                string
	PluginStorageRPC           string
	PluginConfigStoreRPC       string
	PluginFileServeRPC         string
}

type cameraNamespaces struct {
	CameraSubject       string
	CameraControllerRPC string
}

type pluginCameraNamespaces struct {
	CameraInterfacesRPC string
	CameraStorageRPC    string
	CameraImplRPC       string
}

type pluginSensorNamespaces struct {
	SensorStorageRPC string
}

type sensorControllerNamespaces struct {
	SensorSubject string
	SensorRPC     string
}

type sensorEventNamespaces struct {
	SensorSubject string
}

type sensorProviderNamespaces struct {
	SensorRPC string
}

type detectionEventNamespaces struct {
	DetectionEventSubject string
}

type frameWorkerDetectionNamespaces struct {
	DetectionRPC string
}

func getDetectionEventNamespaces(cameraID string) detectionEventNamespaces {
	return detectionEventNamespaces{
		DetectionEventSubject: fmt.Sprintf("camera.%s.events.subject", cameraID),
	}
}

func getFrameWorkerDetectionNamespaces(cameraID string) frameWorkerDetectionNamespaces {
	return frameWorkerDetectionNamespaces{
		DetectionRPC: fmt.Sprintf("camera.%s.frameWorker.detection.rpc", cameraID),
	}
}

func getCoreManagerNamespaces() coreManagerNamespaces {
	return coreManagerNamespaces{
		CoreManagerSubject: "coreManager.subscriber",
		CoreManagerRPC:     "coreManager.rpc",
	}
}

func getDeviceManagerNamespaces() deviceManagerNamespaces {
	return deviceManagerNamespaces{
		DeviceManagerSubject: "deviceManager.subscriber",
		DeviceManagerRPC:     "deviceManager.rpc",
	}
}

func getDiscoveryManagerNamespaces() discoveryManagerNamespaces {
	return discoveryManagerNamespaces{
		DiscoveryManagerSubject: "discoveryManager.subscriber",
		DiscoveryManagerRPC:     "discoveryManager.rpc",
	}
}

func getDownloadManagerNamespaces() downloadManagerNamespaces {
	return downloadManagerNamespaces{
		DownloadManagerRPC: "downloadManager.rpc",
	}
}

func getNotificationManagerNamespaces() notificationManagerNamespaces {
	return notificationManagerNamespaces{
		NotificationsPublishSubject: "notifications.publish",
	}
}

func getPluginNamespaces(pluginID string) pluginNamespaces {
	return pluginNamespaces{
		PluginDeviceManagerSubject: fmt.Sprintf("plugin.%s.deviceManager.subscriber", pluginID),
		PluginChildRPC:             fmt.Sprintf("plugin.%s.child.rpc", pluginID),
		PluginChild:                fmt.Sprintf("plugin.%s.child", pluginID),
		PluginStorageRPC:           fmt.Sprintf("plugin.%s.storage.rpc", pluginID),
		PluginConfigStoreRPC:       fmt.Sprintf("plugin.%s.configstore.rpc", pluginID),
		PluginFileServeRPC:         fmt.Sprintf("plugin.%s.fileserve.rpc", pluginID),
	}
}

func getCameraNamespaces(cameraID string) cameraNamespaces {
	return cameraNamespaces{
		CameraSubject:       fmt.Sprintf("camera.%s.subscriber", cameraID),
		CameraControllerRPC: fmt.Sprintf("camera.%s.controller.rpc", cameraID),
	}
}

func getPluginCameraNamespaces(pluginID, cameraID string) pluginCameraNamespaces {
	return pluginCameraNamespaces{
		CameraInterfacesRPC: fmt.Sprintf("plugin.%s.camera.%s.cameraInterfaces.rpc", pluginID, cameraID),
		CameraStorageRPC:    fmt.Sprintf("plugin.%s.camera.%s.cameraStorage.rpc", pluginID, cameraID),
		CameraImplRPC:       fmt.Sprintf("plugin.%s.camera.%s.impl.rpc", pluginID, cameraID),
	}
}

func getPluginSensorNamespaces(pluginID, cameraID, sensorID string) pluginSensorNamespaces {
	return pluginSensorNamespaces{
		SensorStorageRPC: fmt.Sprintf("plugin.%s.camera.%s.sensor.%s.storage.rpc", pluginID, cameraID, sensorID),
	}
}

func getSensorControllerNamespaces(cameraID string) sensorControllerNamespaces {
	return sensorControllerNamespaces{
		SensorSubject: fmt.Sprintf("camera.%s.sensors.subject", cameraID),
		SensorRPC:     fmt.Sprintf("camera.%s.sensors.rpc", cameraID),
	}
}

func getSensorEventNamespaces(cameraID, sensorID string) sensorEventNamespaces {
	return sensorEventNamespaces{
		SensorSubject: fmt.Sprintf("camera.%s.sensor.%s.subject", cameraID, sensorID),
	}
}

func getSensorProviderNamespaces(pluginID, cameraID, sensorID string) sensorProviderNamespaces {
	return sensorProviderNamespaces{
		SensorRPC: fmt.Sprintf("plugin.%s.camera.%s.sensor.%s.rpc", pluginID, cameraID, sensorID),
	}
}
