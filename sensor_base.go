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
	SensorTypeContact        SensorType = "contact"        // Door/window open-close contact sensor
	SensorTypeLight          SensorType = "light"          // Light on/off and brightness control
	SensorTypeSiren          SensorType = "siren"          // Siren on/off and volume control
	SensorTypeSwitch         SensorType = "switch"         // Generic on/off switch
	SensorTypeLock           SensorType = "lock"           // Lock/unlock control
	SensorTypePTZ            SensorType = "ptz"            // Pan-tilt-zoom camera control
	SensorTypeSecuritySystem SensorType = "securitySystem" // Security system arm/disarm control
	SensorTypeDoorbell       SensorType = "doorbell"       // Doorbell ring trigger
	SensorTypeTemperature    SensorType = "temperature"    // Temperature sensor (°C)
	SensorTypeHumidity       SensorType = "humidity"       // Humidity sensor (0–100%)
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
	GetPluginID() string
	GetCameraID() string
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
	OnAssignmentChanged(callback func(bool)) *Disposable
	ToJSON() sensorJSON
}

type sensorJSON struct {
	ID             string         `msgpack:"id" json:"id"`
	Type           SensorType     `msgpack:"type" json:"type"`
	Name           string         `msgpack:"name" json:"name"`
	DisplayName    string         `msgpack:"displayName" json:"displayName"`
	Category       SensorCategory `msgpack:"category" json:"category"`
	CameraID       string         `msgpack:"cameraId" json:"cameraId"`
	PluginID       string         `msgpack:"pluginId,omitempty" json:"pluginId,omitempty"`
	Properties     map[string]any `msgpack:"properties" json:"properties"`
	Capabilities   []string       `msgpack:"capabilities" json:"capabilities"`
	RequiresFrames bool           `msgpack:"requiresFrames" json:"requiresFrames"`
	ModelSpec      any            `msgpack:"modelSpec,omitempty" json:"modelSpec,omitempty"`
}

type propertyUpdateFn func(properties map[string]any)

// assignmentLifecycle is an OPTIONAL interface sensors can satisfy to receive
// assignment lifecycle notifications. Implement it on your concrete sensor type
// to run work that should only execute while the sensor is live — polling
// loops, subscriptions, timers, external connections.
//
// The SDK calls OnAssigned() after the sensor transitions to assigned (cameraId,
// storage, and RPC channels are already wired) and OnDeassigned() after it
// transitions to deassigned. Calls are paired 1:1 — every OnAssigned has
// exactly one matching OnDeassigned later.
//
// Hooks run in a dedicated goroutine so plugin-side work does not block the
// runtime. Panics are recovered and swallowed so lifecycle errors will NOT
// break assignment bookkeeping; handle errors inside your implementation.
//
// Sensors that don't need lifecycle hooks simply omit the methods.
//
// Example:
//
//	func (s *MySensor) OnAssigned() {
//	    s.stop = make(chan struct{})
//	    go s.poll(s.stop)
//	}
//
//	func (s *MySensor) OnDeassigned() {
//	    close(s.stop)
//	}
type assignmentLifecycle interface {
	OnAssigned()
	OnDeassigned()
}

// BaseSensor is the base struct for all sensors. Embed this in concrete sensor types.
type BaseSensor struct {
	mu                   sync.RWMutex
	id                   string
	name                 string
	displayName          string
	pluginID             string
	cameraID             string
	capabilities         []string
	properties           map[string]any
	storage              *DeviceStorage
	updateFn             propertyUpdateFn
	capabilitiesUpdateFn func([]string)
	propertyChanged      *Subject[SensorPropertyChange]
	capabilitiesChanged  *Subject[[]string]
	assignmentChanged    *Subject[bool]
	isAssigned           bool
	requiresFrames       bool
}

func NewBaseSensor(name string) BaseSensor {
	return BaseSensor{
		id:                  generateSensorID(),
		name:                name,
		displayName:         name,
		properties:          make(map[string]any),
		capabilities:        make([]string, 0),
		propertyChanged:     NewSubject[SensorPropertyChange](),
		capabilitiesChanged: NewSubject[[]string](),
		assignmentChanged:   NewSubject[bool](),
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

func (s *BaseSensor) GetPluginID() string {
	return s.pluginID
}

func (s *BaseSensor) GetCameraID() string {
	return s.cameraID
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

// OnAssignmentChanged subscribes to assignment state changes (sensor added/removed from camera).
func (s *BaseSensor) OnAssignmentChanged(callback func(bool)) *Disposable {
	return s.assignmentChanged.Subscribe(callback)
}

// IsAssigned returns whether this sensor is currently assigned to a camera.
func (s *BaseSensor) IsAssigned() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.isAssigned
}

func (s *BaseSensor) setPluginID(id string) {
	s.pluginID = id
}

func (s *BaseSensor) setCameraID(id string) {
	s.cameraID = id
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
	s.updateFn = updateFn
}

func (s *BaseSensor) initCapabilitiesUpdateFn(updateFn func([]string)) {
	s.capabilitiesUpdateFn = updateFn
}

// setAssigned notifies subscribers but does NOT invoke lifecycle hooks — BaseSensor
// cannot reach the outer concrete type; use setAssignedWithLifecycle for those.
func (s *BaseSensor) setAssigned(assigned bool) {
	s.mu.Lock()
	if s.isAssigned == assigned {
		s.mu.Unlock()
		return
	}
	s.isAssigned = assigned
	s.mu.Unlock()
	s.assignmentChanged.Next(assigned)
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
		CameraID:       s.cameraID,
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
	s.propertyChanged.Complete()
	s.capabilitiesChanged.Complete()
	s.assignmentChanged.Complete()
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
	case SensorTypeMotion, SensorTypeAudio, SensorTypeObject,
		SensorTypeFace, SensorTypeLicensePlate, SensorTypeClassifier:
		return true
	}
	return false
}

// setAssignedWithLifecycle updates assignment state and, if the outer concrete
// sensor implements assignmentLifecycle, dispatches OnAssigned / OnDeassigned in a
// separate goroutine. outer must be the concrete sensor value (the BaseSensor
// embeddor) so the type assertion can see its method set.
func setAssignedWithLifecycle(outer any, assigned bool) {
	type assignableSensor interface{ setAssigned(bool) }
	as, ok := outer.(assignableSensor)
	if !ok {
		return
	}

	// Check "did state change" by reading the base field via a helper. We
	// can't race-safely read isAssigned from outside, so we rely on
	// setAssigned being idempotent (it no-ops when unchanged) and we detect
	// the change by capturing state before/after via the interface.
	type stateReader interface{ IsAssigned() bool }
	before := false
	if sr, ok2 := outer.(stateReader); ok2 {
		before = sr.IsAssigned()
	}
	as.setAssigned(assigned)
	after := assigned
	if before == after {
		return
	}

	lc, ok := outer.(assignmentLifecycle)
	if !ok {
		return
	}
	go func() {
		defer func() {
			// Swallow panics — lifecycle errors must not crash the runtime
			_ = recover()
		}()
		if assigned {
			lc.OnAssigned()
		} else {
			lc.OnDeassigned()
		}
	}()
}
