package sdk

const (
	carbonMonoxidePropertyDetected = "detected"
)

// CarbonMonoxideSensor reports carbon monoxide detection state.
type CarbonMonoxideSensor struct{ BaseSensor }

func NewCarbonMonoxideSensor(name string, opts ...SensorOption) *CarbonMonoxideSensor {
	s := &CarbonMonoxideSensor{BaseSensor: NewBaseSensor(name, opts...)}
	s.writeState(map[string]any{
		carbonMonoxidePropertyDetected: false,
	})
	return s
}

func (s *CarbonMonoxideSensor) GetType() SensorType         { return SensorTypeCarbonMonoxide }
func (s *CarbonMonoxideSensor) GetCategory() SensorCategory { return SensorCategorySensor }
func (s *CarbonMonoxideSensor) ToJSON() sensorJSON          { return s.toBaseJSON(s.GetType(), s.GetCategory()) }

func (s *CarbonMonoxideSensor) IsDetected() bool {
	v, _ := s.GetValue(carbonMonoxidePropertyDetected).(bool)
	return v
}

// SetDetected reports the carbon monoxide detection state.
//
// Example:
//
//	carbonMonoxide.SetDetected(true)
func (s *CarbonMonoxideSensor) SetDetected(detected bool) {
	s.writeState(map[string]any{carbonMonoxidePropertyDetected: detected})
}

// UpdateValue on a read-only sensor: external writes are ignored.
func (s *CarbonMonoxideSensor) UpdateValue(property string, value any) error {
	return nil
}
