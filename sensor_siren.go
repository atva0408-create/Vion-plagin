package sdk

const (
	sirenPropertyActive = "active" // Whether the siren is currently active
	sirenPropertyVolume = "volume" // Volume level (0-100)
)

// SirenControl is a siren on/off and volume control sensor. Override
// SetActive / SetInactive (by embedding SirenControl in your own type and
// shadowing the methods) to drive your hardware, then call the embedded
// SirenControl's methods to sync the SDK state. For hardware-pushed updates,
// call the embedded methods directly from your event handler — that bypasses
// any plugin override and only syncs state.
type SirenControl struct{ BaseSensor }

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

func (s *SirenControl) IsActive() bool {
	v, _ := s.GetValue(sirenPropertyActive).(bool)
	return v
}

func (s *SirenControl) GetVolume() int {
	if v, ok := s.GetValue(sirenPropertyVolume).(int); ok {
		return v
	}
	return 0
}

// SetActive activates the siren.
//
// Example:
//
//	siren.SetActive()
func (s *SirenControl) SetActive() {
	s.writeState(map[string]any{sirenPropertyActive: true})
}

// SetInactive deactivates the siren.
//
// Example:
//
//	siren.SetInactive()
func (s *SirenControl) SetInactive() {
	s.writeState(map[string]any{sirenPropertyActive: false})
}

// SetVolume sets the siren volume (clamped to [0,100]).
//
// Example:
//
//	siren.SetVolume(80)
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
