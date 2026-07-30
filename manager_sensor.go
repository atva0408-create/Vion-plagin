package sdk

import (
	"context"
	"fmt"
	"sync"

	rpc "github.com/cameraui/rpc/go"
)

// SensorConsumer is an OPTIONAL interface plugins implement to consume other
// plugins' sensors. The host builds the consumable view from the plugin
// contract: sensors whose type is listed in `consumes` and that the user
// exposed. Only bridge plugins implement this.
type SensorConsumer interface {
	// ConfigureSensors is called once on startup with every sensor this
	// plugin may consume. Each sensor carries type, assigned cameras and
	// connected state, so consumers decide rendering purely from that data.
	ConfigureSensors(sensors []Sensor) error
	// OnSensorAdded is called when a sensor enters this plugin's consumable
	// view at runtime: it was created, became exposed, or its type became
	// consumable.
	OnSensorAdded(sensor Sensor) error
	// OnSensorReleased is called when a sensor permanently leaves the
	// consumable view: it was deleted or unexposed. Plugin connectivity does
	// NOT fire this; watch OnConnectedChanged on the sensor for that.
	OnSensorReleased(sensorID string) error
}

// SensorManager registers standalone sensors: devices that are not part of a
// camera's hardware (smart plugs, imported smart-home devices, hubs).
//
// The host persists each sensor as its own entity: the user assigns it to
// cameras, renames it and decides whether it is exported or not.
// Sensors that belong to a camera's hardware are registered via
// CameraDevice.AddSensor instead.
//
// Accessed via api.SensorManager in plugins.
type SensorManager struct {
	mu            sync.RWMutex
	client        *rpc.Client
	registryProxy *rpc.Proxy
	storageCtrl   *StorageController
	info          PluginInfo
	logger        *Logger
	plugin        Plugin

	owned    map[string]Sensor
	cleanups map[string]func()

	// camera-registered sensors, tracked for event updates only: lifecycle,
	// cleanup and GetSensors stay with the owning CameraDevice
	external map[string]Sensor

	// consumable view: exposed foreign sensors of consumed types
	consumed       map[string]*sensorProxy
	unsubGlobal    func()
	unsubReconnect func()
}

func newSensorManager(client *rpc.Client, storageCtrl *StorageController, pluginInfo *PluginInfo, logger *Logger) *SensorManager {
	registryNS := getSensorRegistryNamespaces()
	return &SensorManager{
		client:        client,
		registryProxy: client.CreateProxy(registryNS.SensorsRPC),
		storageCtrl:   storageCtrl,
		info:          *pluginInfo,
		logger:        logger,
		owned:         make(map[string]Sensor),
		cleanups:      make(map[string]func()),
		external:      make(map[string]Sensor),
		consumed:      make(map[string]*sensorProxy),
	}
}

