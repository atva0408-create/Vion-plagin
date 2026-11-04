package sdk

import (
	"context"
	"fmt"
	"slices"
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

// SensorManager is the host's view of the sensor registry. Standalone sensors
// are not registered here: a camera's own sensors go through
// CameraDevice.AddSensor, and sensors the user picks from an external
// inventory come in through SensorDiscoveryProvider, bound by the host.
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

	// adopted sensors this plugin handed over, bound to their host records
	owned    map[string]Sensor
	cleanups map[string]func()

	// camera-registered sensors, tracked for event updates only: lifecycle
	// and cleanup stay with the owning CameraDevice
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

// DiscoveredSensor is a sensor a plugin can offer for adoption (see
// SensorDiscoveryProvider).
type DiscoveredSensor struct {
	// ID is the source's stable identity for this sensor, never its address:
	// a Home Assistant entity-registry id, an MQTT unique_id, a vendor device
	// id. It becomes the sensor's nativeId, and a sensor keeps its record,
	// assignments and history for as long as this id stays the same. Using a
	// mutable address (a Home Assistant entity_id) here turns every rename at
	// the source into an orphan plus a new sensor.
	ID string `msgpack:"id" json:"id"`
	// Address is the current address at the source (e.g. a Home Assistant
	// entity id), shown next to the name (optional).
	Address string `msgpack:"address,omitempty" json:"address,omitempty"`
	// Name is the display name shown in the UI adoption list.
	Name string `msgpack:"name" json:"name"`
	// Type is the sensor type the plugin would register the sensor as.
	Type SensorType `msgpack:"type" json:"type"`
	// Room is the room or area label from the source system (optional).
	Room string `msgpack:"room,omitempty" json:"room,omitempty"`
	// Manufacturer is the manufacturer label (optional).
	Manufacturer string `msgpack:"manufacturer,omitempty" json:"manufacturer,omitempty"`
	// Model is the model label (optional).
	Model string `msgpack:"model,omitempty" json:"model,omitempty"`
}

// AdoptedSensor is a sensor the user adopted; what the host hands a
// SensorDiscoveryProvider to build its runtime sensor from.
type AdoptedSensor struct {
	// ID is the persistent registry id, the sensor's id once bound.
	ID string `msgpack:"id" json:"id"`
	// NativeID is the DiscoveredSensor.ID the adoption used.
	NativeID string `msgpack:"nativeId" json:"nativeId"`
	// Address is the last known address at the source, if any.
	Address string `msgpack:"address,omitempty" json:"address,omitempty"`
	// Name is the name at adoption time; the user may have renamed the sensor since.
	Name string `msgpack:"name" json:"name"`
	// Type is the sensor type the plugin offered it as.
	Type SensorType `msgpack:"type" json:"type"`
}

// registerSlots bounds concurrent sensor registrations per plugin process: a
// plugin binding hundreds of sensors at once would put every RPC in flight
// together and let the queue outrun the call timeout on a host that is still
// starting up. Shared with CameraDevice.AddSensor.
var registerSlots = make(chan struct{}, 8)

// GetSensorHistory returns what a set of sensors did during a window of time.
//
// It returns every recorded change between from and to, and for each property
// also the value it already had when the window opened, because a door that was
// open the whole time says as much as one that opened halfway through. Entries
// come back oldest first.
//
// The history is a short tail, not an archive: it is coalesced to one entry per
// second and capped per sensor, so a window far in the past may be gone.
func (m *SensorManager) GetSensorHistory(sensorIDs []string, from, to int64) ([]SensorHistoryEntry, error) {
	ctx := context.Background()
	result, err := m.registryProxy.Invoke(ctx, "getSensorHistory", sensorIDs, from, to)
	if err != nil {
		return nil, fmt.Errorf("getSensorHistory: %w", err)
	}
	if result == nil {
		return nil, nil
	}

	list, ok := result.([]any)
	if !ok {
		return nil, fmt.Errorf("getSensorHistory: unexpected result %T", result)
	}

	return sensorHistoryFromWire(list), nil
}

// sensorHistoryFromWire reads the entries straight off the decoded result
// instead of re-encoding them into the struct: a history value is `any`, and
// decoding msgpack into a struct with an interface field goes through whatever
// the field already holds, which panics on a retry.
func sensorHistoryFromWire(list []any) []SensorHistoryEntry {
	entries := make([]SensorHistoryEntry, 0, len(list))
	for _, item := range list {
		fields, ok := item.(map[string]any)
		if !ok {
			continue
		}
		entry := SensorHistoryEntry{Value: rpc.NormalizeUndefined(fields["value"])}
		entry.SensorID, _ = fields["sensorId"].(string)
		entry.Property, _ = fields["property"].(string)
		entry.Timestamp = wireInt64(fields["timestamp"])
		entries = append(entries, entry)
	}
	return entries
}

// a number crossing msgpack arrives as whichever type the encoder found
// smallest, and as a float when it came from JavaScript
func wireInt64(value any) int64 {
	switch number := value.(type) {
	case int64:
		return number
	case int32:
		return int64(number)
	case int16:
		return int64(number)
	case int8:
		return int64(number)
	case int:
		return int64(number)
	case uint64:
		return int64(number)
	case uint32:
		return int64(number)
	case uint16:
		return int64(number)
	case uint8:
		return int64(number)
	case uint:
		return int64(number)
	case float64:
		return int64(number)
	case float32:
		return int64(number)
	default:
		return 0
	}
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
	consumesSomething := len(m.info.Contract.Consumes) > 0
	if !consumesSomething && !m.providesAdopted() {
		return nil
	}

	if err := m.ensureGlobalSubscription(); err != nil {
		return err
	}
	if !consumesSomething {
		return nil
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

// the host hands the plugin what the user adopted, the plugin hands back one
// runtime sensor per record; nothing is created or dropped here
func (m *SensorManager) configureAdoptedSensors() {
	provider, ok := m.plugin.(SensorDiscoveryProvider)
	if !ok || !m.providesAdopted() {
		return
	}

	records, err := m.ownAdoptedRecords()
	if err != nil {
		m.logger.Warn(fmt.Sprintf("Could not load the adopted sensors: %v", err))
		return
	}

	sensors, err := provider.ConfigureAdoptedSensors(records)
	if err != nil {
		m.logger.Warn(fmt.Sprintf("ConfigureAdoptedSensors failed: %v", err))
		return
	}

	byNativeID := make(map[string]AdoptedSensor, len(records))
	for _, record := range records {
		byNativeID[record.NativeID] = record
	}
	bound := make(map[string]struct{}, len(sensors))
	var wg sync.WaitGroup
	for _, sensor := range sensors {
		if sensor == nil {
			continue
		}
		record, ok := byNativeID[sensor.GetNativeID()]
		if !ok {
			m.logger.Warn(fmt.Sprintf("Sensor %q returned by ConfigureAdoptedSensors has no adopted record (nativeId %q), ignored", sensor.GetName(), sensor.GetNativeID()))
			continue
		}
		if _, dup := bound[record.NativeID]; dup || m.isOwned(record.ID) {
			continue
		}
		bound[record.NativeID] = struct{}{}
		wg.Add(1)
		go func(sensor Sensor, record AdoptedSensor) {
			defer wg.Done()
			m.bindAdopted(sensor, &record)
		}(sensor, record)
	}
	wg.Wait()

	if missing := len(records) - len(bound); missing > 0 {
		m.logger.Warn(fmt.Sprintf("%d adopted sensor(s) got no runtime sensor from the plugin, they stay disconnected", missing))
	}
}

func (m *SensorManager) ownAdoptedRecords() ([]AdoptedSensor, error) {
	result, err := m.registryProxy.Invoke(context.Background(), "getSensors", m.info.ID)
	if err != nil {
		return nil, err
	}
	sensorsRaw, _ := result.([]any)
	records := make([]AdoptedSensor, 0, len(sensorsRaw))
	for _, raw := range sensorsRaw {
		encoded, err := rpc.Encode(raw)
		if err != nil {
			continue
		}
		var data storedSensorData
		if !decodeMsgpack(m.logger, encoded, &data, "storedSensorData") {
			continue
		}
		if m.isOwnAdopted(&data) {
			records = append(records, toAdopted(&data))
		}
	}
	return records, nil
}

func (m *SensorManager) providesAdopted() bool {
	return slices.Contains(m.info.Contract.Interfaces, PluginInterfaceSensorDiscovery)
}

func (m *SensorManager) isOwnAdopted(data *storedSensorData) bool {
	return data.PluginID == m.info.ID && data.BoundCameraID == "" && data.NativeID != ""
}

func (m *SensorManager) isOwned(sensorID string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	_, ok := m.owned[sensorID]
	return ok
}

func (m *SensorManager) bindAdopted(s Sensor, record *AdoptedSensor) {
	registerSlots <- struct{}{}
	defer func() { <-registerSlots }()
	if err := m.bind(s, record.ID); err != nil {
		m.logger.Warn(fmt.Sprintf("Binding adopted sensor %q failed: %v", record.Name, err))
	}
}

// the record exists (adoption), binding attaches the runtime sensor to it
func (m *SensorManager) bind(s Sensor, recordID string) error {
	si, ok := s.(sensorInternalInit)
	if !ok {
		return fmt.Errorf("sensor %s does not embed BaseSensor", s.GetName())
	}

	// producers need the global stream too: assignment changes must reach
	// owned sensors, their detection fan-out reads assignedCameraIds
	if err := m.ensureGlobalSubscription(); err != nil {
		return err
	}

	si.setPluginID(m.info.ID)
	si.setID(recordID)

	sensorJSON := si.ToJSON()

	sensorStorage, err := m.storageCtrl.createSensorStorage(s.GetID())
	if err != nil {
		return fmt.Errorf("failed to create sensor storage: %w", err)
	}
	si.setStorage(sensorStorage)

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
	si.setAssignedCameras(registration.AssignedCameraIDs)

	sensorProviderNS := getSensorProviderNamespaces(m.info.ID, s.GetID())
	rpcCleanup, err := m.client.RegisterHandler(sensorProviderNS.SensorRPC, s)
	if err != nil {
		return fmt.Errorf("failed to register sensor RPC: %w", err)
	}

	sensor := s
	si.initUpdateFn(func(properties map[string]any) {
		ctx := context.Background()
		if isDetectionSensorType(sensor.GetType()) {
			// the spec belongs to the registry, it reaches the coordinators from there
			if spec, ok := properties["modelSpec"]; ok {
				_, _ = m.registryProxy.Invoke(ctx, "updateModelSpec", sensor.GetID(), spec)
				properties = withoutModelSpec(properties)
				if len(properties) == 0 {
					return
				}
			}

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
	si.initSourceUpdateFn(func(patch sensorSourcePatch) {
		ctx := context.Background()
		_, _ = m.registryProxy.Invoke(ctx, "updateSource", sensor.GetID(), patch)
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

func (m *SensorManager) unbind(sensorID string) Sensor {
	m.mu.Lock()
	s, ok := m.owned[sensorID]
	if !ok {
		m.mu.Unlock()
		return nil
	}
	cleanup := m.cleanups[sensorID]
	delete(m.cleanups, sensorID)
	delete(m.owned, sensorID)
	m.mu.Unlock()

	if cleanup != nil {
		cleanup()
	}
	cleanupSensorWithLifecycle(s)
	return s
}

func (m *SensorManager) adoptOwn(record *AdoptedSensor) {
	provider, ok := m.plugin.(SensorDiscoveryProvider)
	if !ok {
		return
	}
	s, err := provider.OnSensorAdopted(*record)
	if err != nil {
		m.logger.Warn(fmt.Sprintf("OnSensorAdopted failed for %q: %v", record.Name, err))
		return
	}
	if s == nil || s.GetNativeID() != record.NativeID {
		nativeID := "missing"
		if s != nil {
			nativeID = s.GetNativeID()
		}
		m.logger.Warn(fmt.Sprintf("Sensor returned by OnSensorAdopted carries nativeId %q, expected %q, ignored", nativeID, record.NativeID))
		return
	}
	m.bindAdopted(s, record)
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

	case "sensor:adopted":
		encoded, err := rpc.Encode(msg.Data)
		if err != nil {
			return
		}
		var adopted sensorAdoptedEventData
		if !decodeMsgpack(m.logger, encoded, &adopted, "sensorAdoptedEventData") {
			return
		}
		if !m.isOwnAdopted(&adopted.Sensor) || !m.providesAdopted() || m.isOwned(adopted.Sensor.ID) {
			return
		}
		record := toAdopted(&adopted.Sensor)
		// the plugin may reach its source to build the sensor, keep the event stream moving
		go m.adoptOwn(&record)

	case "sensor:deleted":
		encoded, err := rpc.Encode(msg.Data)
		if err != nil {
			return
		}
		var deleted sensorDeletedEventData
		if !decodeMsgpack(m.logger, encoded, &deleted, "sensorDeletedEventData") {
			return
		}
		if unbound := m.unbind(deleted.SensorID); unbound != nil && unbound.GetNativeID() != "" && m.providesAdopted() {
			if provider, ok := m.plugin.(SensorDiscoveryProvider); ok {
				if err := provider.OnSensorUnadopted(unbound.GetNativeID()); err != nil {
					m.logger.Warn(fmt.Sprintf("OnSensorUnadopted failed for %s: %v", unbound.GetNativeID(), err))
				}
			}
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

func toAdopted(data *storedSensorData) AdoptedSensor {
	return AdoptedSensor{ID: data.ID, NativeID: data.NativeID, Address: data.Address, Name: data.Name, Type: data.Type}
}
