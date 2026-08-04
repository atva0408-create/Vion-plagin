package sdk

const (
	tamperPropertyDetected = "detected"
)

// TamperSensor reports tampering detection state.
type TamperSensor struct{ BaseSensor }

func NewTamperSensor(name string, opts ...SensorOption) *TamperSensor {
	s := &TamperSensor{BaseSensor: NewBaseSensor(name, opts...)}
	s.writeState(map[string]any{
		tamperPropertyDetected: false,
	})
	return s
}

func (s *TamperSensor) GetType() SensorType         { return SensorTypeTamper }
func (s *TamperSensor) GetCategory() SensorCategory { return SensorCategorySensor }
func (s *TamperSensor) ToJSON() sensorJSON          { return s.toBaseJSON(s.GetType(), s.GetCategory()) }

func (s *TamperSensor) IsDetected() bool {
	v, _ := s.GetValue(tamperPropertyDetected).(bool)
	return v
}

// SetDetected reports the tampering detection state.
//
// Example:
//
//	tamper.SetDetected(true)
func (s *TamperSensor) SetDetected(detected bool) {
	s.writeState(map[string]any{tamperPropertyDetected: detected})
}

// UpdateValue on a read-only sensor: external writes are ignored.
func (s *TamperSensor) UpdateValue(property string, value any) error {
	return nil
}