// AddSensor registers a standalone sensor with the host.
//
// The host reconciles it against the persisted entity by (pluginId, nativeId),
// or by (type, name) when no native id is set, and replaces the sensor's
// provisional id with the persistent entity id. Camera assignment is the user's
// decision and happens in the UI.
//
// Example:
//
//	lock := sdk.NewLockControl("Front Door", sdk.WithNativeID("lock.front_door"))
//	err := api.SensorManager.AddSensor(lock)
func (m *SensorManager) AddSensor(s Sensor) error {
	si, ok := s.(sensorInternalInit)
	if !ok {
		return fmt.Errorf("sensor %s does not embed BaseSensor", s.GetName())
	}
	si.setPluginID(m.info.ID)

	// producers need the global stream too: assignment changes must reach
	// owned sensors, their detection fan-out reads assignedCameraIds
	if err := m.ensureGlobalSubscription(); err != nil {
		return err
	}

	sensorJSON := si.ToJSON()
	sensorJSON.ModelSpec = detectorModelSpec(s)

	ctx := context.Background()
	registerResult, err := m.registryProxy.Invoke(ctx, "registerSensor", sensorJSON, m.info.ID)
	if err != nil {
		return fmt.Errorf("failed to register sensor: %w", err)
	}
	registration, err := decodeSensorRegistration(registerResult)
	if err != nil {
		return fmt.Errorf("failed to decode sensor registration: %w", err)
	}
	si.setID(registration.ID)
	si.setAssignedCameras(registration.AssignedCameraIDs)

	sensorProviderNS := getSensorProviderNamespaces(m.info.ID, s.GetID())
	rpcCleanup, err := m.client.RegisterHandler(sensorProviderNS.SensorRPC, s)
	if err != nil {
		return fmt.Errorf("failed to register sensor RPC: %w", err)
	}

	sensorStorage, err := m.storageCtrl.createSensorStorage(s.GetID())
	if err != nil {
		_ = rpcCleanup()
		return fmt.Errorf("failed to create sensor storage: %w", err)
	}
	si.setStorage(sensorStorage)

	sensor := s
	si.initUpdateFn(func(properties map[string]any) {
		ctx := context.Background()
		if isDetectionSensorType(sensor.GetType()) {
			// external detection provider: fan the write into every assigned
			// camera's coordinator
			for _, cameraID := range sensor.GetAssignedCameraIDs() {
				detectionNS := getFrameWorkerDetectionNamespaces(cameraID)
				coordinator := m.client.CreateProxy(detectionNS.DetectionRPC)
				_, _ = coordinator.Invoke(ctx, "reportSensorWrite", sensor.GetID(), sensor.GetType(), properties)
			}
			return
		}
		_, _ = m.registryProxy.Invoke(ctx, "updatePropertyValues", sensor.GetID(), properties)
	})
	si.initCapabilitiesUpdateFn(func(caps []string) {
		ctx := context.Background()
		_, _ = m.registryProxy.Invoke(ctx, "updateCapabilities", sensor.GetID(), caps)
	})

	sensorEventNS := getSensorEventNamespaces(s.GetID())
	unsubBackend, subErr := m.client.Subscribe(sensorEventNS.SensorSubject, func(data []byte) {
		var msg sensorEventMessage
		if !decodeMsgpack(m.logger, data, &msg, "sensorEventMessage") {
			return
		}
		if msg.Type == "property:changed" {
			property, _ := msg.Data["property"].(string)
			if property != "" {
				if bpr, ok := s.(backendPropertyReceiver); ok {
					value := coercePropertyValue(s.GetType(), property, msg.Data["value"])
					// honor the server-side timestamp, like the consumer proxies
					if ts, ok := toInt64(msg.Data["timestamp"]); ok && ts > 0 {
						bpr.setPropertyWithTimestamp(property, value, ts)
					} else {
						bpr.onBackendPropertyChanged(property, value)
					}
				}
			}
		}
	})
	if subErr != nil {
		// the sensor stays registered, only host-side writes are lost
		m.logger.Error(fmt.Sprintf("subscribe sensor events for %s: %v", s.GetID(), subErr))
	}

	m.mu.Lock()
	m.owned[s.GetID()] = s
	m.cleanups[s.GetID()] = func() {
		if unsubBackend != nil {
			unsubBackend()
		}
		_ = rpcCleanup()
	}
	m.mu.Unlock()

	setActiveWithLifecycle(s, true)

	return nil
}

// RemoveSensor unregisters a sensor. The persisted entity stays (shows
// disconnected) unless the user deletes it in the UI.
func (m *SensorManager) RemoveSensor(s Sensor) error {
	ctx := context.Background()
	if _, err := m.registryProxy.Invoke(ctx, "unregisterSensor", s.GetID()); err != nil {
		m.logger.Warn(fmt.Sprintf("Failed to unregister sensor %s: %v", s.GetID(), err))
	}

	m.mu.Lock()
	cleanup := m.cleanups[s.GetID()]
	delete(m.cleanups, s.GetID())
	delete(m.owned, s.GetID())
	m.mu.Unlock()

	if cleanup != nil {
		cleanup()
	}

	cleanupSensorWithLifecycle(s)

	return nil
}

// GetSensors returns all sensors this plugin has registered in this session.
func (m *SensorManager) GetSensors() []Sensor {
	m.mu.RLock()
	defer m.mu.RUnlock()
	result := make([]Sensor, 0, len(m.owned))
	for _, s := range m.owned {
		result = append(result, s)
	}
	return result
}

func (m *SensorManager) setPlugin(plugin Plugin) {
	m.plugin = plugin
}

func (m *SensorManager) trackCameraSensor(s Sensor) error {
	if err := m.ensureGlobalSubscription(); err != nil {
		return err
	}
	m.mu.Lock()
	m.external[s.GetID()] = s
	m.mu.Unlock()
	return nil
}

func (m *SensorManager) untrackCameraSensor(sensorID string) {
	m.mu.Lock()
	delete(m.external, sensorID)
	m.mu.Unlock()
}

