package sdk

const (
	heatPropertyDetected = "detected"
)

// HeatSensor reports abnormal heat detection state.
type HeatSensor struct{ BaseSensor }

func NewHeatSensor(name string, opts ...SensorOption) *HeatSensor {
	s := &HeatSensor{BaseSensor: NewBaseSensor(name, opts...)}
	s.writeState(map[string]any{
		heatPropertyDetected: false,
	})
	return s
}

func (s *HeatSensor) GetType() SensorType         { return SensorTypeHeat }
func (s *HeatSensor) GetCategory() SensorCategory { return SensorCategorySensor }
func (s *HeatSensor) ToJSON() sensorJSON          { return s.toBaseJSON(s.GetType(), s.GetCategory()) }

func (s *HeatSensor) IsDetected() bool {
	v, _ := s.GetValue(heatPropertyDetected).(bool)
	return v
}

// SetDetected reports the abnormal heat detection state.
//
// Example:
//
//	heat.SetDetected(true)
func (s *HeatSensor) SetDetected(detected bool) {
	s.writeState(map[string]any{heatPropertyDetected: detected})
}

// UpdateValue on a read-only sensor: external writes are ignored.
func (s *HeatSensor) UpdateValue(property string, value any) error {
	return nil
}
