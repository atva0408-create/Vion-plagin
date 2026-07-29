package sdk

import (
	"crypto/rand"
	"fmt"
	"maps"
	"slices"
	"sync"
	"time"
)

// SensorType identifies the kind of sensor. Each maps to a smart-home concept.
type SensorType string

const (
	SensorTypeMotion         SensorType = "motion"         // Video-based motion detection
	SensorTypeObject         SensorType = "object"         // Object detection (person, vehicle, animal, etc.)
	SensorTypeAudio          SensorType = "audio"          // Audio event detection
	SensorTypeFace           SensorType = "face"           // Face detection and recognition
	SensorTypeLicensePlate   SensorType = "licensePlate"   // License plate detection and OCR
	SensorTypeClassifier     SensorType = "classifier"     // Generic image classification
	SensorTypeClip           SensorType = "clip"           // CLIP embedding generation
	SensorTypeObjectAssist   SensorType = "objectAssist"   // Object assist that locates objects in a frame so secondaries get real crops from camera-side detections
	SensorTypeContact        SensorType = "contact"        // Door/window open-close contact sensor
	SensorTypeLight          SensorType = "light"          // Light on/off and brightness control
	SensorTypeSiren          SensorType = "siren"          // Siren on/off and volume control
	SensorTypeSwitch         SensorType = "switch"         // Generic on/off switch
	SensorTypeLock           SensorType = "lock"           // Lock/unlock control
	SensorTypePTZ            SensorType = "ptz"            // Pan-tilt-zoom camera control
	SensorTypeSecuritySystem SensorType = "securitySystem" // Security system arm/disarm control
	SensorTypeDoorbell       SensorType = "doorbell"       // Doorbell ring trigger
	SensorTypeTemperature    SensorType = "temperature"    // Temperature sensor (°C)
	SensorTypeHumidity       SensorType = "humidity"       // Humidity sensor (0-100%)
	SensorTypeOccupancy      SensorType = "occupancy"      // Occupancy/presence sensor
	SensorTypeSmoke          SensorType = "smoke"          // Smoke detector
	SensorTypeLeak           SensorType = "leak"           // Water leak detector
	SensorTypeGarage         SensorType = "garage"         // Garage door opener
	SensorTypeBattery        SensorType = "battery"        // Battery level and charging state
)

// SensorCategory categorizes a sensor's role in the system.
type SensorCategory string

const (
	SensorCategorySensor  SensorCategory = "sensor"  // Reports detected state (read-only from user perspective)
	SensorCategoryControl SensorCategory = "control" // Accepts commands (light, PTZ, siren, etc.)
	SensorCategoryTrigger SensorCategory = "trigger" // Fires one-shot events (doorbell ring)
	SensorCategoryInfo    SensorCategory = "info"    // Read-only informational data (battery level)
)

// Sensor is the interface all sensors must implement.
//
// Plugin-author state-modifying methods (`SetOn`, `ReportDetections`, etc.) live
// on the concrete sensor types, not on Sensor. Code that holds a Sensor reference
// can READ state and observe changes, plus invoke `UpdateValue` for cross-process
// generic property writes (HomeKit bridge etc.).
type Sensor interface {
	GetID() string
	GetType() SensorType
	GetCategory() SensorCategory
	GetName() string
	GetDisplayName() string
	SetDisplayName(name string)
	GetNativeID() string
	GetPluginID() string
	// GetAssignedCameraIDs returns the cameras this sensor is currently
	// assigned to. Empty for unassigned standalone sensors.
	GetAssignedCameraIDs() []string
	// Connected reports whether the owning plugin currently provides this sensor.
	Connected() bool
	GetCapabilities() []string
	SetCapabilities(caps []string)
	HasCapability(cap string) bool
	// GetValue returns the current value of a sensor property.
	GetValue(property string) any
	// GetValues returns a snapshot of all property values.
	GetValues() map[string]any
	// UpdateValue is the cross-process consumer entry point. Concrete sensor types
	// implement it to dispatch known properties to semantic methods (`SetOn`,
	// `SetTargetState`, ...) so plugin-side hardware-action overrides are honored.
	// Read-only sensors implement it as a no-op. Plugin authors **must not** call
	// this — they should call the semantic methods directly.
	UpdateValue(property string, value any) error
	OnPropertyChanged(callback func(SensorPropertyChange)) *Disposable
	OnCapabilitiesChanged(callback func([]string)) *Disposable
	// OnAssignmentChanged fires with the current camera id list whenever the
	// user changes this sensor's camera assignments.
	OnAssignmentChanged(callback func([]string)) *Disposable
	// OnConnectedChanged fires when the owning plugin's connectivity changes.
	OnConnectedChanged(callback func(bool)) *Disposable
	ToJSON() sensorJSON
}

