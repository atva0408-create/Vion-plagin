package sdk

import (
	"crypto/rand"
	"fmt"
	"maps"
	"slices"
	"sync"
	"time"
)

// SensorType identifies the kind of sensor. "Sensor" is camera.ui's umbrella
// term for the smallest smart-home unit. It covers measuring devices and controllable ones alike.
type SensorType string

const (
	SensorTypeMotion         SensorType = "motion"         // Video-based motion detection
	SensorTypeObject         SensorType = "object"         // Object detection (person, vehicle, animal, etc.)
	SensorTypeAudio          SensorType = "audio"          // Audio event detection (glass break, scream, etc.)
	SensorTypeFace           SensorType = "face"           // Face detection and recognition
	SensorTypeLicensePlate   SensorType = "licensePlate"   // License plate detection and OCR
	SensorTypeClassifier     SensorType = "classifier"     // General-purpose image classifier
	SensorTypeClip           SensorType = "clip"           // CLIP embedding generation for semantic search
	SensorTypeObjectAssist   SensorType = "objectAssist"   // Locates objects in a frame so secondary detectors get real crops from camera-side detections
	SensorTypeContact        SensorType = "contact"        // Contact/open-close sensor (door, window)
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
	SensorTypeGas            SensorType = "gas"            // Gas detector
	SensorTypeCarbonMonoxide SensorType = "carbonMonoxide" // Carbon monoxide detector
	SensorTypeHeat           SensorType = "heat"           // Heat alarm
	SensorTypeCold           SensorType = "cold"           // Cold alarm
	SensorTypeVibration      SensorType = "vibration"      // Vibration sensor
	SensorTypeTamper         SensorType = "tamper"         // Tamper sensor
	SensorTypeProblem        SensorType = "problem"        // Generic problem/fault sensor
	SensorTypePower          SensorType = "power"          // Power detection sensor
	SensorTypeIlluminance    SensorType = "illuminance"    // Illuminance sensor (lx)
	SensorTypeCarbonDioxide  SensorType = "carbonDioxide"  // Carbon dioxide sensor (ppm)
	SensorTypeGarage         SensorType = "garage"         // Garage door opener
	SensorTypeBattery        SensorType = "battery"        // Battery level and charging state
)

// SensorCategory categorizes a sensor's role in the system. It determines how
// the backend treats the sensor, read-only or controllable.
type SensorCategory string

const (
	SensorCategorySensor  SensorCategory = "sensor"  // Read-only detection sensor (motion, object, audio, etc.)
	SensorCategoryControl SensorCategory = "control" // Controllable sensor with set methods (light, siren, PTZ, etc.)
	SensorCategoryTrigger SensorCategory = "trigger" // Event trigger (doorbell ring)
	SensorCategoryInfo    SensorCategory = "info"    // Informational read-only state (battery level)
)

// Sensor is the interface all sensors must implement.
//
// State-modifying methods (SetOn, ReportDetections, etc.) live on the concrete
// sensor types, not on Sensor. Code that holds a Sensor reference can read state
// and observe changes, plus invoke UpdateValue for cross-process generic property writes.
type Sensor interface {
	GetID() string
	GetType() SensorType
	GetName() string
	GetDisplayName() string
	GetNativeID() string
	GetPluginID() string
	GetAssignedCameraIDs() []string
	Connected() bool
	GetCapabilities() []string
	AssignmentLocked() bool
	// HasCapability reports whether the sensor advertises a capability.
	HasCapability(cap string) bool
	// GetValue returns the current value of a sensor property.
	GetValue(property string) any
	// GetValues returns a snapshot copy of all property values.
	GetValues() map[string]any
	// UpdateValue is the generic property write coming from a consumer. Concrete
	// sensor types dispatch known properties to semantic methods (SetOn,
	// SetTargetState) so plugin-side hardware overrides run. Read-only sensors
	// implement it as a no-op. Plugin authors call the semantic methods instead.
	UpdateValue(property string, value any) error
	// OnPropertyChanged fires on every property change.
	OnPropertyChanged(callback func(SensorPropertyChange)) *Disposable
	// OnCapabilitiesChanged fires with the full capability list whenever it changes.
	OnCapabilitiesChanged(callback func([]string)) *Disposable
	// OnAssignmentChanged fires with the current camera id list whenever the
	// user changes this sensor's camera assignments.
	OnAssignmentChanged(callback func([]string)) *Disposable
	// OnConnectedChanged fires when the owning plugin's connectivity changes.
	OnConnectedChanged(callback func(bool)) *Disposable
}

