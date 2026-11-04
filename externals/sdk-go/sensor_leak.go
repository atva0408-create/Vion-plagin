package sdk

const (
	leakPropertyDetected = "detected"
)

// LeakSensor reports water leak detection state.
type LeakSensor struct{ BaseSensor }

func NewLeakSensor(name string, opts ...SensorOption) *LeakSensor {
	s := &LeakSensor{BaseSensor: NewBaseSensor(name, opts...)}
	s.writeState(map[string]any{
		leakPropertyDetected: false,
	})
	return s
}

func (s *LeakSensor) GetType() SensorType         { return SensorTypeLeak }
func (s *LeakSensor) GetCategory() SensorCategory { return SensorCategorySensor }
func (s *LeakSensor) ToJSON() sensorJSON          { return s.toBaseJSON(s.GetType(), s.GetCategory()) }

func (s *LeakSensor) IsDetected() bool {
	v, _ := s.GetValue(leakPropertyDetected).(bool)
	return v
}

// SetDetected reports leak detection state (true when a water leak is
// currently detected).
//
// Example:
//
//	leak.SetDetected(true)
func (s *LeakSensor) SetDetected(detected bool) {
	s.writeState(map[string]any{leakPropertyDetected: detected})
}

// UpdateValue on a read-only sensor: external writes are ignored.
func (s *LeakSensor) UpdateValue(property string, value any) error {
	return nil
}
