package sdk

import (
	"context"
	"fmt"
	"reflect"
	"sync"
	"time"

	rpc "github.com/cameraui/rpc/go"
)

// StreamingInterface is optionally implemented to provide stream URLs.
type StreamingInterface interface {
	// StreamUrl returns the streaming URL for a source (e.g. rtsp://, rtmp://, or custom protocol).
	StreamUrl(sourceID string) (string, error)
}

// SnapshotInterface is optionally implemented to provide snapshots.
type SnapshotInterface interface {
	// Snapshot returns a snapshot image from the camera. When forceNew is true, the cache is bypassed for a fresh snapshot.
	Snapshot(sourceID string, forceNew bool) ([]byte, error)
}

type sensorInternalInit interface {
	setCameraID(id string)
	setPluginID(id string)
	setStorage(storage *DeviceStorage)
	initUpdateFn(updateFn propertyUpdateFn)
	initCapabilitiesUpdateFn(updateFn func([]string))
	setAssigned(assigned bool)
}

type backendPropertyReceiver interface {
	onBackendPropertyChanged(property string, value any)
}

// CameraDevice represents a camera assigned to this plugin.
// Plugins receive CameraDevice instances in ConfigureCameras and OnCameraAdded.
type CameraDevice struct {
	mu     sync.RWMutex
	client *rpc.Client
	api    *PluginAPI
	camera Camera
	info   PluginInfo
	logger *Logger

	controllerProxy *rpc.Proxy
	sensorCtrlProxy *rpc.Proxy
	sources         []*CameraDeviceSource
	sensors         []Sensor
	storageDevice   *DeviceStorage
	storageCtrl     *StorageController
	proxySensors    map[string]*sensorProxy
	initialized     bool

	cameraSubject    *BehaviorSubject[Camera]
	cameraState      *BehaviorSubject[bool]
	frameWorkerState *BehaviorSubject[bool]
	sensorAdded      *Subject[sensorEvent]
	sensorRemoved    *Subject[sensorEvent]
	detectionEvent   *Subject[DetectionEventData]

	impl       any
	cleanupFns []func()
}

func newCameraDeviceProxy(
	client *rpc.Client,
	api *PluginAPI,
	storageCtrl *StorageController,
	cam *Camera,
	pluginInfo *PluginInfo,
	logger *Logger,
) *CameraDevice {
	camNS := getCameraNamespaces(cam.ID)
	sensorCtrlNS := getSensorControllerNamespaces(cam.ID)

	dev := &CameraDevice{
		client:           client,
		api:              api,
		camera:           *cam,
		info:             *pluginInfo,
		logger:           logger,
		controllerProxy:  client.CreateProxy(camNS.CameraControllerRPC),
		sensorCtrlProxy:  client.CreateProxy(sensorCtrlNS.SensorRPC),
		storageCtrl:      storageCtrl,
		proxySensors:     make(map[string]*sensorProxy),
		cameraSubject:    NewBehaviorSubject(*cam),
		cameraState:      NewBehaviorSubject(false),
		frameWorkerState: NewBehaviorSubject(false),
		sensorAdded:      NewSubject[sensorEvent](),
		sensorRemoved:    NewSubject[sensorEvent](),
		detectionEvent:   NewSubject[DetectionEventData](),
	}

	dev.sources = make([]*CameraDeviceSource, 0, len(cam.Sources))
	for i := range cam.Sources {
		src := cam.Sources[i]
		rewriteStreamUrlsForRemote(&src.Urls)
		dev.sources = append(dev.sources, &CameraDeviceSource{
			input:  src,
			device: dev,
		})
	}

	return dev
}

// ID returns the camera ID.
func (d *CameraDevice) ID() string {
	return d.camera.ID
}

// NativeID returns the native device ID from the plugin, or empty string if not set.
func (d *CameraDevice) NativeID() string {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.camera.NativeID
}

// PluginInfo returns the source plugin information, or nil if not set.
func (d *CameraDevice) PluginInfo() *CameraPluginInfo {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.camera.PluginInfo
}

// Disabled returns whether the camera is disabled.
func (d *CameraDevice) Disabled() bool {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.camera.Disabled
}

// Snooze returns whether detections are snoozed (paused).
func (d *CameraDevice) Snooze() bool {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.camera.DetectionSettings.Snooze
}

// Name returns the camera name.
func (d *CameraDevice) Name() string {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.camera.Name
}

// Room returns the room this camera belongs to.
func (d *CameraDevice) Room() string {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.camera.Room
}

// Type returns the camera type (camera/doorbell).
func (d *CameraDevice) Type() CameraType {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.camera.Type
}

// SnapshotSettings returns the snapshot settings.
func (d *CameraDevice) SnapshotSettings() SnapshotSettings {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.camera.SnapshotSettings
}

// Info returns the camera hardware information.
func (d *CameraDevice) Info() CameraInformation {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.camera.Info
}

// IsCloud returns whether the camera streams from cloud.
func (d *CameraDevice) IsCloud() bool {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.camera.IsCloud
}

