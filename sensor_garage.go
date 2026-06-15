package sdk

// GarageState defines garage door states (HomeKit-compatible values).
type GarageState int

const (
	GarageStateOpen    GarageState = 0 // Garage door is open
	GarageStateClosed  GarageState = 1 // Garage door is closed
	GarageStateOpening GarageState = 2 // Garage door is opening
	GarageStateClosing GarageState = 3 // Garage door is closing
	GarageStateStopped GarageState = 4 // Garage door is stopped
)

// GarageProperty defines property names for garage controls.
const (
	garagePropertyCurrentState        = "currentState"
	garagePropertyTargetState         = "targetState"
	garagePropertyObstructionDetected = "obstructionDetected"
)

// GarageControl is a garage door control sensor.
type GarageControl struct{ BaseSensor }

// NewGarageControl creates a new GarageControl.
func NewGarageControl(name string) *GarageControl {
	s := &GarageControl{BaseSensor: NewBaseSensor(name)}
	s.writeState(map[string]any{
		garagePropertyCurrentState:        int(GarageStateClosed),
		garagePropertyTargetState:         int(GarageStateClosed),
		garagePropertyObstructionDetected: false,
	})
	return s
}

func (s *GarageControl) GetType() SensorType         { return SensorTypeGarage }
func (s *GarageControl) GetCategory() SensorCategory { return SensorCategoryControl }
func (s *GarageControl) ToJSON() sensorJSON          { return s.toBaseJSON(s.GetType(), s.GetCategory()) }

// GetCurrentState returns the actual current garage door state.
func (s *GarageControl) GetCurrentState() GarageState {
	if v, ok := s.GetValue(garagePropertyCurrentState).(int); ok {
		return GarageState(v)
	}
	return GarageStateClosed
}

// GetTargetState returns the desired target garage door state.
func (s *GarageControl) GetTargetState() GarageState {
	if v, ok := s.GetValue(garagePropertyTargetState).(int); ok {
		return GarageState(v)
	}
	return GarageStateClosed
}

// IsObstructionDetected returns whether an obstruction is detected.
func (s *GarageControl) IsObstructionDetected() bool {
	v, _ := s.GetValue(garagePropertyObstructionDetected).(bool)
	return v
}

// SetTargetState sets the target state. Writes both targetState and currentState.
func (s *GarageControl) SetTargetState(value GarageState) {
	s.writeState(map[string]any{
		garagePropertyTargetState:  int(value),
		garagePropertyCurrentState: int(value),
	})
}

// SetCurrentState publishes the actual door state. Use this to drive
// long-running transitions (e.g. Open → Closing → Closed) independently of
// the user-requested target state. Read-only from cross-process consumers
// (`UpdateValue` ignores it).
func (s *GarageControl) SetCurrentState(value GarageState) {
	s.writeState(map[string]any{garagePropertyCurrentState: int(value)})
}

// SetObstructionDetected publishes the obstruction detection state.
func (s *GarageControl) SetObstructionDetected(detected bool) {
	s.writeState(map[string]any{garagePropertyObstructionDetected: detected})
}

// UpdateValue dispatches generic property writes to semantic methods.
// Only `targetState` is externally writable. Numeric values arriving via
// msgpack may be any int/uint/float width — `toInt64` normalizes them.
func (s *GarageControl) UpdateValue(property string, value any) error {
	if property == garagePropertyTargetState {
		if v, ok := toInt64(value); ok {
			s.SetTargetState(GarageState(v))
		}
	}
	return nil
}
