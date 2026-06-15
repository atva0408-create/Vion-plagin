package sdk

// HumidityProperty defines property names for humidity sensors.
const (
	humidityPropertyCurrent = "current"
)

// HumidityInfo reports current relative humidity (0–100%).
type HumidityInfo struct{ BaseSensor }

// NewHumidityInfo creates a new HumidityInfo.
func NewHumidityInfo(name string) *HumidityInfo {
	s := &HumidityInfo{BaseSensor: NewBaseSensor(name)}
	s.writeState(map[string]any{
		humidityPropertyCurrent: 50.0,
	})
	return s
}

func (s *HumidityInfo) GetType() SensorType         { return SensorTypeHumidity }
func (s *HumidityInfo) GetCategory() SensorCategory { return SensorCategoryInfo }
func (s *HumidityInfo) ToJSON() sensorJSON          { return s.toBaseJSON(s.GetType(), s.GetCategory()) }

// GetCurrent returns the current relative humidity.
func (s *HumidityInfo) GetCurrent() float64 {
	v, _ := s.GetValue(humidityPropertyCurrent).(float64)
	return v
}

// SetCurrent sets the current relative humidity (clamped to [0,100]).
func (s *HumidityInfo) SetCurrent(value float64) {
	if value < 0 {
		value = 0
	}
	if value > 100 {
		value = 100
	}
	s.writeState(map[string]any{humidityPropertyCurrent: value})
}

// UpdateValue is a no-op for read-only humidity sensors.
func (s *HumidityInfo) UpdateValue(property string, value any) error {
	return nil
}
