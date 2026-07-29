package sdk

const (
	temperaturePropertyCurrent = "current"
)

// TemperatureInfo reports the current temperature in degrees Celsius.
type TemperatureInfo struct{ BaseSensor }

func NewTemperatureInfo(name string, opts ...SensorOption) *TemperatureInfo {
	s := &TemperatureInfo{BaseSensor: NewBaseSensor(name, opts...)}
	s.writeState(map[string]any{
		temperaturePropertyCurrent: 20.0,
	})
	return s
}

func (s *TemperatureInfo) GetType() SensorType         { return SensorTypeTemperature }
func (s *TemperatureInfo) GetCategory() SensorCategory { return SensorCategoryInfo }
func (s *TemperatureInfo) ToJSON() sensorJSON          { return s.toBaseJSON(s.GetType(), s.GetCategory()) }

func (s *TemperatureInfo) GetCurrent() float64 {
	v, _ := s.GetValue(temperaturePropertyCurrent).(float64)
	return v
}

// SetCurrent reports a new temperature reading (clamped to [-270,100]).
//
// Example:
//
//	temperature.SetCurrent(21.5)
func (s *TemperatureInfo) SetCurrent(value float64) {
	if value < -270 {
		value = -270
	}
	if value > 100 {
		value = 100
	}
	s.writeState(map[string]any{temperaturePropertyCurrent: value})
}

// UpdateValue on a read-only sensor: external writes are ignored.
func (s *TemperatureInfo) UpdateValue(property string, value any) error {
	return nil
}
