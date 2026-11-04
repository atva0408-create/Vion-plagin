package sdk

const (
	vibrationPropertyDetected = "detected"
)

// VibrationSensor reports vibration detection state.
type VibrationSensor struct{ BaseSensor }

func NewVibrationSensor(name string, opts ...SensorOption) *VibrationSensor {
	s := &VibrationSensor{BaseSensor: NewBaseSensor(name, opts...)}
	s.writeState(map[string]any{
		vibrationPropertyDetected: false,
	})
	return s
}

func (s *VibrationSensor) GetType() SensorType         { return SensorTypeVibration }
func (s *VibrationSensor) GetCategory() SensorCategory { return SensorCategorySensor }
func (s *VibrationSensor) ToJSON() sensorJSON          { return s.toBaseJSON(s.GetType(), s.GetCategory()) }

func (s *VibrationSensor) IsDetected() bool {
	v, _ := s.GetValue(vibrationPropertyDetected).(bool)
	return v
}

// SetDetected reports the vibration detection state.
//
// Example:
//
//	vibration.SetDetected(true)
func (s *VibrationSensor) SetDetected(detected bool) {
	s.writeState(map[string]any{vibrationPropertyDetected: detected})
}

// UpdateValue on a read-only sensor: external writes are ignored.
func (s *VibrationSensor) UpdateValue(property string, value any) error {
	return nil
}
