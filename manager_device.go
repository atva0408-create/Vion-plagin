package sdk

import (
	"context"
	"fmt"
	"sync"

	rpc "github.com/cameraui/rpc/go"
)

// DiscoveredCamera is a camera found during discovery by a discovery provider plugin.
type DiscoveredCamera struct {
	// ID is the discovery ID (typically a stable native identifier).
	ID string `msgpack:"id" json:"id"`
	// Name is the discovered camera display name.
	Name string `msgpack:"name" json:"name"`
	// Manufacturer is the manufacturer name (if known).
	Manufacturer string `msgpack:"manufacturer,omitempty" json:"manufacturer,omitempty"`
	// Model is the model name (if known).
	Model string `msgpack:"model,omitempty" json:"model,omitempty"`
}

// DeviceManager provides camera lookup and discovery operations via RPC.
//
// Use GetCamera to retrieve a camera by ID or name, and PushDiscoveredCameras
// to surface cameras found during async discovery (e.g. after a cloud login).
//
// Accessed via api.DeviceManager from within a plugin.
type DeviceManager struct {
	client            *rpc.Client
	proxy             *rpc.Proxy
	api               *PluginAPI
	storageController *StorageController
	pluginInfo        PluginInfo
	logger            *Logger
	plugin            Plugin

	mu           sync.RWMutex
	devices      map[string]*CameraDevice
	closeRequest func()
}

func newDeviceManager(client *rpc.Client, pluginInfo *PluginInfo, logger *Logger) *DeviceManager {
	ns := getDeviceManagerNamespaces()
	return &DeviceManager{
		client:     client,
		proxy:      client.CreateProxy(ns.DeviceManagerRPC),
		pluginInfo: *pluginInfo,
		logger:     logger,
		devices:    make(map[string]*CameraDevice),
	}
}

// GetCamera retrieves a camera by ID or name. Returns nil if no matching
// camera exists.
func (dm *DeviceManager) GetCamera(cameraIDOrName string) (*CameraDevice, error) {
	dm.mu.RLock()
	for _, dev := range dm.devices {
		if dev.ID() == cameraIDOrName || dev.Name() == cameraIDOrName {
			dm.mu.RUnlock()
			return dev, nil
		}
	}
	dm.mu.RUnlock()

	ctx := context.Background()
	result, err := dm.proxy.Invoke(ctx, "getCamera", cameraIDOrName, dm.pluginInfo.ID)
	if err != nil {
		return nil, fmt.Errorf("getCamera: %w", err)
	}

	if result == nil {
		return nil, nil
	}

	encoded, err := rpc.Encode(result)
	if err != nil {
		return nil, fmt.Errorf("getCamera encode: %w", err)
	}

	var cam Camera
	if err := rpc.Decode(encoded, &cam); err != nil {
		return nil, fmt.Errorf("getCamera decode: %w", err)
	}

	camLogger := dm.logger.CreateLogger(&loggerOptions{
		Suffix:     cam.Name,
		TargetID:   cam.ID,
		TargetType: "camera",
	})
	cameraDevice := newCameraDeviceProxy(dm.client, dm.api, dm.storageController, &cam, &dm.pluginInfo, camLogger)
	if err := cameraDevice.init(); err != nil {
		return nil, fmt.Errorf("init camera device: %w", err)
	}

	dm.mu.Lock()
	dm.devices[cam.ID] = cameraDevice
	dm.mu.Unlock()

	return cameraDevice, nil
}

// PushDiscoveredCameras pushes discovered cameras to the backend so the
// user can pick them in the UI without waiting for the next discovery
// poll. Use this when cameras are discovered asynchronously (e.g. after
// a cloud login or mDNS event).
func (dm *DeviceManager) PushDiscoveredCameras(cameras []DiscoveredCamera) error {
	ns := getDiscoveryManagerNamespaces()
	discoveryProxy := dm.client.CreateProxy(ns.DiscoveryManagerRPC)
	ctx := context.Background()
	_, err := discoveryProxy.Invoke(ctx, "pushDiscoveredCameras", dm.pluginInfo.ID, cameras)
	if err != nil {
		return fmt.Errorf("pushDiscoveredCameras: %w", err)
	}
	return nil
}

