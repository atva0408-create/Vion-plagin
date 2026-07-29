package sdk

// LockState defines lock states (HomeKit-compatible values).
type LockState int

const (
	LockStateSecured   LockState = 0 // Locked
	LockStateUnsecured LockState = 1 // Unlocked
	LockStateUnknown   LockState = 2 // State cannot be determined, e.g. while a motorized lock is moving
)

const (
	lockPropertyCurrentState = "currentState"
	lockPropertyTargetState  = "targetState"
)

// LockControl is a lock/unlock control sensor. Override SetTargetState (by
// embedding LockControl in your own type and shadowing the method) to drive
// hardware and call the embedded LockControl's SetTargetState once the
// hardware confirms. The base implementation updates both targetState and
// currentState to the new value.
//
// For asymmetric flows (long-running unlock with intermediate state) override
// SetTargetState and write currentState separately when transitions complete.
type LockControl struct{ BaseSensor }

func NewLockControl(name string, opts ...SensorOption) *LockControl {
	s := &LockControl{BaseSensor: NewBaseSensor(name, opts...)}
	s.writeState(map[string]any{
		lockPropertyCurrentState: int(LockStateSecured),
		lockPropertyTargetState:  int(LockStateSecured),
	})
	return s
}

func (s *LockControl) GetType() SensorType         { return SensorTypeLock }
func (s *LockControl) GetCategory() SensorCategory { return SensorCategoryControl }
func (s *LockControl) ToJSON() sensorJSON          { return s.toBaseJSON(s.GetType(), s.GetCategory()) }

func (s *LockControl) GetCurrentState() LockState {
	if v, ok := s.GetValue(lockPropertyCurrentState).(int); ok {
		return LockState(v)
	}
	return LockStateSecured
}

func (s *LockControl) GetTargetState() LockState {
	if v, ok := s.GetValue(lockPropertyTargetState).(int); ok {
		return LockState(v)
	}
	return LockStateSecured
}

// SetTargetState sets the target lock state. Writes both targetState and currentState.
//
// Example:
//
//	lock.SetTargetState(LockStateSecured)
func (s *LockControl) SetTargetState(value LockState) {
	s.writeState(map[string]any{
		lockPropertyTargetState:  int(value),
		lockPropertyCurrentState: int(value),
	})
}

// SetCurrentState publishes the actual lock state. Use it when the physical
// state diverges from the requested target: motorized locks that take time to
// rotate (publish LockStateUnknown while moving), or hardware reporting an
// out-of-band state change. Read-only from cross-process consumers (UpdateValue
// ignores it).
//
// Example:
//
//	lock.SetCurrentState(LockStateUnknown)
func (s *LockControl) SetCurrentState(value LockState) {
	s.writeState(map[string]any{lockPropertyCurrentState: int(value)})
}

// UpdateValue routes generic property writes to the semantic setters.
// Only targetState is externally writable, currentState is observed-only.
func (s *LockControl) UpdateValue(property string, value any) error {
	if property == lockPropertyTargetState {
		if v, ok := toInt64(value); ok {
			s.SetTargetState(LockState(v))
		}
	}
	return nil
}
