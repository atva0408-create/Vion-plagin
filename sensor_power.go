package sdk

const (
	powerPropertyDetected = "detected"
)

// PowerSensor reports power detection state.
type PowerSensor struct{ BaseSensor }

func NewPowerSensor(name string, opts ...SensorOption) *PowerSensor {
	s := &PowerSensor{BaseSensor: NewBaseSensor(name, opts...)}
	s.writeState(map[string]any{
		powerPropertyDetected: false,
	})
	return s
}

func (s *PowerSensor) GetType() SensorType         { return SensorTypePower }
func (s *PowerSensor) GetCategory() SensorCategory { return SensorCategorySensor }
func (s *PowerSensor) ToJSON() sensorJSON          { return s.toBaseJSON(s.GetType(), s.GetCategory()) }

func (s *PowerSensor) IsDetected() bool {
	v, _ := s.GetValue(powerPropertyDetected).(bool)
	return v
}

// SetDetected reports the power detection state.
//
// Example:
//
//	power.SetDetected(true)
func (s *PowerSensor) SetDetected(detected bool) {
	s.writeState(map[string]any{powerPropertyDetected: detected})
}

// UpdateValue on a read-only sensor: external writes are ignored.
func (s *PowerSensor) UpdateValue(property string, value any) error {
	return nil
}
