package sdk

const (
	contactPropertyDetected = "detected" // Whether the contact is open (true = open, false = closed)
)

// ContactSensor reports door/window open-close state.
type ContactSensor struct{ BaseSensor }

func NewContactSensor(name string) *ContactSensor {
	s := &ContactSensor{BaseSensor: NewBaseSensor(name)}
	s.writeState(map[string]any{
		contactPropertyDetected: false,
	})
	return s
}

func (s *ContactSensor) GetType() SensorType         { return SensorTypeContact }
func (s *ContactSensor) GetCategory() SensorCategory { return SensorCategorySensor }
func (s *ContactSensor) ToJSON() sensorJSON          { return s.toBaseJSON(s.GetType(), s.GetCategory()) }

func (s *ContactSensor) IsDetected() bool {
	v, _ := s.GetValue(contactPropertyDetected).(bool)
	return v
}

// SetDetected reports contact state (true = open, false = closed).
//
// Example:
//
//	contact.SetDetected(true)
func (s *ContactSensor) SetDetected(detected bool) {
	s.writeState(map[string]any{contactPropertyDetected: detected})
}

// UpdateValue is a no-op for read-only contact sensors.
func (s *ContactSensor) UpdateValue(property string, value any) error {
	return nil
}