// DetectionZones returns the detection zone configurations.
func (d *CameraDevice) DetectionZones() []DetectionZone {
	d.mu.RLock()
	defer d.mu.RUnlock()
	zones := make([]DetectionZone, len(d.camera.DetectionZones))
	copy(zones, d.camera.DetectionZones)
	return zones
}

// DetectionLines returns the detection line configurations (virtual tripwires).
func (d *CameraDevice) DetectionLines() []DetectionLine {
	d.mu.RLock()
	defer d.mu.RUnlock()
	lines := make([]DetectionLine, len(d.camera.DetectionLines))
	copy(lines, d.camera.DetectionLines)
	return lines
}

// DetectionSettings returns the detection settings.
func (d *CameraDevice) DetectionSettings() CameraDetectionSettings {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.camera.DetectionSettings
}

// PTZAutotrack returns the PTZ autotracking settings.
func (d *CameraDevice) PTZAutotrack() PtzAutotrackSettings {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.camera.PtzAutotrack
}

// FrameWorkerSettings returns the frame worker settings.
func (d *CameraDevice) FrameWorkerSettings() CameraFrameWorkerSettings {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.camera.FrameWorkerSettings
}

// InterfaceSettings returns the UI display settings.
func (d *CameraDevice) InterfaceSettings() CameraUiSettings {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.camera.InterfaceSettings
}

// Logger returns the camera's logger.
func (d *CameraDevice) Logger() *Logger {
	return d.logger
}

// Storage returns the camera's device storage.
func (d *CameraDevice) Storage() *DeviceStorage {
	return d.storageDevice
}

// Sources returns the camera's source list.
func (d *CameraDevice) Sources() []*CameraDeviceSource {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.sources
}

// StreamSource returns the primary streaming source (first high-resolution, or first available).
func (d *CameraDevice) StreamSource() *CameraDeviceSource {
	d.mu.RLock()
	defer d.mu.RUnlock()
	for _, src := range d.sources {
		if src.input.Role == CameraRoleHighRes {
			return src
		}
	}
	if len(d.sources) > 0 {
		return d.sources[0]
	}
	return nil
}

// HighResolutionSource returns the high-resolution source.
func (d *CameraDevice) HighResolutionSource() *CameraDeviceSource {
	return d.getSourceByRole(CameraRoleHighRes)
}

// MidResolutionSource returns the mid-resolution source.
func (d *CameraDevice) MidResolutionSource() *CameraDeviceSource {
	return d.getSourceByRole(CameraRoleMidRes)
}

// LowResolutionSource returns the low-resolution source.
func (d *CameraDevice) LowResolutionSource() *CameraDeviceSource {
	return d.getSourceByRole(CameraRoleLowRes)
}

// SnapshotSource returns the snapshot source.
func (d *CameraDevice) SnapshotSource() *CameraDeviceSource {
	return d.getSourceByRole(CameraRoleSnapshot)
}

// GetSourceByID returns a source by its ID.
func (d *CameraDevice) GetSourceByID(id string) *CameraDeviceSource {
	d.mu.RLock()
	defer d.mu.RUnlock()
	for _, src := range d.sources {
		if src.input.ID == id {
			return src
		}
	}
	return nil
}

// Implement registers a camera implementation for streaming and/or snapshot.
// The impl value should implement StreamingInterface, SnapshotInterface, or both.
func (d *CameraDevice) Implement(impl any) error {
	d.mu.Lock()
	d.impl = impl
	d.mu.Unlock()

	pluginCamNS := getPluginCameraNamespaces(d.info.ID, d.camera.ID)
	cleanup, err := d.client.RegisterHandler(pluginCamNS.CameraImplRPC, impl)
	if err != nil {
		return fmt.Errorf("failed to register camera impl RPC: %w", err)
	}
	d.cleanupFns = append(d.cleanupFns, func() { _ = cleanup() })
	return nil
}

// Connect tells the server this camera is online.
// Only the plugin that owns this camera (via pluginInfo) may connect it.
func (d *CameraDevice) Connect() error {
	if d.camera.PluginInfo == nil || d.camera.PluginInfo.ID != d.info.ID {
		return nil
	}
	ctx := context.Background()
	_, err := d.controllerProxy.Invoke(ctx, "connect")
	return err
}

// Disconnect tells the server this camera is offline.
// Only the plugin that owns this camera (via pluginInfo) may disconnect it.
func (d *CameraDevice) Disconnect() error {
	if d.camera.PluginInfo == nil || d.camera.PluginInfo.ID != d.info.ID {
		return nil
	}
	ctx := context.Background()
	_, err := d.controllerProxy.Invoke(ctx, "disconnect")
	return err
}

