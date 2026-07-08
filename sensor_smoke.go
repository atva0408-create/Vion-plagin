package sdk

const (
	smokePropertyDetected = "detected"
)

// SmokeSensor reports smoke detection state.
type SmokeSensor struct{ BaseSensor }

func NewSmokeSensor(name string) *SmokeSensor {
	s := &SmokeSensor{BaseSensor: NewBaseSensor(name)}
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

// SetDetected reports smoke detection state (true when smoke is currently
// detected).
//
// Example:
//
//	smoke.SetDetected(true)
func (s *SmokeSensor) SetDetected(detected bool) {
	s.writeState(map[string]any{smokePropertyDetected: detected})
}

// UpdateValue is a no-op for read-only smoke sensors.
func (s *SmokeSensor) UpdateValue(property string, value any) error {
	return nil
}