// SensorOption configures a sensor at construction time.
type SensorOption func(*sensorOptions)

type sensorJSON struct {
	ID             string         `msgpack:"id" json:"id"`
	Type           SensorType     `msgpack:"type" json:"type"`
	Name           string         `msgpack:"name" json:"name"`
	DisplayName    string         `msgpack:"displayName" json:"displayName"`
	Category       SensorCategory `msgpack:"category" json:"category"`
	NativeID       string         `msgpack:"nativeId,omitempty" json:"nativeId,omitempty"`
	Origin         string         `msgpack:"origin,omitempty" json:"origin,omitempty"`
	Exposed        *bool          `msgpack:"exposed,omitempty" json:"exposed,omitempty"`
	Hidden         *bool          `msgpack:"hidden,omitempty" json:"hidden,omitempty"`
	PluginID       string         `msgpack:"pluginId,omitempty" json:"pluginId,omitempty"`
	Properties     map[string]any `msgpack:"properties" json:"properties"`
	Capabilities   []string       `msgpack:"capabilities" json:"capabilities"`
	RequiresFrames bool           `msgpack:"requiresFrames" json:"requiresFrames"`
	ModelSpec      any            `msgpack:"modelSpec,omitempty" json:"modelSpec,omitempty"`
}

type propertyUpdateFn func(properties map[string]any)

// optional on a concrete sensor, OnStart/OnStop are paired 1:1, run in their own
// goroutine and swallow panics
type sensorLifecycle interface {
	OnStart()
	OnStop()
}

type sensorOptions struct {
	nativeID string
	origin   string
	exposed  *bool
	hidden   *bool
}

// BaseSensor is the base struct for all sensors. Embed this in concrete sensor types.
//
// Sensors are standalone entities: the plugin supplies the durable identity
// (WithNativeID), everything else belongs to the user: camera assignments,
// display name and whether the sensor is exported or not. A plugin
// never decides where its sensor is used and never handles the export itself.
type BaseSensor struct {
	mu                   sync.RWMutex
	id                   string
	name                 string
	displayName          string
	nativeID             string
	origin               string
	initialExposed       *bool
	initialHidden        *bool
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
	assignmentLocked     bool
	requiresFrames       bool
}

// NewBaseSensor creates the embedded base for a concrete sensor type. The id it
// assigns is provisional until the host registers the sensor, and Storage stays
// nil until then.
//
// Example:
//
//	type MySensor struct{ sdk.BaseSensor }
//
//	s := &MySensor{BaseSensor: sdk.NewBaseSensor("Front Door", sdk.WithNativeID("dev-1"))}
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
		origin:              cfg.origin,
		initialExposed:      cfg.exposed,
		initialHidden:       cfg.hidden,
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

func (s *BaseSensor) GetNativeID() string {
	return s.nativeID
}

func (s *BaseSensor) GetPluginID() string {
	return s.pluginID
}

func (s *BaseSensor) GetAssignedCameraIDs() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	ids := make([]string, len(s.assignedCameraIDs))
	copy(ids, s.assignedCameraIDs)
	return ids
}

func (s *BaseSensor) AssignmentLocked() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.assignmentLocked
}

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

// SetCapabilities replaces the advertised feature flags and notifies the
// backend plus local listeners.
//
// Example:
//
//	sensor.SetCapabilities([]string{sdk.LightCapabilityBrightness})
func (s *BaseSensor) SetCapabilities(caps []string) {
	s.mu.Lock()
	s.capabilities = caps
	capsCopy := make([]string, len(caps))
	copy(capsCopy, caps)
	updateFn := s.capabilitiesUpdateFn
	s.mu.Unlock()

	if updateFn != nil {
		updateFn(capsCopy)
	}
	s.capabilitiesChanged.Next(capsCopy)
}

// OnCapabilitiesChanged returns a Disposable that fires when capabilities change.
func (s *BaseSensor) OnCapabilitiesChanged(callback func([]string)) *Disposable {
	return s.capabilitiesChanged.Subscribe(callback)
}

// HasCapability reports whether the sensor advertises the given capability.
//
// Example:
//
//	dimmable := sensor.HasCapability(sdk.LightCapabilityBrightness)
func (s *BaseSensor) HasCapability(cap string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return slices.Contains(s.capabilities, cap)
}

func (s *BaseSensor) GetValue(property string) any {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.properties[property]
}

func (s *BaseSensor) GetValues() map[string]any {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make(map[string]any, len(s.properties))
	maps.Copy(result, s.properties)
	return result
}

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