// AddSensor adds a sensor to this camera.
func (d *CameraDevice) AddSensor(s Sensor) error {
	// Wire internal state via package-local interface (unexported methods).
	if si, ok := s.(sensorInternalInit); ok {
		si.setCameraID(d.camera.ID)
		si.setPluginID(d.info.ID)
	}

	d.mu.Lock()
	d.sensors = append(d.sensors, s)
	d.mu.Unlock()

	// Register sensor as RPC handler — all exported methods are automatically
	// exposed as camelCase RPC endpoints.
	sensorProviderNS := getSensorProviderNamespaces(d.info.ID, d.camera.ID, s.GetID())
	sensorCleanup, err := d.client.RegisterHandler(sensorProviderNS.SensorRPC, s)
	if err != nil {
		return fmt.Errorf("failed to register sensor RPC: %w", err)
	}
	d.cleanupFns = append(d.cleanupFns, func() { _ = sensorCleanup() })

	sensorStorage, err := d.storageCtrl.createSensorStorage(d.camera.ID, s.GetID(), string(s.GetType()), s.GetName())
	if err != nil {
		return fmt.Errorf("failed to create sensor storage: %w", err)
	}
	if si, ok := s.(sensorInternalInit); ok {
		si.setStorage(sensorStorage)
	}

	// Init sensor with property update callback via SensorController RPC.
	// Detection-sensor writes route directly to the FrameWorker DetectionCoordinator;
	// non-detection-sensor writes go to the SensorController batch endpoint.
	sensorCtrlNS := getSensorControllerNamespaces(d.camera.ID)
	sensorCtrlProxy := d.client.CreateProxy(sensorCtrlNS.SensorRPC)
	frameWorkerDetectionNS := getFrameWorkerDetectionNamespaces(d.camera.ID)
	detectionCoordinatorProxy := d.client.CreateProxy(frameWorkerDetectionNS.DetectionRPC)
	if si, ok := s.(sensorInternalInit); ok {
		sensor := s
		si.initUpdateFn(func(properties map[string]any) {
			ctx := context.Background()
			if isDetectionSensorType(sensor.GetType()) {
				// Detection sensors route directly to the FrameWorker
				// DetectionCoordinator (bypassing the main process). If the
				// FrameWorker isn't running, drop the write — the detection
				// pipeline isn't running so there's nowhere for it to go.
				if !d.frameWorkerState.Value() {
					return
				}
				if _, err := detectionCoordinatorProxy.Invoke(ctx, "reportSensorWrite", sensor.GetID(), sensor.GetType(), properties); err != nil {
					d.logger.Warn(fmt.Sprintf("Failed to forward sensor write to coordinator for %s: %v", sensor.GetID(), err))
				}
				return
			}
			_, _ = sensorCtrlProxy.Invoke(ctx, "updatePropertyValues", sensor.GetID(), properties)
		})
		si.initCapabilitiesUpdateFn(func(caps []string) {
			ctx := context.Background()
			_, _ = sensorCtrlProxy.Invoke(ctx, "updateCapabilities", s.GetID(), caps)
		})
	}

	ctx := context.Background()
	sensorJSON := s.ToJSON()

	// Inject modelSpec for detector sensors: detector interfaces define ModelSpec()
	// but the base ToJSON() doesn't include it.
	switch v := s.(type) {
	case ObjectDetector:
		sensorJSON.ModelSpec = v.ModelSpec()
	case FaceDetector:
		sensorJSON.ModelSpec = v.ModelSpec()
	case LicensePlateDetector:
		sensorJSON.ModelSpec = v.ModelSpec()
	case AudioDetector:
		sensorJSON.ModelSpec = v.ModelSpec()
	case ClassifierDetector:
		sensorJSON.ModelSpec = v.ModelSpec()
	}

	// registerSensor returns a boolean indicating whether the user has
	// activated this sensor type from this plugin in the camera drawer.
	// `true` → sensor is live for this camera (fire OnAssigned).
	// `false` → sensor is just known to the server but not picked yet;
	//           a later `sensor:assignment:changed` event will flip it on
	//           if the user activates it in the UI.
	registerResult, err := d.controllerProxy.Invoke(ctx, "registerSensor", sensorJSON, d.info.ID)
	if err != nil {
		return fmt.Errorf("failed to register sensor: %w", err)
	}
	isAssigned, _ := registerResult.(bool)

	// Mirror the server's assignment verdict into the sensor (updates the
	// isAssigned flag + OnAssignmentChanged observable + assignmentLifecycle
	// hook). If the user hasn't activated this sensor yet, this is a no-op.
	setAssignedWithLifecycle(s, isAssigned)

	// Subscribe to backend-initiated property changes for owned sensors.
	// This syncs properties back when backend changes them (e.g., motion dwell timer).
	sensorEventNS := getSensorEventNamespaces(d.camera.ID, s.GetID())
	unsubBackend, err := d.client.Subscribe(sensorEventNS.SensorSubject, func(data []byte) {
		var msg sensorEventMessage
		if !decodeMsgpack(d.logger, data, &msg, "sensorEventMessage") {
			return
		}
		if msg.Type == "property:changed" {
			property, _ := msg.Data["property"].(string)
			if property != "" {
				if bpr, ok := s.(backendPropertyReceiver); ok {
					bpr.onBackendPropertyChanged(property, coercePropertyValue(s.GetType(), property, msg.Data["value"]))
				}
			}
		}
	})
	if err == nil && unsubBackend != nil {
		d.cleanupFns = append(d.cleanupFns, unsubBackend)
	}

	return nil
}

