package sdk

const (
	problemPropertyDetected = "detected"
)

// ProblemSensor reports the problem state.
type ProblemSensor struct{ BaseSensor }

func NewProblemSensor(name string, opts ...SensorOption) *ProblemSensor {
	s := &ProblemSensor{BaseSensor: NewBaseSensor(name, opts...)}
	s.writeState(map[string]any{
		problemPropertyDetected: false,
	})
	return s
}

func (s *ProblemSensor) GetType() SensorType         { return SensorTypeProblem }
func (s *ProblemSensor) GetCategory() SensorCategory { return SensorCategorySensor }
func (s *ProblemSensor) ToJSON() sensorJSON          { return s.toBaseJSON(s.GetType(), s.GetCategory()) }

func (s *ProblemSensor) IsDetected() bool {
	v, _ := s.GetValue(problemPropertyDetected).(bool)
	return v
}

// SetDetected reports the the problem state.
//
// Example:
//
//	problem.SetDetected(true)
func (s *ProblemSensor) SetDetected(detected bool) {
	s.writeState(map[string]any{problemPropertyDetected: detected})
}

// UpdateValue on a read-only sensor: external writes are ignored.
func (s *ProblemSensor) UpdateValue(property string, value any) error {
	return nil
}