type sensorJSON struct {
	ID             string         `msgpack:"id" json:"id"`
	Type           SensorType     `msgpack:"type" json:"type"`
	Name           string         `msgpack:"name" json:"name"`
	DisplayName    string         `msgpack:"displayName" json:"displayName"`
	Category       SensorCategory `msgpack:"category" json:"category"`
	NativeID       string         `msgpack:"nativeId,omitempty" json:"nativeId,omitempty"`
	PluginID       string         `msgpack:"pluginId,omitempty" json:"pluginId,omitempty"`
	Properties     map[string]any `msgpack:"properties" json:"properties"`
	Capabilities   []string       `msgpack:"capabilities" json:"capabilities"`
	RequiresFrames bool           `msgpack:"requiresFrames" json:"requiresFrames"`
	ModelSpec      any            `msgpack:"modelSpec,omitempty" json:"modelSpec,omitempty"`
}

type propertyUpdateFn func(properties map[string]any)

// sensorLifecycle is an OPTIONAL interface sensors can satisfy to receive
// lifecycle notifications. Implement it on your concrete sensor type to run
// work whose lifetime matches the sensor's — polling loops, subscriptions,
// timers, external connections.
//
// The SDK calls OnStart() after the sensor is registered and live (storage and
// RPC channels are already wired) and OnStop() on removal, plugin shutdown or
// cleanup. Calls are paired 1:1 — every OnStart has exactly one matching
// OnStop later.
//
// Hooks run in a dedicated goroutine so plugin-side work does not block the
// runtime. Panics are recovered and swallowed so lifecycle errors will NOT
// break lifecycle bookkeeping; handle errors inside your implementation.
//
// Sensors that don't need lifecycle hooks simply omit the methods.
//
// Example:
//
//	func (s *MySensor) OnStart() {
//	    s.stop = make(chan struct{})
//	    go s.poll(s.stop)
//	}
//
//	func (s *MySensor) OnStop() {
//	    close(s.stop)
//	}
type sensorLifecycle interface {
	OnStart()
	OnStop()
}

type sensorOptions struct {
	nativeID string
}

// SensorOption configures a sensor at construction time.
type SensorOption func(*sensorOptions)

// WithNativeID sets the plugin-supplied durable identity (e.g. an upstream
// device id). The host reconciles the sensor across restarts by
// (pluginId, nativeId); without it, identity falls back to (type, name) and a
// rename creates a new sensor.
func WithNativeID(nativeID string) SensorOption {
	return func(o *sensorOptions) {
		o.nativeID = nativeID
	}
}

// BaseSensor is the base struct for all sensors. Embed this in concrete sensor types.
//
// Sensors are standalone entities: the plugin supplies the durable identity
// (WithNativeID), everything else belongs to the user — camera assignments,
// display name and whether the sensor is exported to HomeKit/HA/MQTT. A plugin
// never decides where its sensor is used and never handles the export itself.
type BaseSensor struct {
	mu                   sync.RWMutex
	id                   string
	name                 string
	displayName          string
	nativeID             string
	pluginID             string
	assignedCameraIDs    []string
	capabilities         []string
	properties           map[string]any
	storage              *DeviceStorage
	updateFn             propertyUpdateFn
	capabilitiesUpdateFn func([]string)
	propertyChanged      *Subject[SensorPropertyChange]
	capabilitiesChanged  *Subject[[]string]
	assignmentChanged    *Subject[[]string]
	connectedChanged     *Subject[bool]
	registered           bool
	active               bool
	requiresFrames       bool
}