func (m *SensorManager) init() error {
	if len(m.info.Contract.Consumes) == 0 {
		return nil
	}

	if err := m.ensureGlobalSubscription(); err != nil {
		return err
	}

	ctx := context.Background()
	result, err := m.registryProxy.Invoke(ctx, "getSensors", m.info.ID)
	if err == nil {
		if sensorsRaw, ok := result.([]any); ok {
			for _, raw := range sensorsRaw {
				encoded, err := rpc.Encode(raw)
				if err != nil {
					continue
				}
				var data storedSensorData
				if !decodeMsgpack(m.logger, encoded, &data, "storedSensorData") {
					continue
				}
				if !m.isConsumable(&data) {
					continue
				}
				m.addConsumed(&data)
			}
		}
	}
	// on error: registry not reachable yet, sensors arrive via events

	if consumer, ok := m.plugin.(SensorConsumer); ok {
		m.mu.RLock()
		sensors := make([]Sensor, 0, len(m.consumed))
		for _, p := range m.consumed {
			sensors = append(sensors, p)
		}
		m.mu.RUnlock()
		// a rejection aborts plugin startup
		if err := consumer.ConfigureSensors(sensors); err != nil {
			return fmt.Errorf("ConfigureSensors failed: %w", err)
		}
	}

	return nil
}

func (m *SensorManager) close() {
	if m.unsubGlobal != nil {
		m.unsubGlobal()
		m.unsubGlobal = nil
	}
	if m.unsubReconnect != nil {
		m.unsubReconnect()
		m.unsubReconnect = nil
	}

	m.mu.Lock()
	consumed := m.consumed
	m.consumed = make(map[string]*sensorProxy)
	cleanups := m.cleanups
	m.cleanups = make(map[string]func())
	owned := m.owned
	m.owned = make(map[string]Sensor)
	m.external = make(map[string]Sensor)
	m.mu.Unlock()

	for _, p := range consumed {
		p.cleanupProxy()
	}
	for _, cleanup := range cleanups {
		cleanup()
	}
	for _, s := range owned {
		cleanupSensorWithLifecycle(s)
	}
}

func (m *SensorManager) ensureGlobalSubscription() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.unsubGlobal != nil {
		return nil
	}

	registryNS := getSensorRegistryNamespaces()
	m.unsubReconnect = m.client.OnReconnect(m.resyncAllConsumed)
	unsub, err := m.client.Subscribe(registryNS.SensorsSubject, func(data []byte) {
		var msg sensorRegistryEventMessage
		if !decodeMsgpack(m.logger, data, &msg, "sensorRegistryEventMessage") {
			return
		}
		m.handleGlobalSensorEvent(msg)
	})
	if err != nil {
		return fmt.Errorf("subscribe sensor registry events: %w", err)
	}
	m.unsubGlobal = unsub
	return nil
}

func (m *SensorManager) isConsumable(data *storedSensorData) bool {
	m.mu.RLock()
	_, isOwned := m.owned[data.ID]
	m.mu.RUnlock()
	if isOwned || data.PluginID == m.info.ID {
		return false
	}
	if !data.Exposed {
		return false
	}
	return containsSensorType(m.info.Contract.Consumes, data.Type)
}

func (m *SensorManager) addConsumed(data *storedSensorData) *sensorProxy {
	m.mu.Lock()
	if existing, ok := m.consumed[data.ID]; ok {
		m.mu.Unlock()
		return existing
	}
	proxy := newSensorProxy(m.client, m.logger, data)
	m.consumed[data.ID] = proxy
	m.mu.Unlock()
	return proxy
}

// a dropped link loses every event published while it was down, so the whole
// consumed view is refetched rather than trusted
func (m *SensorManager) resyncAllConsumed() {
	m.mu.RLock()
	ids := make([]string, 0, len(m.consumed))
	for id := range m.consumed {
		ids = append(ids, id)
	}
	m.mu.RUnlock()

	for _, id := range ids {
		m.resyncConsumed(id)
	}
}

func (m *SensorManager) resyncConsumed(sensorID string) {
	m.mu.RLock()
	proxy := m.consumed[sensorID]
	m.mu.RUnlock()
	if proxy == nil {
		return
	}

	result, err := m.registryProxy.Invoke(context.Background(), "getSensorState", sensorID)
	if err != nil || result == nil {
		return
	}
	encoded, err := rpc.Encode(result)
	if err != nil {
		return
	}
	var state sensorRefreshedState
	if !decodeMsgpack(m.logger, encoded, &state, "sensorRefreshedState") {
		return
	}

	proxy.applyRefreshedState(state)
}

func (m *SensorManager) releaseConsumed(sensorID string) {
	m.mu.Lock()
	proxy, ok := m.consumed[sensorID]
	if ok {
		delete(m.consumed, sensorID)
	}
	m.mu.Unlock()
	if !ok {
		return
	}

	proxy.cleanupProxy()

	if consumer, ok := m.plugin.(SensorConsumer); ok {
		if err := consumer.OnSensorReleased(sensorID); err != nil {
			m.logger.Warn(fmt.Sprintf("OnSensorReleased failed: %v", err))
		}
	}
}