// RemoveSensor removes a sensor from this camera.
func (d *CameraDevice) RemoveSensor(sensorID string) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	for i, s := range d.sensors {
		if s.GetID() == sensorID {
			d.sensors = append(d.sensors[:i], d.sensors[i+1:]...)

			// Notify the sensor it is no longer assigned, plus dispatch
			// the assignmentLifecycle.OnDeassigned hook if implemented.
			setAssignedWithLifecycle(s, false)

			ctx := context.Background()
			_, _ = d.controllerProxy.Invoke(ctx, "unregisterSensor", sensorID)

			return nil
		}
	}
	return fmt.Errorf("sensor not found: %s", sensorID)
}

// GetSensors returns all sensors on this camera (owned + foreign).
func (d *CameraDevice) GetSensors() []Sensor {
	d.mu.RLock()
	defer d.mu.RUnlock()
	result := make([]Sensor, 0, len(d.sensors)+len(d.proxySensors))
	result = append(result, d.sensors...)
	for _, p := range d.proxySensors {
		result = append(result, p)
	}
	return result
}

// GetSensor returns a sensor by its ID (checks both owned and foreign).
func (d *CameraDevice) GetSensor(id string) Sensor {
	d.mu.RLock()
	defer d.mu.RUnlock()
	for _, s := range d.sensors {
		if s.GetID() == id {
			return s
		}
	}
	if p, ok := d.proxySensors[id]; ok {
		return p
	}
	return nil
}

// GetSensorsByType returns all sensors of the given type (owned + foreign).
func (d *CameraDevice) GetSensorsByType(sensorType SensorType) []Sensor {
	d.mu.RLock()
	defer d.mu.RUnlock()
	var result []Sensor
	for _, s := range d.sensors {
		if s.GetType() == sensorType {
			result = append(result, s)
		}
	}
	for _, p := range d.proxySensors {
		if p.GetType() == sensorType {
			result = append(result, p)
		}
	}
	return result
}

// OnSensorAdded registers a callback for when a sensor from another plugin is added,
// and only when its type is listed in contract.consumes. This plugin's own sensors do
// not fire it.
// The callback receives (sensorID, sensorType). Returns a Disposable to unsubscribe.
func (d *CameraDevice) OnSensorAdded(callback func(sensorID string, sensorType SensorType)) *Disposable {
	return d.sensorAdded.Subscribe(func(e sensorEvent) {
		callback(e.SensorID, e.SensorType)
	})
}

// OnSensorRemoved registers a callback for when a sensor is removed from this camera.
// Unlike OnSensorAdded it is not filtered: it fires for this plugin's own sensors and
// for other plugins' sensors alike.
// Returns a Disposable to unsubscribe.
func (d *CameraDevice) OnSensorRemoved(callback func(string, SensorType)) *Disposable {
	return d.sensorRemoved.Subscribe(func(e sensorEvent) {
		callback(e.SensorID, e.SensorType)
	})
}

// OnDetectionEvent registers a callback for detection events (start/update/end and
// segment-start/segment-update/segment-end).
// Segments only ship on the segment-* events; the 'end' message carries none.
// Thumbnails are inline in the segment structures: detection and attribute crops on
// 'segment-start' and 'segment-end', the scene thumbnail also once on the first
// 'segment-update' after it becomes available.
// Returns a Disposable to unsubscribe.
func (d *CameraDevice) OnDetectionEvent(callback func(eventType DetectionEventType, event DetectionEvent)) *Disposable {
	return d.detectionEvent.Subscribe(func(e DetectionEventData) {
		callback(e.Type, e.Event)
	})
}

// Connected returns whether the camera is currently connected.
func (d *CameraDevice) Connected() bool {
	return d.cameraState.Value()
}

// FrameWorkerConnected returns whether the frame worker is currently connected.
func (d *CameraDevice) FrameWorkerConnected() bool {
	return d.frameWorkerState.Value()
}

// OnPropertyChange returns an Observable that emits when any of the specified camera properties change.
func (d *CameraDevice) OnPropertyChange(properties ...string) *Observable[PropertyChangeEvent] {
	propSet := make(map[string]struct{}, len(properties))
	for _, p := range properties {
		propSet[p] = struct{}{}
	}

	paired := Pairwise(d.cameraSubject.AsObservable())

	mapped := MergeMap(paired, func(pair [2]Camera, _ int) []PropertyChangeEvent {
		oldCam, newCam := pair[0], pair[1]

		changed := changedCameraProps(reflect.ValueOf(oldCam), reflect.ValueOf(newCam))
		events := make([]PropertyChangeEvent, 0, len(changed))
		for _, prop := range changed {
			events = append(events, PropertyChangeEvent{
				Property:  prop,
				OldCamera: oldCam,
				NewCamera: newCam,
			})
		}
		return events
	})

	filtered := Filter(mapped, func(e PropertyChangeEvent) bool {
		if len(propSet) == 0 {
			return true
		}
		_, ok := propSet[e.Property]
		return ok
	})

	return Share(filtered, nil)
}

