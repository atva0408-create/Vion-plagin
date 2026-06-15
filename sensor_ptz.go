package sdk

// PTZCapability defines PTZ capabilities.
type PTZCapability string

const (
	PTZCapabilityPan     PTZCapability = "pan"
	PTZCapabilityTilt    PTZCapability = "tilt"
	PTZCapabilityZoom    PTZCapability = "zoom"
	PTZCapabilityPresets PTZCapability = "presets"
	PTZCapabilityHome    PTZCapability = "home"
)

// PTZDirection represents PTZ movement speed for continuous move commands.
type PTZDirection struct {
	PanSpeed  float64 `msgpack:"panSpeed" json:"panSpeed"`
	TiltSpeed float64 `msgpack:"tiltSpeed" json:"tiltSpeed"`
	ZoomSpeed float64 `msgpack:"zoomSpeed" json:"zoomSpeed"`
}

// PTZPosition represents an absolute PTZ position.
type PTZPosition struct {
	Pan  float64 `msgpack:"pan" json:"pan"`
	Tilt float64 `msgpack:"tilt" json:"tilt"`
	Zoom float64 `msgpack:"zoom" json:"zoom"`
}

// PTZProperty defines property names for PTZ controls.
const (
	ptzPropertyPosition     = "position"
	ptzPropertyMoving       = "moving"
	ptzPropertyPresets      = "presets"
	ptzPropertyVelocity     = "velocity"
	ptzPropertyTargetPreset = "targetPreset"
)

// PTZControl is a pan-tilt-zoom camera control sensor.
type PTZControl struct{ BaseSensor }

// NewPTZControl creates a new PTZControl.
func NewPTZControl(name string) *PTZControl {
	s := &PTZControl{BaseSensor: NewBaseSensor(name)}
	s.writeState(map[string]any{
		ptzPropertyPosition: PTZPosition{Pan: 0, Tilt: 0, Zoom: 0},
		ptzPropertyMoving:   false,
		ptzPropertyPresets:  []string{},
	})
	return s
}

func (s *PTZControl) GetType() SensorType         { return SensorTypePTZ }
func (s *PTZControl) GetCategory() SensorCategory { return SensorCategoryControl }
func (s *PTZControl) ToJSON() sensorJSON          { return s.toBaseJSON(s.GetType(), s.GetCategory()) }

// GetPosition returns the current PTZ position.
func (s *PTZControl) GetPosition() PTZPosition {
	if v, ok := s.GetValue(ptzPropertyPosition).(PTZPosition); ok {
		return v
	}
	return PTZPosition{}
}

// IsMoving returns whether the PTZ is currently moving.
func (s *PTZControl) IsMoving() bool {
	v, _ := s.GetValue(ptzPropertyMoving).(bool)
	return v
}

// GetPresets returns the list of available preset names.
func (s *PTZControl) GetPresets() []string {
	if v, ok := s.GetValue(ptzPropertyPresets).([]string); ok {
		return v
	}
	return nil
}

// SetPosition sets the absolute PTZ position.
func (s *PTZControl) SetPosition(value PTZPosition) {
	s.writeState(map[string]any{ptzPropertyPosition: value})
}

// SetVelocity sets the continuous-move velocity.
func (s *PTZControl) SetVelocity(value PTZDirection) {
	s.writeState(map[string]any{ptzPropertyVelocity: value})
}

// SetTargetPreset sets the target preset ID.
func (s *PTZControl) SetTargetPreset(value string) {
	s.writeState(map[string]any{ptzPropertyTargetPreset: value})
}

// SetPresets publishes the discovered preset list.
func (s *PTZControl) SetPresets(value []string) {
	s.writeState(map[string]any{ptzPropertyPresets: value})
}

// SetMoving publishes the movement state.
func (s *PTZControl) SetMoving(value bool) {
	s.writeState(map[string]any{ptzPropertyMoving: value})
}

// GoHome moves the PTZ to the home position (0, 0, 0).
func (s *PTZControl) GoHome() {
	s.SetPosition(PTZPosition{Pan: 0, Tilt: 0, Zoom: 0})
}

// UpdateValue dispatches generic property writes to semantic methods.
// Only Position, Velocity, and TargetPreset are externally writable.
func (s *PTZControl) UpdateValue(property string, value any) error {
	switch property {
	case ptzPropertyPosition:
		if pos, ok := coercePTZPosition(value); ok {
			s.SetPosition(pos)
		}
	case ptzPropertyVelocity:
		if dir, ok := coercePTZDirection(value); ok {
			s.SetVelocity(dir)
		}
	case ptzPropertyTargetPreset:
		if str, ok := value.(string); ok {
			s.SetTargetPreset(str)
		}
	}
	return nil
}

// coercePTZPosition attempts to convert a value into a PTZPosition.
func coercePTZPosition(value any) (PTZPosition, bool) {
	switch v := value.(type) {
	case PTZPosition:
		return v, true
	case map[string]any:
		pan, _ := toFloat64(v["pan"])
		tilt, _ := toFloat64(v["tilt"])
		zoom, _ := toFloat64(v["zoom"])
		return PTZPosition{Pan: pan, Tilt: tilt, Zoom: zoom}, true
	}
	return PTZPosition{}, false
}

// coercePTZDirection attempts to convert a value into a PTZDirection.
func coercePTZDirection(value any) (PTZDirection, bool) {
	switch v := value.(type) {
	case PTZDirection:
		return v, true
	case map[string]any:
		pan, _ := toFloat64(v["panSpeed"])
		tilt, _ := toFloat64(v["tiltSpeed"])
		zoom, _ := toFloat64(v["zoomSpeed"])
		return PTZDirection{PanSpeed: pan, TiltSpeed: tilt, ZoomSpeed: zoom}, true
	}
	return PTZDirection{}, false
}