func (m *SensorManager) handleGlobalSensorEvent(msg sensorRegistryEventMessage) {
	switch msg.Type {
	case "sensor:added":
		encoded, err := rpc.Encode(msg.Data)
		if err != nil {
			return
		}
		var added sensorAddedEventData
		if !decodeMsgpack(m.logger, encoded, &added, "sensorAddedEventData") {
			return
		}

		m.mu.RLock()
		owned := m.owned[added.Sensor.ID]
		external := m.external[added.Sensor.ID]
		consumed := m.consumed[added.Sensor.ID]
		m.mu.RUnlock()
		alreadyConsumed := consumed != nil

		for _, target := range []Sensor{owned, external} {
			if target == nil {
				continue
			}
			if si, ok := target.(sensorInternalInit); ok {
				si.setAssignedCameras(added.Sensor.AssignedCameraIDs)
			}
		}
		if alreadyConsumed {
			// re-announced while we already hold it: the payload carries the
			// authoritative state, so take it instead of keeping a stale view
			consumed.applyRefreshedState(added.State)
			return
		}
		if !m.isConsumable(&added.Sensor) {
			return
		}
		proxy := m.addConsumed(&added.Sensor)
		if consumer, ok := m.plugin.(SensorConsumer); ok {
			if err := consumer.OnSensorAdded(proxy); err != nil {
				m.logger.Warn(fmt.Sprintf("OnSensorAdded failed: %v", err))
			}
		}

	case "sensor:deleted":
		encoded, err := rpc.Encode(msg.Data)
		if err != nil {
			return
		}
		var deleted sensorDeletedEventData
		if !decodeMsgpack(m.logger, encoded, &deleted, "sensorDeletedEventData") {
			return
		}
		m.releaseConsumed(deleted.SensorID)

	case "sensor:connected:changed":
		encoded, err := rpc.Encode(msg.Data)
		if err != nil {
			return
		}
		var connected sensorConnectedChangedData
		if !decodeMsgpack(m.logger, encoded, &connected, "sensorConnectedChangedData") {
			return
		}
		m.mu.RLock()
		proxy := m.consumed[connected.SensorID]
		m.mu.RUnlock()
		if proxy != nil {
			proxy.setConnected(connected.Connected)
			if connected.Connected {
				// the owner was away, whatever it published in the meantime never reached us
				go m.resyncConsumed(connected.SensorID)
			}
		}

	case "sensor:exposed:changed":
		encoded, err := rpc.Encode(msg.Data)
		if err != nil {
			return
		}
		var exposed sensorExposedChangedData
		if !decodeMsgpack(m.logger, encoded, &exposed, "sensorExposedChangedData") {
			return
		}
		if !exposed.Exposed {
			m.releaseConsumed(exposed.SensorID)
			return
		}
		m.mu.RLock()
		alreadyConsumed := m.consumed[exposed.SensorID] != nil
		m.mu.RUnlock()
		if alreadyConsumed {
			return
		}

		ctx := context.Background()
		result, err := m.registryProxy.Invoke(ctx, "getSensorRpc", exposed.SensorID, m.info.ID)
		if err != nil || result == nil {
			return
		}
		encoded, err = rpc.Encode(result)
		if err != nil {
			return
		}
		var data storedSensorData
		if !decodeMsgpack(m.logger, encoded, &data, "storedSensorData") {
			return
		}
		if !m.isConsumable(&data) {
			return
		}
		proxy := m.addConsumed(&data)
		if consumer, ok := m.plugin.(SensorConsumer); ok {
			if err := consumer.OnSensorAdded(proxy); err != nil {
				m.logger.Warn(fmt.Sprintf("OnSensorAdded failed: %v", err))
			}
		}

	case "sensor:assignment:changed":
		encoded, err := rpc.Encode(msg.Data)
		if err != nil {
			return
		}
		var assignment sensorAssignmentChangedData
		if !decodeMsgpack(m.logger, encoded, &assignment, "sensorAssignmentChangedData") {
			return
		}

		m.mu.RLock()
		targets := make([]Sensor, 0, 3)
		if s, ok := m.owned[assignment.SensorID]; ok {
			targets = append(targets, s)
		}
		if s, ok := m.external[assignment.SensorID]; ok {
			targets = append(targets, s)
		}
		if p, ok := m.consumed[assignment.SensorID]; ok {
			targets = append(targets, p)
		}
		m.mu.RUnlock()

		for _, target := range targets {
			cameras := target.GetAssignedCameraIDs()
			next := make([]string, 0, len(cameras)+1)
			for _, id := range cameras {
				if id != assignment.CameraID {
					next = append(next, id)
				}
			}
			if assignment.Assigned {
				next = append(next, assignment.CameraID)
			}
			if si, ok := target.(sensorInternalInit); ok {
				si.setAssignedCameras(next)
			}
		}
	}
}
