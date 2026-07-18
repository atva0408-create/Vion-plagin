package sdk

// SecuritySystemState defines security system states.
type SecuritySystemState int

const (
	SecuritySystemStateStayArm        SecuritySystemState = 0 // Armed, occupants home
	SecuritySystemStateAwayArm        SecuritySystemState = 1 // Armed, occupants away
	SecuritySystemStateNightArm       SecuritySystemState = 2 // Armed for night mode
	SecuritySystemStateDisarmed       SecuritySystemState = 3 // System disarmed
	SecuritySystemStateAlarmTriggered SecuritySystemState = 4 // Alarm is triggered
)

const (
	securitySystemPropertyCurrentState = "currentState" // The actual current state of the security system
	securitySystemPropertyTargetState  = "targetState"  // The desired target state (set by user, transitions to currentState)
)

// SecuritySystem is a security system arm/disarm control sensor.
type SecuritySystem struct{ BaseSensor }

func NewSecuritySystem(name string) *SecuritySystem {
	s := &SecuritySystem{BaseSensor: NewBaseSensor(name)}
	s.writeState(map[string]any{
		securitySystemPropertyCurrentState: int(SecuritySystemStateDisarmed),
		securitySystemPropertyTargetState:  int(SecuritySystemStateDisarmed),
	})
	return s
}

func (s *SecuritySystem) GetType() SensorType         { return SensorTypeSecuritySystem }
func (s *SecuritySystem) GetCategory() SensorCategory { return SensorCategoryControl }
func (s *SecuritySystem) ToJSON() sensorJSON          { return s.toBaseJSON(s.GetType(), s.GetCategory()) }

func (s *SecuritySystem) GetCurrentState() SecuritySystemState {
	if v, ok := s.GetValue(securitySystemPropertyCurrentState).(int); ok {
		return SecuritySystemState(v)
	}
	return SecuritySystemStateDisarmed
}

func (s *SecuritySystem) GetTargetState() SecuritySystemState {
	if v, ok := s.GetValue(securitySystemPropertyTargetState).(int); ok {
		return SecuritySystemState(v)
	}
	return SecuritySystemStateDisarmed
}

// SetTargetState sets the target state. Writes both targetState and currentState.
//
// Example:
//
//	alarm.SetTargetState(SecuritySystemStateAwayArm)
func (s *SecuritySystem) SetTargetState(value SecuritySystemState) {
	s.writeState(map[string]any{
		securitySystemPropertyTargetState:  int(value),
		securitySystemPropertyCurrentState: int(value),
	})
}

// SetCurrentState publishes the actual security system state. Use this to
// drive transitions that diverge from the user-requested target — most notably
// the AlarmTriggered state when an intruder is detected, or arming-delay
// intermediate states. Read-only from cross-process consumers (`UpdateValue`
// ignores it).
//
// Example:
//
//	alarm.SetCurrentState(SecuritySystemStateAlarmTriggered)
func (s *SecuritySystem) SetCurrentState(value SecuritySystemState) {
	s.writeState(map[string]any{securitySystemPropertyCurrentState: int(value)})
}

// UpdateValue dispatches generic property writes to semantic methods.
func (s *SecuritySystem) UpdateValue(property string, value any) error {
	if property == securitySystemPropertyTargetState {
		if v, ok := toInt64(value); ok {
			s.SetTargetState(SecuritySystemState(v))
		}
	}
	return nil
}
