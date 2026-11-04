package sdk

const (
	carbonDioxidePropertyCurrent = "current"
)

// CarbonDioxideInfo reports the current CO2 concentration in ppm.
type CarbonDioxideInfo struct{ BaseSensor }

func NewCarbonDioxideInfo(name string, opts ...SensorOption) *CarbonDioxideInfo {
	s := &CarbonDioxideInfo{BaseSensor: NewBaseSensor(name, opts...)}
	s.writeState(map[string]any{
		carbonDioxidePropertyCurrent: 20.0,
	})
	return s
}

func (s *CarbonDioxideInfo) GetType() SensorType         { return SensorTypeCarbonDioxide }
func (s *CarbonDioxideInfo) GetCategory() SensorCategory { return SensorCategoryInfo }
func (s *CarbonDioxideInfo) ToJSON() sensorJSON          { return s.toBaseJSON(s.GetType(), s.GetCategory()) }

func (s *CarbonDioxideInfo) GetCurrent() float64 {
	v, _ := s.GetValue(carbonDioxidePropertyCurrent).(float64)
	return v
}

// SetCurrent reports a new CO2 reading (clamped to [0,40000]).
//
// Example:
//
//	carbonDioxide.SetCurrent(600)
func (s *CarbonDioxideInfo) SetCurrent(value float64) {
	if value < 0 {
		value = 0
	}
	if value > 40000 {
		value = 40000
	}
	s.writeState(map[string]any{carbonDioxidePropertyCurrent: value})
}

// UpdateValue on a read-only sensor: external writes are ignored.
func (s *CarbonDioxideInfo) UpdateValue(property string, value any) error {
	return nil
}
