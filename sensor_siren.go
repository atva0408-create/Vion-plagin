package sdk

// SirenProperty defines property names for siren controls.
const (
	sirenPropertyActive = "active"
	sirenPropertyVolume = "volume"
)

// SirenControl is a siren on/off and volume control sensor.
type SirenControl struct{ BaseSensor }

// NewSirenControl creates a new SirenControl.
func NewSirenControl(name string) *SirenControl {
	s := &SirenControl{BaseSensor: NewBaseSensor(name)}
	s.writeState(map[string]any{
		sirenPropertyActive: false,
		sirenPropertyVolume: 100,
	})
	return s
}

func (s *SirenControl) GetType() SensorType         { return SensorTypeSiren }
func (s *SirenControl) GetCategory() SensorCategory { return SensorCategoryControl }
func (s *SirenControl) ToJSON() sensorJSON          { return s.toBaseJSON(s.GetType(), s.GetCategory()) }

// IsActive returns whether the siren is active.
func (s *SirenControl) IsActive() bool {
	v, _ := s.GetValue(sirenPropertyActive).(bool)
	return v
}

// GetVolume returns the siren volume (0–100).
func (s *SirenControl) GetVolume() int {
	if v, ok := s.GetValue(sirenPropertyVolume).(int); ok {
		return v
	}
	return 0
}

// SetActive activates the siren.
func (s *SirenControl) SetActive() {
	s.writeState(map[string]any{sirenPropertyActive: true})
}

// SetInactive deactivates the siren.
func (s *SirenControl) SetInactive() {
	s.writeState(map[string]any{sirenPropertyActive: false})
}

// SetVolume sets the siren volume (clamped to [0,100]).
func (s *SirenControl) SetVolume(value int) {
	if value < 0 {
		value = 0
	}
	if value > 100 {
		value = 100
	}
	s.writeState(map[string]any{sirenPropertyVolume: value})
}

// UpdateValue dispatches generic property writes to semantic methods.
// Numeric values arriving via msgpack may be any int/uint/float width —
// `toInt64` normalizes them. Boolean values are checked directly.
func (s *SirenControl) UpdateValue(property string, value any) error {
	switch property {
	case sirenPropertyActive:
		active := false
		if b, ok := value.(bool); ok {
			active = b
		} else if v, ok := toInt64(value); ok {
			active = v != 0
		}
		if active {
			s.SetActive()
		} else {
			s.SetInactive()
		}
	case sirenPropertyVolume:
		if v, ok := toInt64(value); ok {
			s.SetVolume(int(v))
		}
	}
	return nil
}
