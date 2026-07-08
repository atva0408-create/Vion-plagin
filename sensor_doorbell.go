package sdk

import "time"

const (
	doorbellPropertyRing = "ring"
)

const ringAutoResetMs = 2000

// DoorbellTrigger triggers doorbell ring events.
type DoorbellTrigger struct {
	BaseSensor
	ringResetTimer *time.Timer
}

func NewDoorbellTrigger(name string) *DoorbellTrigger {
	s := &DoorbellTrigger{BaseSensor: NewBaseSensor(name)}
	s.writeState(map[string]any{doorbellPropertyRing: false})
	return s
}

func (s *DoorbellTrigger) GetType() SensorType         { return SensorTypeDoorbell }
func (s *DoorbellTrigger) GetCategory() SensorCategory { return SensorCategoryTrigger }
func (s *DoorbellTrigger) ToJSON() sensorJSON          { return s.toBaseJSON(s.GetType(), s.GetCategory()) }

func (s *DoorbellTrigger) IsRinging() bool {
	v, _ := s.GetValue(doorbellPropertyRing).(bool)
	return v
}

// Trigger fires a doorbell ring event. Sets `ring=true` and auto-resets after
// ringAutoResetMs. Re-triggering while ringing resets the timer (extends the
// ring phase).
//
// Example:
//
//	doorbell.Trigger()
func (s *DoorbellTrigger) Trigger() {
	s.mu.Lock()
	if s.ringResetTimer != nil {
		s.ringResetTimer.Stop()
		s.ringResetTimer = nil
	}
	s.mu.Unlock()

	s.writeState(map[string]any{doorbellPropertyRing: true})

	timer := time.AfterFunc(time.Duration(ringAutoResetMs)*time.Millisecond, func() {
		s.mu.Lock()
		s.ringResetTimer = nil
		s.mu.Unlock()
		s.writeState(map[string]any{doorbellPropertyRing: false})
	})

	s.mu.Lock()
	s.ringResetTimer = timer
	s.mu.Unlock()
}

// UpdateValue is the cross-process consumer entry point. Writing `ring=true`
// (any truthy value) dispatches to `Trigger()` so a UI test button or external
// automation can fire the doorbell using the same flow as a real hardware
// ring (auto-reset included). Writing `ring=false` is ignored — the
// auto-reset timer owns the off transition.
func (s *DoorbellTrigger) UpdateValue(property string, value any) error {
	if property != doorbellPropertyRing {
		return nil
	}
	truthy := false
	if b, ok := value.(bool); ok {
		truthy = b
	} else if v, ok := toInt64(value); ok {
		truthy = v != 0
	}
	if truthy {
		s.Trigger()
	}
	return nil
}