func (s *BaseSensor) setAssignmentLocked() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.assignmentLocked = true
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
		if isEqual(previous, value, true) {
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

// no lifecycle hooks here, BaseSensor cannot reach the outer concrete type,
// setActiveWithLifecycle does that
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
		Origin:         s.origin,
		Exposed:        s.initialExposed,
		Hidden:         s.initialHidden,
		PluginID:       s.pluginID,
		Properties:     props,
		Capabilities:   s.capabilities,
		RequiresFrames: s.requiresFrames,
	}
}

// skips updateFn, echoing a backend-initiated change back to the server would loop
func (s *BaseSensor) onBackendPropertyChanged(property string, value any) {
	s.mu.Lock()
	oldValue := s.properties[property]
	if isEqual(oldValue, value, false) {
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
	if isEqual(oldValue, value, false) {
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

// no connectedChanged emission, teardown pairs OnStop but is not a connectivity signal
func (s *BaseSensor) deactivateQuiet() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.active {
		return false
	}
	s.active = false
	return true
}

// WithNativeID sets the plugin-supplied durable identity (e.g. an upstream
// device id). The host reconciles the sensor across restarts by
// (pluginId, nativeId); without it, identity falls back to (type, name) and a
// rename creates a new sensor.
func WithNativeID(nativeID string) SensorOption {
	return func(o *sensorOptions) {
		o.nativeID = nativeID
	}
}

// WithOrigin marks the source system the sensor was imported from (e.g.
// "homeassistant"). Export bridges targeting that system skip the sensor.
func WithOrigin(origin string) SensorOption {
	return func(o *sensorOptions) {
		o.origin = origin
	}
}

// WithExposed sets the initial export state on first creation; the user's
// later choice wins.
func WithExposed(exposed bool) SensorOption {
	return func(o *sensorOptions) {
		o.exposed = &exposed
	}
}

// WithHidden sets the initial hidden state on first creation; the user's
// later choice wins.
func WithHidden(hidden bool) SensorOption {
	return func(o *sensorOptions) {
		o.hidden = &hidden
	}
}

func generateSensorID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// base reaches the embedded Detection of a typed detection, so every sensor
// shares one normalization: smart-camera plugins report labels without
// coordinates, and downstream zone matching needs a box on every detection
func normalizeReportedDetections[T any](detected bool, detections []T, base func(*T) *Detection, fallbackLabel string, fallbackAttribute string) []T {
	if !detected {
		return []T{}
	}

	if len(detections) > 0 {
		out := make([]T, len(detections))
		copy(out, detections)
		for i := range out {
			if d := base(&out[i]); d.Box == nil {
				d.Box = &BoundingBox{X: 0, Y: 0, Width: 1, Height: 1}
			}
		}
		return out
	}

	var fallback T
	d := base(&fallback)
	d.Label = fallbackLabel
	d.Confidence = 1
	d.Box = &BoundingBox{X: 0, Y: 0, Width: 1, Height: 1}
	if fallbackAttribute != "" {
		d.Attribute = fallbackAttribute
	}
	return []T{fallback}
}

func isDetectionSensorType(t SensorType) bool {
	switch t {
	case SensorTypeMotion, SensorTypeAudio, SensorTypeObject, SensorTypeObjectAssist,
		SensorTypeFace, SensorTypeLicensePlate, SensorTypeClassifier, SensorTypeClip:
		return true
	}
	return false
}

func cleanupSensorWithLifecycle(outer any) {
	type quietDeactivator interface{ deactivateQuiet() bool }
	if qd, ok := outer.(quietDeactivator); ok && qd.deactivateQuiet() {
		fireSensorLifecycle(outer, false)
	}

	type cleanable interface{ cleanup() }
	if c, ok := outer.(cleanable); ok {
		c.cleanup()
	}
}

// outer must be the concrete sensor value, the type assertions need its full method set
func setActiveWithLifecycle(outer any, active bool) {
	type activatableSensor interface{ setActive(bool) bool }
	as, ok := outer.(activatableSensor)
	if !ok {
		return
	}

	if !as.setActive(active) {
		return
	}

	fireSensorLifecycle(outer, active)
}

func fireSensorLifecycle(outer any, active bool) {
	// swallow, lifecycle errors must not crash the runtime
	run := func(fn func()) {
		defer func() {
			_ = recover()
		}()
		fn()
	}
	go func() {
		if lc, ok := outer.(sensorLifecycle); ok {
			if active {
				run(lc.OnStart)
			} else {
				run(lc.OnStop)
			}
		}
	}()
}
