package sdk

// ChargingState defines battery charging states.
type ChargingState string

const (
	ChargingStateNotCharging   ChargingState = "NOT_CHARGING"   // Battery is not charging
	ChargingStateNotChargeable ChargingState = "NOT_CHARGEABLE" // Device has no rechargeable battery
	ChargingStateCharging      ChargingState = "CHARGING"       // Battery is currently charging
	ChargingStateFull          ChargingState = "FULL"           // Battery is fully charged
)

// BatteryProperty defines property names for battery info sensors.
const (
	batteryPropertyLevel    = "level"
	batteryPropertyCharging = "charging"
	batteryPropertyLow      = "low"
)

// BatteryCapability defines optional capabilities for battery info sensors.
const (
	BatteryCapabilityLowBattery = "lowBattery"
	BatteryCapabilityCharging   = "charging"
)

// BatteryInfo reports battery level, charging state, and low-battery alerts.
type BatteryInfo struct{ BaseSensor }

// NewBatteryInfo creates a new BatteryInfo.
func NewBatteryInfo(name string) *BatteryInfo {
	s := &BatteryInfo{BaseSensor: NewBaseSensor(name)}
	s.writeState(map[string]any{
		batteryPropertyLevel:    100,
		batteryPropertyCharging: string(ChargingStateNotCharging),
		batteryPropertyLow:      false,
	})
	return s
}

func (s *BatteryInfo) GetType() SensorType         { return SensorTypeBattery }
func (s *BatteryInfo) GetCategory() SensorCategory { return SensorCategoryInfo }
func (s *BatteryInfo) ToJSON() sensorJSON          { return s.toBaseJSON(s.GetType(), s.GetCategory()) }

// GetLevel returns the battery level (0–100).
func (s *BatteryInfo) GetLevel() int {
	if v, ok := s.GetValue(batteryPropertyLevel).(int); ok {
		return v
	}
	return 0
}

// GetCharging returns the charging state.
func (s *BatteryInfo) GetCharging() ChargingState {
	if v, ok := s.GetValue(batteryPropertyCharging).(string); ok {
		return ChargingState(v)
	}
	return ChargingStateNotCharging
}

// IsLow returns whether the battery is critically low.
func (s *BatteryInfo) IsLow() bool {
	v, _ := s.GetValue(batteryPropertyLow).(bool)
	return v
}

// SetLevel sets the battery level (clamped to [0,100]).
func (s *BatteryInfo) SetLevel(value int) {
	if value < 0 {
		value = 0
	}
	if value > 100 {
		value = 100
	}
	s.writeState(map[string]any{batteryPropertyLevel: value})
}

// SetCharging sets the charging state.
func (s *BatteryInfo) SetCharging(value ChargingState) {
	s.writeState(map[string]any{batteryPropertyCharging: string(value)})
}

// SetLow sets the low-battery alert flag.
func (s *BatteryInfo) SetLow(value bool) {
	s.writeState(map[string]any{batteryPropertyLow: value})
}

// UpdateValue is a no-op for read-only battery sensors.
func (s *BatteryInfo) UpdateValue(property string, value any) error {
	return nil
}
