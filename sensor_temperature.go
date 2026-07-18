package sdk

const (
	temperaturePropertyCurrent = "current" // Current temperature in degrees Celsius
)

// TemperatureInfo reports current temperature in °C.
type TemperatureInfo struct{ BaseSensor }

func NewTemperatureInfo(name string) *TemperatureInfo {
	s := &TemperatureInfo{BaseSensor: NewBaseSensor(name)}
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

// SetCurrent sets the current temperature (clamped to [-270,100]).
func (s *TemperatureInfo) SetCurrent(value float64) {
	if value < -270 {
		value = -270
	}
	if value > 100 {
		value = 100
	}
	s.writeState(map[string]any{temperaturePropertyCurrent: value})
}

// UpdateValue is a no-op for read-only temperature sensors.
func (s *TemperatureInfo) UpdateValue(property string, value any) error {
	return nil
}