// OnConnected returns an Observable that emits distinct connection state changes.
func (d *CameraDevice) OnConnected() *Observable[bool] {
	return Share(DistinctUntilChanged(d.cameraState.AsObservable()), nil)
}

// OnFrameWorkerConnected returns an Observable that emits distinct frame worker state changes.
func (d *CameraDevice) OnFrameWorkerConnected() *Observable[bool] {
	return Share(DistinctUntilChanged(d.frameWorkerState.AsObservable()), nil)
}

// OnSensorProperty subscribes to a specific property on a sensor type with full lifecycle management.
// Automatically subscribes/unsubscribes when sensors of the given type are added/removed.
func (d *CameraDevice) OnSensorProperty(sensorType SensorType, property string, callback func(value any, timestamp int64, sensor Sensor)) *Disposable {
	var propertySub *Disposable

	subscribeTo := func(sensor Sensor) {
		if propertySub != nil {
			propertySub.Dispose()
		}
		propertySub = sensor.OnPropertyChanged(func(e SensorPropertyChange) {
			if e.Property == property {
				callback(e.Value, e.Timestamp, sensor)
			}
		})
	}

	// Subscribe to existing sensor
	sensors := d.GetSensorsByType(sensorType)
	if len(sensors) > 0 {
		subscribeTo(sensors[0])
	}

	// Auto-subscribe when sensor is added
	addedSub := d.OnSensorAdded(func(sensorID string, st SensorType) {
		if st == sensorType {
			sensors := d.GetSensorsByType(sensorType)
			if len(sensors) > 0 {
				subscribeTo(sensors[0])
			}
		}
	})

	// Auto-unsubscribe when sensor is removed
	removedSub := d.OnSensorRemoved(func(_ string, st SensorType) {
		if st == sensorType {
			if propertySub != nil {
				propertySub.Dispose()
				propertySub = nil
			}
		}
	})

	return NewDisposable(func() {
		if propertySub != nil {
			propertySub.Dispose()
		}
		addedSub.Dispose()
		removedSub.Dispose()
	})
}

func (d *CameraDevice) init() error {
	d.mu.Lock()
	if d.initialized {
		d.mu.Unlock()
		return nil
	}
	d.initialized = true
	d.mu.Unlock()

	pluginCamNS := getPluginCameraNamespaces(d.info.ID, d.camera.ID)
	sensorCtrlNS := getSensorControllerNamespaces(d.camera.ID)

	st, err := d.storageCtrl.createCameraStorage(d.camera.ID)
	if err != nil {
		return fmt.Errorf("create camera storage: %w", err)
	}
	d.storageDevice = st

	cleanup, err := d.client.RegisterHandler(pluginCamNS.CameraInterfacesRPC, map[string]any{
		"streamUrl": func(sourceID string) (string, error) {
			return d.getStreamURL(sourceID)
		},
		"snapshot": func(sourceID string, forceNew bool) ([]byte, error) {
			return d.getSnapshot(sourceID, forceNew)
		},
	})
	if err != nil {
		return fmt.Errorf("register camera interfaces RPC: %w", err)
	}
	d.cleanupFns = append(d.cleanupFns, func() { _ = cleanup() })

	camEventNS := getCameraNamespaces(d.camera.ID)
	unsub, err := d.client.Subscribe(camEventNS.CameraSubject, func(data []byte) {
		var msg cameraEventMessage
		if !decodeMsgpack(d.logger, data, &msg, "cameraEventMessage") {
			return
		}
		d.handleCameraEvent(msg)
	})
	if err != nil {
		return fmt.Errorf("subscribe camera events: %w", err)
	}
	d.cleanupFns = append(d.cleanupFns, unsub)

	unsubSensors, err := d.client.Subscribe(sensorCtrlNS.SensorSubject, func(data []byte) {
		var msg sensorControllerEventMessage
		if !decodeMsgpack(d.logger, data, &msg, "sensorControllerEventMessage") {
			return
		}
		d.handleSensorControllerEvent(msg)
	})
	if err != nil {
		return fmt.Errorf("subscribe sensor events: %w", err)
	}
	d.cleanupFns = append(d.cleanupFns, unsubSensors)

	detectionEventNS := getDetectionEventNamespaces(d.camera.ID)
	unsubDetectionEvents, err := d.client.Subscribe(detectionEventNS.DetectionEventSubject, func(data []byte) {
		var msg detectionEventMessage
		if !decodeMsgpack(d.logger, data, &msg, "detectionEventMessage") {
			return
		}
		d.handleDetectionEvent(&msg)
	})
	if err != nil {
		return fmt.Errorf("subscribe detection events: %w", err)
	}
	d.cleanupFns = append(d.cleanupFns, unsubDetectionEvents)

	// Refresh initial states from server (camera connected, frame worker state).
	// Without this, cameraState starts as false and misses the initial connected
	// event that was already emitted before the plugin subscribed.
	d.refreshStates()

	// Auto-initialize foreign sensors; init failures are ignored so a sensor that
	// can't initialize doesn't abort the attach.
	d.initSensors()

	return nil
}

