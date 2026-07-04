package sdk

import (
	"fmt"

	rpc "github.com/cameraui/rpc/go"
)

// StorageController manages storage instances for plugins, cameras, and sensors.
type StorageController struct {
	client      *rpc.Client
	persistence configPersistence
	pluginInfo  PluginInfo
	logger      *Logger
	storages    map[string]*DeviceStorage
}

// newStorageController creates a new StorageController.
func newStorageController(client *rpc.Client, persistence configPersistence, pluginInfo *PluginInfo, logger *Logger) *StorageController {
	return &StorageController{
		client:      client,
		persistence: persistence,
		pluginInfo:  *pluginInfo,
		logger:      logger,
		storages:    make(map[string]*DeviceStorage),
	}
}

// createStorage creates a new DeviceStorage for the given scope.
// scope can be "plugin", a camera ID, or a sensor ID.
func (sc *StorageController) createStorage(scope string) (*DeviceStorage, error) {
	prefix := fmt.Sprintf("%s.%s", sc.pluginInfo.ID, scope)

	storage := newDeviceStorage(sc.persistence, prefix, sc.logger)
	sc.storages[scope] = storage

	// Register RPC handler for server to query this storage
	var namespace string
	switch scope {
	case "plugin":
		ns := getPluginNamespaces(sc.pluginInfo.ID)
		namespace = ns.PluginStorageRPC
	default:
		// Camera or sensor storage - namespace will be registered by the caller
		return storage, nil
	}

	if namespace != "" {
		_, err := sc.client.RegisterHandler(namespace, storage)
		if err != nil {
			return nil, fmt.Errorf("failed to register storage RPC handler: %w", err)
		}
	}

	return storage, nil
}

// createCameraStorage creates storage for a specific camera.
func (sc *StorageController) createCameraStorage(cameraID string) (*DeviceStorage, error) {
	prefix := fmt.Sprintf("%s.camera.%s", sc.pluginInfo.ID, cameraID)
	storage := newDeviceStorage(sc.persistence, prefix, sc.logger)
	sc.storages["camera."+cameraID] = storage

	ns := getPluginCameraNamespaces(sc.pluginInfo.ID, cameraID)
	_, err := sc.client.RegisterHandler(ns.CameraStorageRPC, storage)
	if err != nil {
		return nil, fmt.Errorf("failed to register camera storage RPC: %w", err)
	}

	return storage, nil
}

// createSensorStorage creates storage for a specific sensor.
func (sc *StorageController) createSensorStorage(cameraID, sensorID string) (*DeviceStorage, error) {
	prefix := fmt.Sprintf("%s.sensor.%s.%s", sc.pluginInfo.ID, cameraID, sensorID)
	storage := newDeviceStorage(sc.persistence, prefix, sc.logger)
	sc.storages["sensor."+sensorID] = storage

	ns := getPluginSensorNamespaces(sc.pluginInfo.ID, cameraID, sensorID)
	_, err := sc.client.RegisterHandler(ns.SensorStorageRPC, storage)
	if err != nil {
		return nil, fmt.Errorf("failed to register sensor storage RPC: %w", err)
	}

	return storage, nil
}

// removeCameraStorage removes a camera's storage from the controller.
func (sc *StorageController) removeCameraStorage(cameraID string) {
	delete(sc.storages, "camera."+cameraID)
}
