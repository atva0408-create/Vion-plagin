package sdk

// LockState defines lock states (HomeKit-compatible values).
type LockState int

const (
	LockStateSecured   LockState = 0 // Lock is secured (locked)
	LockStateUnsecured LockState = 1 // Lock is unsecured (unlocked)
	LockStateUnknown   LockState = 2 // Lock state is unknown
)

// LockProperty defines property names for lock controls.
const (
	lockPropertyCurrentState = "currentState"
	lockPropertyTargetState  = "targetState"
)

// LockControl is a lock/unlock control sensor.
type LockControl struct{ BaseSensor }

// NewLockControl creates a new LockControl.
func NewLockControl(name string) *LockControl {
	s := &LockControl{BaseSensor: NewBaseSensor(name)}
	s.writeState(map[string]any{
		lockPropertyCurrentState: int(LockStateSecured),
		lockPropertyTargetState:  int(LockStateSecured),
	})
	return s
}

func (s *LockControl) GetType() SensorType         { return SensorTypeLock }
func (s *LockControl) GetCategory() SensorCategory { return SensorCategoryControl }
func (s *LockControl) ToJSON() sensorJSON          { return s.toBaseJSON(s.GetType(), s.GetCategory()) }

// GetCurrentState returns the current lock state.
func (s *LockControl) GetCurrentState() LockState {
	if v, ok := s.GetValue(lockPropertyCurrentState).(int); ok {
		return LockState(v)
	}
	return LockStateSecured
}

// GetTargetState returns the target lock state.
func (s *LockControl) GetTargetState() LockState {
	if v, ok := s.GetValue(lockPropertyTargetState).(int); ok {
		return LockState(v)
	}
	return LockStateSecured
}

// SetTargetState sets the target lock state. Writes both targetState and currentState.
func (s *LockControl) SetTargetState(value LockState) {
	s.writeState(map[string]any{
		lockPropertyTargetState:  int(value),
		lockPropertyCurrentState: int(value),
	})
}

// SetCurrentState publishes the actual lock state. Use this to drive
// transitions where the physical state diverges from the user-requested
// target — e.g. motorized smart locks that take time to rotate (publish
// LockStateUnknown while moving), or hardware reporting an out-of-band state
// change. Read-only from cross-process consumers (`UpdateValue` ignores it).
func (s *LockControl) SetCurrentState(value LockState) {
	s.writeState(map[string]any{lockPropertyCurrentState: int(value)})
}

// UpdateValue dispatches generic property writes to semantic methods.
// Numeric values arriving via msgpack may be any int/uint/float width — the
// `toInt64` helper normalizes them so the LockState cast is consistent.
func (s *LockControl) UpdateValue(property string, value any) error {
	if property == lockPropertyTargetState {
		if v, ok := toInt64(value); ok {
			s.SetTargetState(LockState(v))
		}
	}
	return nil
}