func (d *CameraDevice) refreshStates() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	result, err := d.controllerProxy.Invoke(ctx, "refreshStates")
	if err != nil {
		d.logger.Error("Failed to refresh camera states:", err)
		return
	}

	if result == nil {
		return
	}

	encoded, err := rpc.Encode(result)
	if err != nil {
		d.logger.Error("Failed to encode refreshStates result:", err)
		return
	}

	var states struct {
		CameraState      bool `msgpack:"cameraState"`
		FrameWorkerState bool `msgpack:"frameWorkerState"`
	}
	if err := rpc.Decode(encoded, &states); err != nil {
		d.logger.Error("Failed to decode refreshStates result:", err)
		return
	}

	d.cameraState.Next(states.CameraState)
	d.frameWorkerState.Next(states.FrameWorkerState)
}

func (d *CameraDevice) getSourceByRole(role CameraRole) *CameraDeviceSource {
	d.mu.RLock()
	defer d.mu.RUnlock()
	for _, src := range d.sources {
		if src.input.Role == role {
			return src
		}
	}
	return nil
}

func (d *CameraDevice) getStreamURL(sourceID string) (string, error) {
	d.mu.RLock()
	impl := d.impl
	d.mu.RUnlock()

	if s, ok := impl.(StreamingInterface); ok {
		return s.StreamUrl(sourceID)
	}

	// Default: return the source's default RTSP URL
	src := d.GetSourceByID(sourceID)
	if src != nil {
		return src.SourceURL(), nil
	}
	return "", fmt.Errorf("source not found: %s", sourceID)
}

func (d *CameraDevice) getSnapshot(sourceID string, forceNew bool) ([]byte, error) {
	d.mu.RLock()
	impl := d.impl
	d.mu.RUnlock()

	if s, ok := impl.(SnapshotInterface); ok {
		return s.Snapshot(sourceID, forceNew)
	}

	return nil, fmt.Errorf("snapshot not implemented")
}

func (d *CameraDevice) handleCameraEvent(msg cameraEventMessage) {
	d.mu.RLock()
	init := d.initialized
	d.mu.RUnlock()
	if !init {
		return
	}

	switch msg.Type {
	case "updated":
		if msg.Data == nil {
			return
		}
		encoded, err := rpc.Encode(msg.Data)
		if err != nil {
			return
		}
		var cam Camera
		if !decodeMsgpack(d.logger, encoded, &cam, "Camera") {
			return
		}

		d.mu.Lock()
		d.camera = cam
		d.sources = make([]*CameraDeviceSource, 0, len(cam.Sources))
		for i := range cam.Sources {
			src := cam.Sources[i]
			rewriteStreamUrlsForRemote(&src.Urls)
			d.sources = append(d.sources, &CameraDeviceSource{
				input:  src,
				device: d,
			})
		}
		d.mu.Unlock()

		d.cameraSubject.Next(cam)

	case "cameraState":
		if msg.Data == nil {
			return
		}
		if state, ok := msg.Data.(bool); ok {
			d.cameraState.Next(state)
		}

	case "frameWorkerState":
		if msg.Data == nil {
			return
		}
		if state, ok := msg.Data.(bool); ok {
			d.frameWorkerState.Next(state)
		}
	}
}

func (d *CameraDevice) handleDetectionEvent(msg *detectionEventMessage) {
	if msg.Type == "" {
		return
	}

	d.detectionEvent.Next(DetectionEventData{
		Type:  msg.Type,
		Event: msg.Data,
	})
}

func (d *CameraDevice) initSensors() {
	ctx := context.Background()
	result, err := d.sensorCtrlProxy.Invoke(ctx, "getSensors", d.info.ID)
	if err != nil {
		d.logger.Debug("getSensors RPC failed:", err)
		return
	}

	sensorsRaw, ok := result.([]any)
	if !ok {
		d.logger.Debug("getSensors: unexpected result type", fmt.Sprintf("%T", result))
		return
	}

	var newProxies []*sensorProxy
	for _, raw := range sensorsRaw {
		encoded, err := rpc.Encode(raw)
		if err != nil {
			continue
		}
		var sensorData storedSensorData
		if !decodeMsgpack(d.logger, encoded, &sensorData, "storedSensorData") {
			continue
		}
		proxy := d.addProxySensor(&sensorData)
		if proxy != nil {
			newProxies = append(newProxies, proxy)
		}
	}

	if len(newProxies) > 0 {
		d.getSensorStates(newProxies)
	}

}