func NewBaseSensor(name string, opts ...SensorOption) BaseSensor {
	var cfg sensorOptions
	for _, opt := range opts {
		opt(&cfg)
	}
	return BaseSensor{
		// provisional id, replaced by the host's persistent id at registration
		id:                  generateSensorID(),
		name:                name,
		displayName:         name,
		nativeID:            cfg.nativeID,
		properties:          make(map[string]any),
		capabilities:        make([]string, 0),
		propertyChanged:     NewSubject[SensorPropertyChange](),
		capabilitiesChanged: NewSubject[[]string](),
		assignmentChanged:   NewSubject[[]string](),
		connectedChanged:    NewSubject[bool](),
	}
}

func (s *BaseSensor) GetID() string {
	return s.id
}

func (s *BaseSensor) GetName() string {
	return s.name
}

func (s *BaseSensor) GetDisplayName() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.displayName
}

// SetDisplayName sets the display name (the only mutable identifier on a
// sensor). name is the human-readable label shown in the UI.
//
// Example:
//
//	sensor.SetDisplayName("Front Door Motion")
func (s *BaseSensor) SetDisplayName(name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.displayName = name
}

// GetNativeID returns the plugin-supplied durable identity, or empty string.
func (s *BaseSensor) GetNativeID() string {
	return s.nativeID
}

func (s *BaseSensor) GetPluginID() string {
	return s.pluginID
}

// GetAssignedCameraIDs returns the cameras this sensor is currently assigned to.
func (s *BaseSensor) GetAssignedCameraIDs() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	ids := make([]string, len(s.assignedCameraIDs))
	copy(ids, s.assignedCameraIDs)
	return ids
}

// Connected reports whether the sensor is registered with the host.
func (s *BaseSensor) Connected() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.registered
}

// OnConnectedChanged fires when the sensor's registration state changes.
func (s *BaseSensor) OnConnectedChanged(callback func(bool)) *Disposable {
	return s.connectedChanged.Subscribe(callback)
}

func (s *BaseSensor) GetCapabilities() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	caps := make([]string, len(s.capabilities))
	copy(caps, s.capabilities)
	return caps
}

func (s *BaseSensor) SetCapabilities(caps []string) {
	s.mu.Lock()
	s.capabilities = caps
	capsCopy := make([]string, len(caps))
	copy(capsCopy, caps)
	updateFn := s.capabilitiesUpdateFn
	s.mu.Unlock()

	// Broadcast to SensorController (for RPC propagation)
	if updateFn != nil {
		updateFn(capsCopy)
	}
	// Notify local listeners
	s.capabilitiesChanged.Next(capsCopy)
}

// OnCapabilitiesChanged returns a Disposable that fires when capabilities change.
func (s *BaseSensor) OnCapabilitiesChanged(callback func([]string)) *Disposable {
	return s.capabilitiesChanged.Subscribe(callback)
}

func (s *BaseSensor) HasCapability(cap string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return slices.Contains(s.capabilities, cap)
}

// GetValue returns the current value of a sensor property.
func (s *BaseSensor) GetValue(property string) any {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.properties[property]
}

// GetValues returns a snapshot of all property values.
//
// Example:
//
//	snapshot := sensor.GetValues()
//	fmt.Println(snapshot)
func (s *BaseSensor) GetValues() map[string]any {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make(map[string]any, len(s.properties))
	maps.Copy(result, s.properties)
	return result
}

// Storage returns the sensor's persistent storage. Nil until the sensor is added to a camera.
func (s *BaseSensor) Storage() *DeviceStorage {
	return s.storage
}

// OnPropertyChanged subscribes to property changes. Returns a Disposable to unsubscribe.
func (s *BaseSensor) OnPropertyChanged(callback func(SensorPropertyChange)) *Disposable {
	return s.propertyChanged.Subscribe(callback)
}

// OnAssignmentChanged fires with the current camera id list whenever the
// user changes this sensor's camera assignments.
func (s *BaseSensor) OnAssignmentChanged(callback func([]string)) *Disposable {
	return s.assignmentChanged.Subscribe(callback)
}

// IsAssigned returns whether this sensor is assigned to at least one camera.
func (s *BaseSensor) IsAssigned() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.assignedCameraIDs) > 0
}

func (s *BaseSensor) setPluginID(id string) {
	s.pluginID = id
}

