package sdk

const (
	occupancyPropertyDetected = "detected" // Whether occupancy is detected (true = occupied)
)

// OccupancySensor reports occupancy/presence state.
type OccupancySensor struct{ BaseSensor }

func NewOccupancySensor(name string) *OccupancySensor {
	s := &OccupancySensor{BaseSensor: NewBaseSensor(name)}
	s.writeState(map[string]any{
		occupancyPropertyDetected: false,
	})
	return s
}

func (s *OccupancySensor) GetType() SensorType         { return SensorTypeOccupancy }
func (s *OccupancySensor) GetCategory() SensorCategory { return SensorCategorySensor }
func (s *OccupancySensor) ToJSON() sensorJSON          { return s.toBaseJSON(s.GetType(), s.GetCategory()) }

func (s *OccupancySensor) IsDetected() bool {
	v, _ := s.GetValue(occupancyPropertyDetected).(bool)
	return v
}

// SetDetected reports occupancy state (true when the area is currently
// occupied).
//
// Example:
//
//	occupancy.SetDetected(true)
func (s *OccupancySensor) SetDetected(detected bool) {
	s.writeState(map[string]any{occupancyPropertyDetected: detected})
}

// UpdateValue is a no-op for read-only occupancy sensors.
func (s *OccupancySensor) UpdateValue(property string, value any) error {
	return nil
}
