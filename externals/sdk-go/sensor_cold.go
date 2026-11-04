package sdk

const (
	coldPropertyDetected = "detected"
)

// ColdSensor reports abnormal cold detection state.
type ColdSensor struct{ BaseSensor }

func NewColdSensor(name string, opts ...SensorOption) *ColdSensor {
	s := &ColdSensor{BaseSensor: NewBaseSensor(name, opts...)}
	s.writeState(map[string]any{
		coldPropertyDetected: false,
	})
	return s
}

func (s *ColdSensor) GetType() SensorType         { return SensorTypeCold }
func (s *ColdSensor) GetCategory() SensorCategory { return SensorCategorySensor }
func (s *ColdSensor) ToJSON() sensorJSON          { return s.toBaseJSON(s.GetType(), s.GetCategory()) }

func (s *ColdSensor) IsDetected() bool {
	v, _ := s.GetValue(coldPropertyDetected).(bool)
	return v
}

// SetDetected reports the abnormal cold detection state.
//
// Example:
//
//	cold.SetDetected(true)
func (s *ColdSensor) SetDetected(detected bool) {
	s.writeState(map[string]any{coldPropertyDetected: detected})
}

// UpdateValue on a read-only sensor: external writes are ignored.
func (s *ColdSensor) UpdateValue(property string, value any) error {
	return nil
}