func (d *CameraDevice) getSensorStates(proxies []*sensorProxy) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	result, err := d.sensorCtrlProxy.Invoke(ctx, "getSensorStates")
	if err != nil {
		d.logger.Debug("getSensorStates RPC failed:", err)
		return
	}

	statesMap, ok := result.(map[string]any)
	if !ok {
		d.logger.Debug("getSensorStates: unexpected result type", fmt.Sprintf("%T", result))
		return
	}

	for _, proxy := range proxies {
		stateRaw, exists := statesMap[proxy.GetID()]
		if !exists {
			continue
		}

		encoded, err := rpc.Encode(stateRaw)
		if err != nil {
			continue
		}

		var state sensorRefreshedState
		if !decodeMsgpack(d.logger, encoded, &state, "sensorRefreshedState") {
			continue
		}

		if state.Capabilities != nil {
			proxy.SetCapabilities(state.Capabilities)
		}

		if state.DisplayName != "" {
			proxy.SetDisplayName(state.DisplayName)
		}

		// Apply properties (coerce msgpack-deserialized values to correct Go types).
		// This is a backend → SDK push, so it must NOT trigger updateFn (which
		// would loop back to the server).
		for k, v := range state.Properties {
			proxy.onBackendPropertyChanged(k, coercePropertyValue(proxy.sensorType, k, v))
		}
	}
}

func (d *CameraDevice) handleSensorControllerEvent(msg sensorControllerEventMessage) {
	if msg.Data == nil {
		return
	}

	d.mu.RLock()
	init := d.initialized
	d.mu.RUnlock()
	if !init {
		return
	}

	switch msg.Type {
	case "sensor:added":
		encoded, err := rpc.Encode(msg.Data)
		if err != nil {
			return
		}
		var addedData sensorAddedEventData
		if !decodeMsgpack(d.logger, encoded, &addedData, "sensorAddedEventData") {
			return
		}

		sensor := addedData.Sensor
		if sensor.Properties == nil {
			sensor.Properties = make(map[string]any)
		}
		for k, v := range addedData.State.Properties {
			if _, exists := sensor.Properties[k]; !exists {
				sensor.Properties[k] = v
			}
		}

		d.addProxySensor(&sensor)

	case "sensor:removed":
		encoded, err := rpc.Encode(msg.Data)
		if err != nil {
			return
		}
		var removedData sensorRemovedEventData
		if !decodeMsgpack(d.logger, encoded, &removedData, "sensorRemovedEventData") {
			return
		}

		if removedData.SensorID == "" {
			return
		}

		d.mu.Lock()
		proxy, exists := d.proxySensors[removedData.SensorID]
		if exists {
			delete(d.proxySensors, removedData.SensorID)
		}
		d.mu.Unlock()

		if proxy != nil {
			proxy.cleanupProxy()
		}

		d.sensorRemoved.Next(sensorEvent(removedData))

	case "sensor:assignment:changed":
		encoded, err := rpc.Encode(msg.Data)
		if err != nil {
			return
		}
		var assignmentData sensorAssignmentChangedData
		if !decodeMsgpack(d.logger, encoded, &assignmentData, "sensorAssignmentChangedData") {
			return
		}

		// Only process assignments for our own sensors
		if assignmentData.PluginID != d.info.ID {
			return
		}

		d.mu.RLock()
		for _, s := range d.sensors {
			if s.GetType() == assignmentData.SensorType {
				setAssignedWithLifecycle(s, assignmentData.Assigned)
			}
		}
		d.mu.RUnlock()
	}
}

func (d *CameraDevice) canAccessSensor(data *storedSensorData) bool {
	if data.PluginID == d.info.ID {
		return true
	}
	return containsSensorType(d.info.Contract.Consumes, data.Type)
}

func (d *CameraDevice) addProxySensor(data *storedSensorData) *sensorProxy {
	if data.ID == "" || data.Type == "" {
		return nil
	}

	// Skip our own sensors
	if data.PluginID == d.info.ID {
		return nil
	}

	// Check contract.consumes access control
	if !d.canAccessSensor(data) {
		return nil
	}

	category := categoryForSensorType(data.Type)

	d.mu.Lock()
	if _, exists := d.proxySensors[data.ID]; exists {
		d.mu.Unlock()
		return nil
	}

	proxy := newSensorProxy(d.client, d.logger, d.camera.ID, data.ID, data.Name, data.Type, category, data.Properties)
	proxy.setPluginID(data.PluginID)
	if data.DisplayName != "" {
		proxy.SetDisplayName(data.DisplayName)
	}
	if data.Capabilities != nil {
		proxy.SetCapabilities(data.Capabilities)
	}
	d.proxySensors[data.ID] = proxy
	d.mu.Unlock()

	d.sensorAdded.Next(sensorEvent{
		SensorID:   data.ID,
		SensorType: data.Type,
	})

	return proxy
}

