package sdk

// SwitchProperty defines property names for switch controls.
const (
	switchPropertyOn = "on"
)

// SwitchControl is a generic on/off switch control sensor.
type SwitchControl struct{ BaseSensor }

// NewSwitchControl creates a new SwitchControl.
func NewSwitchControl(name string) *SwitchControl {
	s := &SwitchControl{BaseSensor: NewBaseSensor(name)}
	s.writeState(map[string]any{
		switchPropertyOn: false,
	})
	return s
}

func (s *SwitchControl) GetType() SensorType         { return SensorTypeSwitch }
func (s *SwitchControl) GetCategory() SensorCategory { return SensorCategoryControl }
func (s *SwitchControl) ToJSON() sensorJSON          { return s.toBaseJSON(s.GetType(), s.GetCategory()) }

// IsOn returns whether the switch is on.
func (s *SwitchControl) IsOn() bool {
	v, _ := s.GetValue(switchPropertyOn).(bool)
	return v
}

// SetOn turns the switch on.
func (s *SwitchControl) SetOn() {
	s.writeState(map[string]any{switchPropertyOn: true})
}

// SetOff turns the switch off.
func (s *SwitchControl) SetOff() {
	s.writeState(map[string]any{switchPropertyOn: false})
}

// UpdateValue dispatches generic property writes to semantic methods.
// Numeric values arriving via msgpack may be any int/uint/float width —
// `toInt64` normalizes them. Boolean values are checked directly.
func (s *SwitchControl) UpdateValue(property string, value any) error {
	if property == switchPropertyOn {
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
	}
	return nil
}