func (s *BaseSensor) setID(id string) {
	s.id = id
}

func (s *BaseSensor) setAssignedCameras(cameraIDs []string) {
	s.mu.Lock()
	s.assignedCameraIDs = make([]string, len(cameraIDs))
	copy(s.assignedCameraIDs, cameraIDs)
	notify := make([]string, len(cameraIDs))
	copy(notify, cameraIDs)
	s.mu.Unlock()
	s.assignmentChanged.Next(notify)
}

// writeState performs deep-equal change detection over the partial, writes
// changed properties to the store, fires a single batched RPC update with the
// delta, and notifies local listeners per-property.
//
// Used by the semantic helper methods on each sensor type (`SetOn`,
// `ReportDetections`, etc.) — **not for plugin authors**. Plugin code should
// call the semantic helpers, not write state directly.
//
// One `writeState` call → one `updateFn` invocation. The receiver sees an
// atomic state transition for this sensor.
func (s *BaseSensor) writeState(partial map[string]any) {
	type change struct {
		property string
		value    any
	}

	delta := make(map[string]any, len(partial))
	changes := make([]change, 0, len(partial))

	s.mu.Lock()
	for key, value := range partial {
		if value == nil {
			continue
		}
		previous := s.properties[key]
		if isEqual(previous, value) {
			continue
		}
		s.properties[key] = value
		delta[key] = value
		changes = append(changes, change{key, value})
	}
	updateFn := s.updateFn
	s.mu.Unlock()

	if len(delta) == 0 {
		return
	}

	if updateFn != nil {
		updateFn(delta)
	}

	now := time.Now().UnixMilli()
	for _, c := range changes {
		s.propertyChanged.Next(SensorPropertyChange{
			Property:  c.property,
			Value:     c.value,
			Timestamp: now,
		})
	}
}

func (s *BaseSensor) setStorage(storage *DeviceStorage) {
	s.storage = storage
}

func (s *BaseSensor) initUpdateFn(updateFn propertyUpdateFn) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.updateFn = updateFn
	s.registered = true
}

func (s *BaseSensor) initCapabilitiesUpdateFn(updateFn func([]string)) {
	s.capabilitiesUpdateFn = updateFn
}

// setActive flips the lifecycle state and notifies connectivity subscribers,
// but does NOT invoke lifecycle hooks — BaseSensor cannot reach the outer
// concrete type; use setActiveWithLifecycle for those. Returns whether the
// state actually changed.
func (s *BaseSensor) setActive(active bool) bool {
	s.mu.Lock()
	if s.active == active {
		s.mu.Unlock()
		return false
	}
	s.active = active
	s.mu.Unlock()
	s.connectedChanged.Next(active)
	return true
}

func (s *BaseSensor) toBaseJSON(sensorType SensorType, category SensorCategory) sensorJSON {
	s.mu.RLock()
	defer s.mu.RUnlock()

	props := make(map[string]any, len(s.properties))
	maps.Copy(props, s.properties)

	return sensorJSON{
		ID:             s.id,
		Type:           sensorType,
		Name:           s.name,
		DisplayName:    s.displayName,
		Category:       category,
		NativeID:       s.nativeID,
		PluginID:       s.pluginID,
		Properties:     props,
		Capabilities:   s.capabilities,
		RequiresFrames: s.requiresFrames,
	}
}

// onBackendPropertyChanged updates a property from a backend-initiated change
// without triggering the updateFn (which would broadcast back to the server).
func (s *BaseSensor) onBackendPropertyChanged(property string, value any) {
	s.mu.Lock()
	oldValue := s.properties[property]
	if isEqual(oldValue, value) {
		s.mu.Unlock()
		return
	}
	s.properties[property] = value
	s.mu.Unlock()

	s.propertyChanged.Next(SensorPropertyChange{
		Property:  property,
		Value:     value,
		Timestamp: time.Now().UnixMilli(),
	})
}

func (s *BaseSensor) setPropertyWithTimestamp(property string, value any, timestamp int64) {
	s.mu.Lock()
	oldValue := s.properties[property]
	if isEqual(oldValue, value) {
		s.mu.Unlock()
		return
	}
	s.properties[property] = value
	s.mu.Unlock()

	s.propertyChanged.Next(SensorPropertyChange{
		Property:  property,
		Value:     value,
		Timestamp: timestamp,
	})
}