func (dm *DeviceManager) setAPI(api *PluginAPI, storageCtrl *StorageController) {
	dm.api = api
	dm.storageController = storageCtrl
}

func (dm *DeviceManager) setPlugin(plugin Plugin) {
	dm.plugin = plugin
}

func (dm *DeviceManager) configureCameras(cameras []*CameraDevice) {
	dm.mu.Lock()
	defer dm.mu.Unlock()
	for _, cam := range cameras {
		dm.devices[cam.ID()] = cam
	}
}

func (dm *DeviceManager) init() error {
	ns := getPluginNamespaces(dm.pluginInfo.ID)

	cleanup, err := dm.client.OnRequest(ns.PluginDeviceManagerSubject, func(data []byte) (any, error) {
		var msg deviceManagerEventMessage
		// Raw wire bytes — may be a CUIB frame when the host request carried
		// large binaries; DecodeMessageInto handles plain msgpack unchanged.
		if err := rpc.DecodeMessageInto(data, &msg); err != nil {
			return nil, err
		}

		switch msg.Type {
		case "cameraAdded":
			dm.handleCameraAdded(msg)
		case "cameraReleased":
			dm.handleCameraReleased(msg)
		}

		return nil, nil
	})
	if err != nil {
		return err
	}
	dm.closeRequest = cleanup
	return nil
}

// close cascades cleanup to each camera device.
func (dm *DeviceManager) close() {
	if dm.closeRequest != nil {
		dm.closeRequest()
		dm.closeRequest = nil
	}

	// Snapshot under the lock, then release it before invoking cleanup — a
	// device cleanup must never run while the manager mutex is held.
	dm.mu.Lock()
	devices := make([]*CameraDevice, 0, len(dm.devices))
	for _, device := range dm.devices {
		devices = append(devices, device)
	}
	dm.devices = make(map[string]*CameraDevice)
	dm.mu.Unlock()

	for _, device := range devices {
		device.cleanup()
	}
}

func (dm *DeviceManager) handleCameraAdded(msg deviceManagerEventMessage) {
	if dm.plugin == nil {
		return
	}

	if msg.Data == nil {
		return
	}

	encoded, err := rpc.Encode(msg.Data)
	if err != nil {
		return
	}

	var addedData cameraAddedEventData
	if err := rpc.Decode(encoded, &addedData); err != nil {
		return
	}

	cam := addedData.Camera

	dm.mu.RLock()
	_, exists := dm.devices[cam.ID]
	dm.mu.RUnlock()

	if exists {
		return
	}

	camLogger := dm.logger.CreateLogger(&loggerOptions{
		Suffix:     cam.Name,
		TargetID:   cam.ID,
		TargetType: "camera",
	})
	cameraDevice := newCameraDeviceProxy(dm.client, dm.api, dm.storageController, &cam, &dm.pluginInfo, camLogger)
	if err := cameraDevice.init(); err != nil {
		return
	}

	dm.mu.Lock()
	dm.devices[cam.ID] = cameraDevice
	dm.mu.Unlock()

	if err := dm.plugin.OnCameraAdded(cameraDevice); err != nil {
		dm.logger.Error("OnCameraAdded failed:", err)
	}
}

func (dm *DeviceManager) handleCameraReleased(msg deviceManagerEventMessage) {
	if dm.plugin == nil {
		return
	}

	if msg.Data == nil {
		return
	}

	encoded, err := rpc.Encode(msg.Data)
	if err != nil {
		return
	}

	var releasedData cameraReleasedEventData
	if err := rpc.Decode(encoded, &releasedData); err != nil {
		return
	}

	cameraID := releasedData.CameraID
	if cameraID == "" {
		return
	}

	if err := dm.plugin.OnCameraReleased(cameraID); err != nil {
		dm.logger.Error("OnCameraReleased failed:", err)
	}

	dm.mu.Lock()
	device, exists := dm.devices[cameraID]
	if exists {
		delete(dm.devices, cameraID)
	}
	dm.mu.Unlock()

	if device != nil {
		device.cleanup()
	}

	if dm.storageController != nil {
		dm.storageController.removeCameraStorage(cameraID)
	}
}
