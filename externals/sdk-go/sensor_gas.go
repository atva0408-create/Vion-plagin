package sdk

const (
	gasPropertyDetected = "detected"
)

// GasSensor reports gas detection state.
type GasSensor struct{ BaseSensor }

func NewGasSensor(name string, opts ...SensorOption) *GasSensor {
	s := &GasSensor{BaseSensor: NewBaseSensor(name, opts...)}
	s.writeState(map[string]any{
		gasPropertyDetected: false,
	})
	return s
}

func (s *GasSensor) GetType() SensorType         { return SensorTypeGas }
func (s *GasSensor) GetCategory() SensorCategory { return SensorCategorySensor }
func (s *GasSensor) ToJSON() sensorJSON          { return s.toBaseJSON(s.GetType(), s.GetCategory()) }

func (s *GasSensor) IsDetected() bool {
	v, _ := s.GetValue(gasPropertyDetected).(bool)
	return v
}

// SetDetected reports the gas detection state.
//
// Example:
//
//	gas.SetDetected(true)
func (s *GasSensor) SetDetected(detected bool) {
	s.writeState(map[string]any{gasPropertyDetected: detected})
}

// UpdateValue on a read-only sensor: external writes are ignored.
func (s *GasSensor) UpdateValue(property string, value any) error {
	return nil
}
