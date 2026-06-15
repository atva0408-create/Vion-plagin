package sdk

// LightProperty defines property names for light controls.
const (
	lightPropertyOn         = "on"
	lightPropertyBrightness = "brightness"
)

// LightCapability defines optional capabilities for light controls.
const (
	LightCapabilityBrightness = "brightness"
)

// LightControl is a light on/off and brightness control sensor. Override
// SetOn / SetOff (by embedding LightControl in your own type and shadowing
// the methods) to drive your hardware, then call the embedded LightControl's
// methods to sync the SDK state.
//
// Plugins that have no hardware-action use case can leave the methods
// unoverridden — the base implementation just updates the state.
//
// For hardware-pushed updates (someone manually flipped the switch), call
// the embedded LightControl's SetOn / SetOff directly from your event
// handler — that bypasses any plugin override and only syncs state.
type LightControl struct{ BaseSensor }

// NewLightControl creates a new LightControl.
func NewLightControl(name string) *LightControl {
	s := &LightControl{BaseSensor: NewBaseSensor(name)}
	s.writeState(map[string]any{
		lightPropertyOn:         false,
		lightPropertyBrightness: 100,
	})
	return s
}

func (s *LightControl) GetType() SensorType         { return SensorTypeLight }
func (s *LightControl) GetCategory() SensorCategory { return SensorCategoryControl }
func (s *LightControl) ToJSON() sensorJSON          { return s.toBaseJSON(s.GetType(), s.GetCategory()) }

// IsOn returns whether the light is on.
func (s *LightControl) IsOn() bool {
	v, _ := s.GetValue(lightPropertyOn).(bool)
	return v
}

// GetBrightness returns the brightness level (0–100).
func (s *LightControl) GetBrightness() int {
	if v, ok := s.GetValue(lightPropertyBrightness).(int); ok {
		return v
	}
	return 0
}

// SetOn turns the light on. Override (via embedding) to drive hardware and
// call the embedded LightControl's SetOn to sync the SDK state.
//
// Example:
//
//	light.SetOn()
func (s *LightControl) SetOn() {
	s.writeState(map[string]any{lightPropertyOn: true})
}

// SetOff turns the light off. Override (via embedding) to drive hardware and
// call the embedded LightControl's SetOff to sync the SDK state.
//
// Example:
//
//	light.SetOff()
func (s *LightControl) SetOff() {
	s.writeState(map[string]any{lightPropertyOn: false})
}

// SetBrightness sets the brightness level (clamped to [0, 100]). Override
// (via embedding) to drive hardware and call the embedded LightControl's
// SetBrightness to sync the SDK state.
//
// Example:
//
//	light.SetBrightness(75)
func (s *LightControl) SetBrightness(value int) {
	if value < 0 {
		value = 0
	}
	if value > 100 {
		value = 100
	}
	s.writeState(map[string]any{lightPropertyBrightness: value})
}

// UpdateValue dispatches generic property writes to semantic methods.
// Numeric values arriving via msgpack may be any int/uint/float width —
// `toInt64` normalizes them. Boolean values are checked directly.
func (s *LightControl) UpdateValue(property string, value any) error {
	switch property {
	case lightPropertyOn:
		on := false
		if b, ok := value.(bool); ok {
			on = b
		} else if v, ok := toInt64(value); ok {
			on = v != 0
		}
		if on {
			s.SetOn()
		} else {
			s.SetOff()
		}
	case lightPropertyBrightness:
		if v, ok := toInt64(value); ok {
			s.SetBrightness(int(v))
		}
	}
	return nil
}
