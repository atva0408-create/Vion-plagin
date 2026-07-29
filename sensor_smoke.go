package sdk

const (
	smokePropertyDetected = "detected"
)

// SmokeSensor reports smoke detection state.
type SmokeSensor struct{ BaseSensor }

func NewSmokeSensor(name string, opts ...SensorOption) *SmokeSensor {
	s := &SmokeSensor{BaseSensor: NewBaseSensor(name, opts...)}
	s.writeState(map[string]any{
		smokePropertyDetected: false,
	})
	return s
}

func (s *SmokeSensor) GetType() SensorType         { return SensorTypeSmoke }
func (s *SmokeSensor) GetCategory() SensorCategory { return SensorCategorySensor }
func (s *SmokeSensor) ToJSON() sensorJSON          { return s.toBaseJSON(s.GetType(), s.GetCategory()) }

func (s *SmokeSensor) IsDetected() bool {
	v, _ := s.GetValue(smokePropertyDetected).(bool)
	return v
}

// SetDetected reports the smoke detection state.
//
// Example:
//
//	smoke.SetDetected(true)
func (s *SmokeSensor) SetDetected(detected bool) {
	s.writeState(map[string]any{smokePropertyDetected: detected})
}

// UpdateValue on a read-only sensor: external writes are ignored.
func (s *SmokeSensor) UpdateValue(property string, value any) error {
	return nil
}