func (d *CameraDevice) cleanup() {
	d.mu.Lock()
	d.initialized = false
	d.mu.Unlock()

	for _, fn := range d.cleanupFns {
		fn()
	}
	d.cleanupFns = nil

	d.cameraSubject.Complete()
	d.cameraState.Complete()
	d.frameWorkerState.Complete()
	d.sensorAdded.Complete()
	d.sensorRemoved.Complete()
	d.detectionEvent.Complete()

	d.mu.Lock()
	sensors := d.sensors
	d.sensors = nil
	for _, proxy := range d.proxySensors {
		proxy.cleanupProxy()
	}
	d.proxySensors = nil
	d.mu.Unlock()

	// dispatch outside d.mu, a plugin hook may call back into the device
	for _, s := range sensors {
		setAssignedWithLifecycle(s, false)
	}
}

// CameraDeviceSource is a camera source (one of the camera's video inputs)
// with snapshot, probe and URL-generation capabilities.
type CameraDeviceSource struct {
	input  CameraInput
	device *CameraDevice
}

// ID returns the unique source ID.
func (s *CameraDeviceSource) ID() string {
	return s.input.ID
}

// Name returns the source display name.
func (s *CameraDeviceSource) Name() string {
	return s.input.Name
}

// Role returns the resolution role of this source.
func (s *CameraDeviceSource) Role() CameraRole {
	return s.input.Role
}

// SourceURL returns the default RTSP URL for this source.
func (s *CameraDeviceSource) SourceURL() string {
	return s.input.Urls.RTSP.Default
}

// Urls returns the generated stream URLs for this source.
func (s *CameraDeviceSource) Urls() StreamUrls {
	return s.input.Urls
}

// UseForSnapshot returns whether this source is used for snapshots.
func (s *CameraDeviceSource) UseForSnapshot() bool {
	return s.input.UseForSnapshot
}

// HotMode returns whether hot mode (always-on connection) is enabled.
func (s *CameraDeviceSource) HotMode() bool {
	return s.input.HotMode
}

// Preload returns whether the stream is preloaded on startup.
func (s *CameraDeviceSource) Preload() bool {
	return s.input.Preload
}

// Snapshot returns a JPEG snapshot for this source.
// If forceNew is true, the snapshot cache is bypassed.
func (s *CameraDeviceSource) Snapshot(forceNew bool) ([]byte, error) {
	return s.device.getSnapshot(s.input.ID, forceNew)
}

// ProbeStream probes this source for codec and track information.
//
// config selects which tracks to inspect (nil probes the defaults). When
// refresh is true a fresh probe is performed, ignoring any cached result.
func (s *CameraDeviceSource) ProbeStream(config *ProbeConfig, refresh bool) (*ProbeStream, error) {
	ctx := context.Background()
	result, err := s.device.controllerProxy.Invoke(ctx, "probeStream", s.input.ID, config, refresh)
	if err != nil {
		return nil, fmt.Errorf("probeStream: %w", err)
	}

	if result == nil {
		return nil, nil
	}

	encoded, err := rpc.Encode(result)
	if err != nil {
		return nil, err
	}

	var probe ProbeStream
	if err := rpc.Decode(encoded, &probe); err != nil {
		return nil, err
	}
	return &probe, nil
}

// GetStreamStatus returns the current stream connection status
// (e.g. "connected", "connecting", "error", "idle").
func (s *CameraDeviceSource) GetStreamStatus() (string, error) {
	ctx := context.Background()
	result, err := s.device.controllerProxy.Invoke(ctx, "getStreamStatus", s.input.ID)
	if err != nil {
		return "", err
	}
	if status, ok := result.(string); ok {
		return status, nil
	}
	return "idle", nil
}

// GenerateRTSPUrl generates an RTSP URL for this source with the given options.
func (s *CameraDeviceSource) GenerateRTSPUrl(options *RTSPUrlOptions) (string, error) {
	return BuildTargetUrl(s.Urls().RTSP.Base, options)
}

// GenerateSnapshotUrl generates a snapshot URL for this source with the given options.
func (s *CameraDeviceSource) GenerateSnapshotUrl(options *SnapshotUrlOptions) (string, error) {
	return BuildSnapshotUrl(s.device.Name(), s.Name(), s.Urls().Snapshot.JPEG, options)
}

// changedCameraProps returns the json names of the camera fields that differ
// between old and new, recursing into anonymous embedded structs (BaseCamera).
func changedCameraProps(oldV, newV reflect.Value) []string {
	var props []string
	t := oldV.Type()
	for i := range t.NumField() {
		sf := t.Field(i)
		if sf.Anonymous && sf.Type.Kind() == reflect.Struct {
			props = append(props, changedCameraProps(oldV.Field(i), newV.Field(i))...)
			continue
		}
		if sf.Name == "ID" {
			continue
		}
		jsonTag := sf.Tag.Get("json")
		if jsonTag == "" || jsonTag == "-" {
			continue
		}
		if comma := indexOf(jsonTag, ','); comma >= 0 {
			jsonTag = jsonTag[:comma]
		}
		if !reflect.DeepEqual(oldV.Field(i).Interface(), newV.Field(i).Interface()) {
			props = append(props, jsonTag)
		}
	}
	return props
}

func indexOf(s string, c byte) int {
	for i := range len(s) {
		if s[i] == c {
			return i
		}
	}
	return -1
}
