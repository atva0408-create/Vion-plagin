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
	storage := sc.storages[key]
	if storage == nil {
		loc := storeLocation{kind: storeLocationCamera, cameraID: cameraID}
		storage = newDeviceStorage(sc.persistence, loc, sc.logger)
		sc.storages[key] = storage
	}

	// a re-added camera reuses the released storage, only the handler needs to come back
	if storage.closeHandler == nil {
		ns := getPluginCameraNamespaces(sc.pluginInfo.ID, cameraID)
		cleanup, err := sc.client.RegisterHandler(ns.CameraStorageRPC, storage)
		if err != nil {
			return nil, fmt.Errorf("failed to register camera storage RPC: %w", err)
		}
		storage.closeHandler = cleanup
	}

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

// a released camera can come back via toggle, keep schemas and persisted values, only the handler goes away
func (sc *StorageController) releaseCameraStorage(cameraID string) {
	if storage := sc.storages["camera."+cameraID]; storage != nil {
		storage.unregister()
	}
}

// runs last in teardown so final writes from device and sensor cleanup have landed
func (sc *StorageController) close() {
	for _, storage := range sc.storages {
		storage.close()
	}
}
