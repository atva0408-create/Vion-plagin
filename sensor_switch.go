package sdk

const (
	switchPropertyOn = "on" // Whether the switch is on
)

// SwitchControl is a generic on/off switch control sensor. Override SetOn /
// SetOff (by embedding SwitchControl in your own type and shadowing the
// methods) to drive hardware, then call the embedded SwitchControl's methods
// to sync the SDK state. For hardware-pushed updates, call the embedded
// methods directly from your event handler — that bypasses any plugin
// override and only syncs state.
type SwitchControl struct{ BaseSensor }

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

func (s *SwitchControl) IsOn() bool {
	v, _ := s.GetValue(switchPropertyOn).(bool)
	return v
}

// SetOn turns the switch on.
//
// Example:
//
//	sw.SetOn()
func (s *SwitchControl) SetOn() {
	s.writeState(map[string]any{switchPropertyOn: true})
}

// SetOff turns the switch off.
//
// Example:
//
//	sw.SetOff()
func (s *SwitchControl) SetOff() {
	s.writeState(map[string]any{switchPropertyOn: false})
}

// UpdateValue dispatches generic property writes to semantic methods.
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
