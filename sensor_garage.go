package sdk

// GarageState defines garage door states (HomeKit-compatible values).
type GarageState int

const (
	GarageStateOpen    GarageState = 0
	GarageStateClosed  GarageState = 1
	GarageStateOpening GarageState = 2
	GarageStateClosing GarageState = 3
	GarageStateStopped GarageState = 4
)

const (
	garagePropertyCurrentState        = "currentState"        // The actual current state of the garage door
	garagePropertyTargetState         = "targetState"         // The desired target state (set by user, transitions to currentState)
	garagePropertyObstructionDetected = "obstructionDetected" // Whether an obstruction is detected
)

// GarageControl is a garage door control sensor. Override SetTargetState (by
// embedding GarageControl in your own type and shadowing the method) to drive
// hardware and call the embedded GarageControl's SetTargetState once the
// hardware confirms — the base implementation updates both targetState and
// currentState.
//
// For long-running transitions (Opening/Closing intermediate states) override
// SetTargetState and write currentState separately as the door moves.
type GarageControl struct{ BaseSensor }

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

func (s *GarageControl) GetCurrentState() GarageState {
	if v, ok := s.GetValue(garagePropertyCurrentState).(int); ok {
		return GarageState(v)
	}
	return GarageStateClosed
}

func (s *GarageControl) GetTargetState() GarageState {
	if v, ok := s.GetValue(garagePropertyTargetState).(int); ok {
		return GarageState(v)
	}
	return GarageStateClosed
}

func (s *GarageControl) IsObstructionDetected() bool {
	v, _ := s.GetValue(garagePropertyObstructionDetected).(bool)
	return v
}

// SetTargetState sets the target state. Writes both targetState and currentState.
//
// Example:
//
//	garage.SetTargetState(GarageStateOpen)
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
//
// Example:
//
//	garage.SetCurrentState(GarageStateClosing)
func (s *GarageControl) SetCurrentState(value GarageState) {
	s.writeState(map[string]any{garagePropertyCurrentState: int(value)})
}

// SetObstructionDetected publishes the obstruction detection state.
//
// Example:
//
//	garage.SetObstructionDetected(true)
func (s *GarageControl) SetObstructionDetected(detected bool) {
	s.writeState(map[string]any{garagePropertyObstructionDetected: detected})
}

// UpdateValue dispatches generic property writes to semantic methods.
func (s *GarageControl) UpdateValue(property string, value any) error {
	if property == garagePropertyTargetState {
		if v, ok := toInt64(value); ok {
			s.SetTargetState(GarageState(v))
		}
	}
	return nil
}
