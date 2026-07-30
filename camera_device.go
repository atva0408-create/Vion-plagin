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
	setID(id string)
	setPluginID(id string)
	setAssignedCameras(cameraIDs []string)
	setStorage(storage *DeviceStorage)
	initUpdateFn(updateFn propertyUpdateFn)
	initCapabilitiesUpdateFn(updateFn func([]string))
	ToJSON() sensorJSON
}

type backendPropertyReceiver interface {
	onBackendPropertyChanged(property string, value any)
	setPropertyWithTimestamp(property string, value any, timestamp int64)
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
	registryProxy   *rpc.Proxy
	sources         []*CameraDeviceSource
	sensors         []Sensor
	sensorCleanups  map[string]func()
	storageDevice   *DeviceStorage
	storageCtrl     *StorageController
	initialized     bool

	cameraSubject    *BehaviorSubject[Camera]
	cameraState      *BehaviorSubject[bool]
	frameWorkerState *BehaviorSubject[bool]
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
	registryNS := getSensorRegistryNamespaces()

	dev := &CameraDevice{
		client:           client,
		api:              api,
		camera:           *cam,
		info:             *pluginInfo,
		logger:           logger,
		controllerProxy:  client.CreateProxy(camNS.CameraControllerRPC),
		registryProxy:    client.CreateProxy(registryNS.SensorsRPC),
		storageCtrl:      storageCtrl,
		sensorCleanups:   make(map[string]func()),
		cameraSubject:    NewBehaviorSubject(*cam),
		cameraState:      NewBehaviorSubject(false),
		frameWorkerState: NewBehaviorSubject(false),
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

// RecordingSettings returns the recording settings.
func (d *CameraDevice) RecordingSettings() CameraRecordingSettings {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.camera.RecordingSettings
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

// AddSensor registers a sensor that belongs to this camera's hardware
// (spotlight, siren, PTZ, battery, ...). The host assigns it to this camera
// and reconciles it across restarts like a standalone sensor.
func (d *CameraDevice) AddSensor(s Sensor) error {
	si, ok := s.(sensorInternalInit)
	if !ok {
		return fmt.Errorf("sensor %s does not embed BaseSensor", s.GetName())
	}
	si.setPluginID(d.info.ID)

	sensorJSON := si.ToJSON()

	sensorJSON.ModelSpec = detectorModelSpec(s)

	// derived nativeId keeps per-camera instances of same-named sensors distinct
	if sensorJSON.NativeID == "" {
		sensorJSON.NativeID = fmt.Sprintf("%s:%s:%s", d.camera.ID, s.GetType(), s.GetName())
	}

	// register first: the host reconciles against the persisted entity and
	// hands back the durable id every namespace binds to
	ctx := context.Background()
	registerResult, err := d.registryProxy.Invoke(ctx, "registerSensor", sensorJSON, d.info.ID, map[string]any{"assignCameraId": d.camera.ID})
	if err != nil {
		return fmt.Errorf("failed to register sensor: %w", err)
	}
	registration, err := decodeSensorRegistration(registerResult)
	if err != nil {
		return fmt.Errorf("failed to decode sensor registration: %w", err)
	}
	si.setID(registration.ID)
	si.setAssignedCameras(registration.AssignedCameraIDs)

	// assignment changes arrive on the global stream the sensor manager owns
	if d.api != nil && d.api.SensorManager != nil {
		if err := d.api.SensorManager.trackCameraSensor(s); err != nil {
			return err
		}
	}

	d.mu.Lock()
	d.sensors = append(d.sensors, s)
	d.mu.Unlock()

	// every exported method of the sensor becomes a camelCase RPC endpoint
	sensorProviderNS := getSensorProviderNamespaces(d.info.ID, s.GetID())
	sensorCleanup, err := d.client.RegisterHandler(sensorProviderNS.SensorRPC, s)
	if err != nil {
		return fmt.Errorf("failed to register sensor RPC: %w", err)
	}

	sensorStorage, err := d.storageCtrl.createSensorStorage(s.GetID())
	if err != nil {
		return fmt.Errorf("failed to create sensor storage: %w", err)
	}
	si.setStorage(sensorStorage)

	frameWorkerDetectionNS := getFrameWorkerDetectionNamespaces(d.camera.ID)
	detectionCoordinatorProxy := d.client.CreateProxy(frameWorkerDetectionNS.DetectionRPC)
	sensor := s
	si.initUpdateFn(func(properties map[string]any) {
		ctx := context.Background()
		if isDetectionSensorType(sensor.GetType()) {
			// detection writes bypass the main process and go straight to the
			// frame worker, so without one there is nowhere to deliver them
			if !d.frameWorkerState.Value() {
				return
			}
			if _, err := detectionCoordinatorProxy.Invoke(ctx, "reportSensorWrite", sensor.GetID(), sensor.GetType(), properties); err != nil {
				d.logger.Warn(fmt.Sprintf("Failed to forward sensor write to coordinator for %s: %v", sensor.GetID(), err))
			}
			return
		}
		_, _ = d.registryProxy.Invoke(ctx, "updatePropertyValues", sensor.GetID(), properties)
	})
	si.initCapabilitiesUpdateFn(func(caps []string) {
		ctx := context.Background()
		_, _ = d.registryProxy.Invoke(ctx, "updateCapabilities", sensor.GetID(), caps)
	})

	// host-side writes (e.g. the motion dwell timer) must land back on the sensor
	sensorEventNS := getSensorEventNamespaces(s.GetID())
	unsubBackend, err := d.client.Subscribe(sensorEventNS.SensorSubject, func(data []byte) {
		var msg sensorEventMessage
		if !decodeMsgpack(d.logger, data, &msg, "sensorEventMessage") {
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
	if err != nil {
		// the sensor stays registered, only host-side writes are lost
		d.logger.Error(fmt.Sprintf("subscribe sensor events for %s: %v", s.GetID(), err))
	}

	d.mu.Lock()
	d.sensorCleanups[s.GetID()] = func() {
		if unsubBackend != nil {
			unsubBackend()
		}
		_ = sensorCleanup()
	}
	d.mu.Unlock()

	setActiveWithLifecycle(s, true)

	return nil
}

// RemoveSensor unregisters a sensor this plugin registered on this camera.
// The persisted entity stays (shows disconnected) unless the user deletes it.
func (d *CameraDevice) RemoveSensor(sensorID string) error {
	d.mu.Lock()
	var removed Sensor
	for i, s := range d.sensors {
		if s.GetID() == sensorID {
			removed = s
			d.sensors = append(d.sensors[:i], d.sensors[i+1:]...)
			break
		}
	}
	cleanup := d.sensorCleanups[sensorID]
	delete(d.sensorCleanups, sensorID)
	d.mu.Unlock()

	if removed == nil {
		return fmt.Errorf("sensor not found: %s", sensorID)
	}

	if d.api != nil && d.api.SensorManager != nil {
		d.api.SensorManager.untrackCameraSensor(sensorID)
	}

	ctx := context.Background()
	_, _ = d.registryProxy.Invoke(ctx, "unregisterSensor", sensorID)

	if cleanup != nil {
		cleanup()
	}

	cleanupSensorWithLifecycle(removed)

	return nil
}

// OnDetectionEvent registers a callback for detection events (start/update/end and
// segment-start/segment-update/segment-end). Segments ride on the segment-* events
// only, thumbnails on segment-start and segment-end. Returns a Disposable to
// unsubscribe.
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

func (d *CameraDevice) init() error {
	d.mu.Lock()
	if d.initialized {
		d.mu.Unlock()
		return nil
	}
	d.initialized = true
	d.mu.Unlock()

	pluginCamNS := getPluginCameraNamespaces(d.info.ID, d.camera.ID)

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

	// the connected event may have fired before this subscription existed
	d.refreshStates()
	d.cleanupFns = append(d.cleanupFns, d.client.OnReconnect(d.refreshStates))

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
		Camera           Camera `msgpack:"camera"`
		CameraState      bool   `msgpack:"cameraState"`
		FrameWorkerState bool   `msgpack:"frameWorkerState"`
	}
	if err := rpc.Decode(encoded, &states); err != nil {
		d.logger.Error("Failed to decode refreshStates result:", err)
		return
	}

	// a resync must not wake subscribers for state they already hold
	d.mu.RLock()
	sameCamera := isEqual(d.camera, states.Camera, false)
	d.mu.RUnlock()
	if !sameCamera {
		d.applyCamera(&states.Camera)
	}
	if d.cameraState.Value() != states.CameraState {
		d.cameraState.Next(states.CameraState)
	}
	if d.frameWorkerState.Value() != states.FrameWorkerState {
		d.frameWorkerState.Next(states.FrameWorkerState)
	}
}

func (d *CameraDevice) applyCamera(cam *Camera) {
	d.mu.Lock()
	d.camera = *cam
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

	d.cameraSubject.Next(*cam)
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

		d.applyCamera(&cam)

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
	d.detectionEvent.Complete()

	d.mu.Lock()
	sensors := d.sensors
	d.sensors = nil
	sensorCleanups := d.sensorCleanups
	d.sensorCleanups = make(map[string]func())
	d.mu.Unlock()

	for _, cleanup := range sensorCleanups {
		cleanup()
	}

	// dispatch outside d.mu, a plugin hook may call back into the device
	for _, s := range sensors {
		if d.api != nil && d.api.SensorManager != nil {
			d.api.SensorManager.untrackCameraSensor(s.GetID())
		}
		cleanupSensorWithLifecycle(s)
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

func decodeSensorRegistration(result any) (*sensorRegistration, error) {
	encoded, err := rpc.Encode(result)
	if err != nil {
		return nil, err
	}
	var registration sensorRegistration
	if err := rpc.Decode(encoded, &registration); err != nil {
		return nil, err
	}
	return &registration, nil
}

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