func (s *BaseSensor) cleanup() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.updateFn = nil
	s.capabilitiesUpdateFn = nil
	s.registered = false
	s.assignedCameraIDs = nil
	s.propertyChanged.Complete()
	s.capabilitiesChanged.Complete()
	s.assignmentChanged.Complete()
	s.connectedChanged.Complete()
	s.storage = nil
}

func generateSensorID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// normalizeReportedDetections is a helper for `ReportDetections(detected, detections)` flows.
//
//   - If `detected` is false → returns an empty slice (clear).
//   - If `detected` is true and `detections` has items → returns them, substituting a full-frame box where missing.
//   - If `detected` is true and `detections` is empty → returns a single
//     synthesized full-frame detection with the given fallback label and any
//     fallback extras applied (used for type-specific properties like `attribute`).
func normalizeReportedDetections(detected bool, detections []Detection, fallbackLabel string, fallbackAttribute string) []Detection {
	if !detected {
		return []Detection{}
	}
	if len(detections) > 0 {
		return fillMissingBoxes(detections)
	}
	d := Detection{
		Label:      fallbackLabel,
		Confidence: 1,
		Box:        &BoundingBox{X: 0, Y: 0, Width: 1, Height: 1},
	}
	if fallbackAttribute != "" {
		d.Attribute = fallbackAttribute
	}
	return []Detection{d}
}

// fillMissingBoxes substitutes a full-frame bounding box for detections
// reported without one. Smart-camera plugins (Ring, Reolink, ...) report
// labels without coordinates, while downstream consumers (detection
// coordinator, zone matching) require a box on every detection.
func fillMissingBoxes(detections []Detection) []Detection {
	out := make([]Detection, len(detections))
	for i, d := range detections {
		if d.Box == nil {
			d.Box = &BoundingBox{X: 0, Y: 0, Width: 1, Height: 1}
		}
		out[i] = d
	}
	return out
}

func isDetectionSensorType(t SensorType) bool {
	switch t {
	case SensorTypeMotion, SensorTypeAudio, SensorTypeObject, SensorTypeObjectAssist,
		SensorTypeFace, SensorTypeLicensePlate, SensorTypeClassifier, SensorTypeClip:
		return true
	}
	return false
}

// deactivateQuiet flips active off without emitting on connectedChanged —
// teardown pairs the OnStop hook but is not a connectivity signal. Returns
// whether the sensor was still active.
func (s *BaseSensor) deactivateQuiet() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.active {
		return false
	}
	s.active = false
	return true
}

// cleanupSensorWithLifecycle tears a sensor down: pairs OnStop if the sensor
// is still active (without a connectivity emission, matching removal/shutdown
// semantics across runtimes), then completes subjects and clears wiring.
func cleanupSensorWithLifecycle(outer any) {
	type quietDeactivator interface{ deactivateQuiet() bool }
	if qd, ok := outer.(quietDeactivator); ok && qd.deactivateQuiet() {
		if lc, ok := outer.(sensorLifecycle); ok {
			go func() {
				defer func() {
					_ = recover()
				}()
				lc.OnStop()
			}()
		}
	}

	type cleanable interface{ cleanup() }
	if c, ok := outer.(cleanable); ok {
		c.cleanup()
	}
}

// setActiveWithLifecycle updates the lifecycle state and, if the outer concrete
// sensor implements sensorLifecycle, dispatches OnStart / OnStop in a separate
// goroutine. outer must be the concrete sensor value (the BaseSensor embeddor)
// so the type assertion can see its method set.
func setActiveWithLifecycle(outer any, active bool) {
	type activatableSensor interface{ setActive(bool) bool }
	as, ok := outer.(activatableSensor)
	if !ok {
		return
	}

	if !as.setActive(active) {
		return
	}

	lc, ok := outer.(sensorLifecycle)
	if !ok {
		return
	}
	go func() {
		defer func() {
			// Swallow panics — lifecycle errors must not crash the runtime
			_ = recover()
		}()
		if active {
			lc.OnStart()
		} else {
			lc.OnStop()
		}
	}()
}
