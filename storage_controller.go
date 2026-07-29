package sdk

import (
	"fmt"

	rpc "github.com/cameraui/rpc/go"
)

// StorageController owns every DeviceStorage a plugin uses: the plugin-scoped
// one plus a storage per adopted camera and per registered sensor. Instances
// are cached by scope, so repeated lookups return the same storage.
type StorageController struct {
	client      *rpc.Client
	persistence configPersistence
	pluginInfo  PluginInfo
	logger      *Logger
	storages    map[string]*DeviceStorage
}

func newStorageController(client *rpc.Client, persistence configPersistence, pluginInfo *PluginInfo, logger *Logger) *StorageController {
	return &StorageController{
		client:      client,
		persistence: persistence,
		pluginInfo:  *pluginInfo,
		logger:      logger,
		storages:    make(map[string]*DeviceStorage),
	}
}

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

// sensorID must be the persistent entity id, stable across restarts
func (sc *StorageController) createSensorStorage(sensorID string) (*DeviceStorage, error) {
	key := "sensor." + sensorID
	if existing := sc.storages[key]; existing != nil {
		return existing, nil
	}

	loc := storeLocation{kind: storeLocationSensor, sensorID: sensorID}
	storage := newDeviceStorage(sc.persistence, loc, sc.logger)
	sc.storages[key] = storage

	ns := getPluginSensorNamespaces(sc.pluginInfo.ID, sensorID)
	cleanup, err := sc.client.RegisterHandler(ns.SensorStorageRPC, storage)
	if err != nil {
		return nil, fmt.Errorf("failed to register sensor storage RPC: %w", err)
	}
	storage.closeHandler = cleanup

	return storage, nil
}

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

// runs last in teardown so final writes from device and sensor cleanup have landed
func (sc *StorageController) close() {
	for _, storage := range sc.storages {
		storage.close()
	}
}
