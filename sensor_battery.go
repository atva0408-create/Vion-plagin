package sdk

// ChargingState defines battery charging states.
type ChargingState string

const (
	ChargingStateNotCharging   ChargingState = "NOT_CHARGING"   // Battery is not charging
	ChargingStateNotChargeable ChargingState = "NOT_CHARGEABLE" // Device has no rechargeable battery
	ChargingStateCharging      ChargingState = "CHARGING"       // Battery is currently charging
	ChargingStateFull          ChargingState = "FULL"           // Battery is fully charged
)

// Optional capabilities of a battery info sensor.
const (
	BatteryCapabilityLowBattery = "lowBattery" // Sensor reports low-battery alerts
	BatteryCapabilityCharging   = "charging"   // Sensor reports charging state
)

const (
	batteryPropertyLevel    = "level"
	batteryPropertyCharging = "charging"
	batteryPropertyLow      = "low"
)

// BatteryInfo reports battery level, charging state, and low-battery alerts.
//
// Plugin authors call SetLevel, SetCharging, and SetLow to push updates from
// the device.
type BatteryInfo struct{ BaseSensor }

// NewBatteryInfo creates a battery info sensor with the given name and options.
func NewBatteryInfo(name string, opts ...SensorOption) *BatteryInfo {
	s := &BatteryInfo{BaseSensor: NewBaseSensor(name, opts...)}
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

func (s *BatteryInfo) GetLevel() int {
	if v, ok := s.GetValue(batteryPropertyLevel).(int); ok {
		return v
	}
	return 0
}

func (s *BatteryInfo) GetCharging() ChargingState {
	if v, ok := s.GetValue(batteryPropertyCharging).(string); ok {
		return ChargingState(v)
	}
	return ChargingStateNotCharging
}

func (s *BatteryInfo) IsLow() bool {
	v, _ := s.GetValue(batteryPropertyLow).(bool)
	return v
}

// SetLevel reports a new battery level percentage, clamped to [0,100].
//
// Example:
//
//	battery.SetLevel(87)
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
//
// Example:
//
//	battery.SetCharging(ChargingStateCharging)
func (s *BatteryInfo) SetCharging(value ChargingState) {
	s.writeState(map[string]any{batteryPropertyCharging: string(value)})
}

// SetLow sets the low-battery alert flag.
//
// Example:
//
//	battery.SetLow(true)
func (s *BatteryInfo) SetLow(value bool) {
	s.writeState(map[string]any{batteryPropertyLow: value})
}

// UpdateValue on a read-only sensor: external writes are ignored.
func (s *BatteryInfo) UpdateValue(property string, value any) error {
	return nil
}
