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

// createStorage creates the plugin-level DeviceStorage ("plugin" is the only
// supported scope).
func (sc *StorageController) createStorage(scope string) (*DeviceStorage, error) {
	if scope != "plugin" {
		return nil, fmt.Errorf("unsupported storage scope: %s", scope)
	}

	if existing := sc.storages[scope]; existing != nil {
		return existing, nil
	}

	storage := newDeviceStorage(sc.persistence, storeLocation{kind: storeLocationPlugin}, sc.logger)
	sc.storages[scope] = storage

	ns := getPluginNamespaces(sc.pluginInfo.ID)
	cleanup, err := sc.client.RegisterHandler(ns.PluginStorageRPC, storage)
	if err != nil {
		return nil, fmt.Errorf("failed to register storage RPC handler: %w", err)
	}
	storage.closeHandler = cleanup

	return storage, nil
}

// createCameraStorage creates storage for a specific camera.
func (sc *StorageController) createCameraStorage(cameraID string) (*DeviceStorage, error) {
	key := "camera." + cameraID
	if existing := sc.storages[key]; existing != nil {
		return existing, nil
	}

	loc := storeLocation{kind: storeLocationCamera, cameraID: cameraID}
	storage := newDeviceStorage(sc.persistence, loc, sc.logger)
	sc.storages[key] = storage

	ns := getPluginCameraNamespaces(sc.pluginInfo.ID, cameraID)
	cleanup, err := sc.client.RegisterHandler(ns.CameraStorageRPC, storage)
	if err != nil {
		return nil, fmt.Errorf("failed to register camera storage RPC: %w", err)
	}
	storage.closeHandler = cleanup

	return storage, nil
}

// createSensorStorage creates storage for a specific sensor. The store keys
// sensor data by type and name (stable across restarts); sensorID only scopes
// the RPC namespace.
func (sc *StorageController) createSensorStorage(cameraID, sensorID, sensorType, sensorName string) (*DeviceStorage, error) {
	key := "sensor." + sensorID
	if existing := sc.storages[key]; existing != nil {
		return existing, nil
	}

	loc := storeLocation{kind: storeLocationSensor, cameraID: cameraID, sensorType: sensorType, sensorName: sensorName}
	storage := newDeviceStorage(sc.persistence, loc, sc.logger)
	sc.storages[key] = storage

	ns := getPluginSensorNamespaces(sc.pluginInfo.ID, cameraID, sensorID)
	cleanup, err := sc.client.RegisterHandler(ns.SensorStorageRPC, storage)
	if err != nil {
		return nil, fmt.Errorf("failed to register sensor storage RPC: %w", err)
	}
	storage.closeHandler = cleanup

	return storage, nil
}

// removeCameraStorage destroys a camera's persisted storage, unregisters its
// RPC handler and drops it from the controller.
func (sc *StorageController) removeCameraStorage(cameraID string) {
	key := "camera." + cameraID
	storage := sc.storages[key]
	if storage == nil {
		return
	}

	if err := storage.Destroy(); err != nil {
		sc.logger.Error("store: destroy camera storage failed:", err)
	}
	storage.unregister()
	delete(sc.storages, key)
}

// close is the runtime-owned teardown, called by the runtime after the plugin's
// SHUTDOWN listeners. Flushes and unregisters every storage — invoked last so
// any final writes from device/sensor cleanup have already landed.
func (sc *StorageController) close() {
	for _, storage := range sc.storages {
		storage.close()
	}
}
