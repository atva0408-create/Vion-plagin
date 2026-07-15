package sdk

// PTZCapability defines PTZ capabilities.
type PTZCapability string

const (
	PTZCapabilityPan              PTZCapability = "pan"
	PTZCapabilityTilt             PTZCapability = "tilt"
	PTZCapabilityZoom             PTZCapability = "zoom"
	PTZCapabilityPresets          PTZCapability = "presets"
	PTZCapabilityHome             PTZCapability = "home"
	PTZCapabilityRelativeMove     PTZCapability = "relativeMove"
	PTZCapabilityAbsolutePosition PTZCapability = "absolutePosition"
	PTZCapabilityVelocityControl  PTZCapability = "velocityControl"
)

// PTZDirection represents PTZ movement speed for continuous move commands.
//
// Speeds are in normalized range [-1, 1] where -1 is maximum speed in the
// negative direction, 0 stops movement, and 1 is maximum speed in the positive
// direction. Conventions: positive PanSpeed = right, positive TiltSpeed = up,
// positive ZoomSpeed = zoom in. Plugins should clamp values to [-1, 1] and map
// them to hardware-specific speeds.
type PTZDirection struct {
	PanSpeed  float64 `msgpack:"panSpeed" json:"panSpeed"`
	TiltSpeed float64 `msgpack:"tiltSpeed" json:"tiltSpeed"`
	ZoomSpeed float64 `msgpack:"zoomSpeed" json:"zoomSpeed"`
}

// PTZPosition represents an absolute PTZ position.
type PTZPosition struct {
	Pan  float64 `msgpack:"pan" json:"pan"`
	Tilt float64 `msgpack:"tilt" json:"tilt"`
	Zoom float64 `msgpack:"zoom" json:"zoom"`
}

// PTZRelativeMove represents a relative displacement for a single PTZ move.
//
// Deltas are normalized to the camera's field of view: PanDelta 1 moves the
// view by one full frame width, TiltDelta 1 by one full frame height.
// Conventions match PTZDirection: positive PanDelta = right, positive
// TiltDelta = up, positive ZoomDelta = zoom in. Plugins map the deltas to
// hardware-specific translation spaces (e.g. ONVIF RelativeMove).
type PTZRelativeMove struct {
	PanDelta  float64 `msgpack:"panDelta" json:"panDelta"`
	TiltDelta float64 `msgpack:"tiltDelta" json:"tiltDelta"`
	ZoomDelta float64 `msgpack:"zoomDelta" json:"zoomDelta"`
}

const (
	ptzPropertyPosition     = "position"
	ptzPropertyMoving       = "moving"
	ptzPropertyPresets      = "presets"
	ptzPropertyVelocity     = "velocity"
	ptzPropertyTargetPreset = "targetPreset"
	ptzPropertyRelativeMove = "relativeMove"
)

// PTZControl is a pan-tilt-zoom camera control sensor. Override SetPosition /
// SetVelocity / SetTargetPreset (by embedding PTZControl in your own type and
// shadowing the methods) to drive hardware, then call the corresponding
// embedded method after success to sync the SDK state. For hardware-pushed
// state updates (e.g. PTZ position change events), call the embedded methods
// directly from your event handler — that bypasses any plugin override and
// only syncs state.
//
// Set capabilities to advertise supported axes and features. Use SetPresets to
// publish the discovered preset list and SetMoving to publish movement state.
type PTZControl struct{ BaseSensor }

func NewPTZControl(name string) *PTZControl {
	s := &PTZControl{BaseSensor: NewBaseSensor(name)}
	s.writeState(map[string]any{
		ptzPropertyPosition: PTZPosition{Pan: 0, Tilt: 0, Zoom: 0},
		ptzPropertyMoving:   false,
		ptzPropertyPresets:  []string{},
	})
	return s
}

func (s *PTZControl) GetType() SensorType         { return SensorTypePTZ }
func (s *PTZControl) GetCategory() SensorCategory { return SensorCategoryControl }
func (s *PTZControl) ToJSON() sensorJSON          { return s.toBaseJSON(s.GetType(), s.GetCategory()) }

func (s *PTZControl) GetPosition() PTZPosition {
	if v, ok := s.GetValue(ptzPropertyPosition).(PTZPosition); ok {
		return v
	}
	return PTZPosition{}
}

func (s *PTZControl) IsMoving() bool {
	v, _ := s.GetValue(ptzPropertyMoving).(bool)
	return v
}

func (s *PTZControl) GetPresets() []string {
	if v, ok := s.GetValue(ptzPropertyPresets).([]string); ok {
		return v
	}
	return nil
}

// SetPosition sets the absolute PTZ position.
//
// Example:
//
//	ptz.SetPosition(PTZPosition{Pan: 0.25, Tilt: -0.1, Zoom: 0.5})
func (s *PTZControl) SetPosition(value PTZPosition) {
	s.writeState(map[string]any{ptzPropertyPosition: value})
}

// SetVelocity sets the continuous-move velocity.
//
// Example:
//
//	ptz.SetVelocity(PTZDirection{PanSpeed: 0.5, TiltSpeed: 0, ZoomSpeed: 0})
func (s *PTZControl) SetVelocity(value PTZDirection) {
	s.writeState(map[string]any{ptzPropertyVelocity: value})
}

// SetRelativeMove issues a relative displacement move. Shadow this method to
// drive hardware (e.g. ONVIF RelativeMove in a translation space) and call the
// embedded method after success to sync the SDK state. Advertise
// PTZCapabilityRelativeMove when the camera supports it.
//
// Example:
//
//	// move the view a third of a frame to the right, a tenth down
//	ptz.SetRelativeMove(PTZRelativeMove{PanDelta: 0.33, TiltDelta: -0.1, ZoomDelta: 0})
func (s *PTZControl) SetRelativeMove(value PTZRelativeMove) {
	s.writeState(map[string]any{ptzPropertyRelativeMove: value})
}

// SetTargetPreset sets the target preset ID.
//
// Example:
//
//	ptz.SetTargetPreset("Driveway")
func (s *PTZControl) SetTargetPreset(value string) {
	s.writeState(map[string]any{ptzPropertyTargetPreset: value})
}

// SetPresets publishes the discovered preset list.
//
// Example:
//
//	ptz.SetPresets([]string{"Home", "Driveway", "Backyard"})
func (s *PTZControl) SetPresets(value []string) {
	s.writeState(map[string]any{ptzPropertyPresets: value})
}

// SetMoving publishes the movement state.
//
// Example:
//
//	ptz.SetMoving(true)
func (s *PTZControl) SetMoving(value bool) {
	s.writeState(map[string]any{ptzPropertyMoving: value})
}

// GoHome moves the PTZ to the home position (0, 0, 0).
//
// Example:
//
//	ptz.GoHome()
func (s *PTZControl) GoHome() {
	s.SetPosition(PTZPosition{Pan: 0, Tilt: 0, Zoom: 0})
}

// UpdateValue dispatches generic property writes to semantic methods.
func (s *PTZControl) UpdateValue(property string, value any) error {
	switch property {
	case ptzPropertyPosition:
		if pos, ok := coercePTZPosition(value); ok {
			s.SetPosition(pos)
		}
	case ptzPropertyVelocity:
		if dir, ok := coercePTZDirection(value); ok {
			s.SetVelocity(dir)
		}
	case ptzPropertyTargetPreset:
		if str, ok := value.(string); ok {
			s.SetTargetPreset(str)
		}
	case ptzPropertyRelativeMove:
		if move, ok := coercePTZRelativeMove(value); ok {
			s.SetRelativeMove(move)
		}
	}
	return nil
}

func coercePTZPosition(value any) (PTZPosition, bool) {
	switch v := value.(type) {
	case PTZPosition:
		return v, true
	case map[string]any:
		pan, _ := toFloat64(v["pan"])
		tilt, _ := toFloat64(v["tilt"])
		zoom, _ := toFloat64(v["zoom"])
		return PTZPosition{Pan: pan, Tilt: tilt, Zoom: zoom}, true
	}
	return PTZPosition{}, false
}

func coercePTZDirection(value any) (PTZDirection, bool) {
	switch v := value.(type) {
	case PTZDirection:
		return v, true
	case map[string]any:
		pan, _ := toFloat64(v["panSpeed"])
		tilt, _ := toFloat64(v["tiltSpeed"])
		zoom, _ := toFloat64(v["zoomSpeed"])
		return PTZDirection{PanSpeed: pan, TiltSpeed: tilt, ZoomSpeed: zoom}, true
	}
	return PTZDirection{}, false
}

func coercePTZRelativeMove(value any) (PTZRelativeMove, bool) {
	switch v := value.(type) {
	case PTZRelativeMove:
		return v, true
	case map[string]any:
		pan, _ := toFloat64(v["panDelta"])
		tilt, _ := toFloat64(v["tiltDelta"])
		zoom, _ := toFloat64(v["zoomDelta"])
		return PTZRelativeMove{PanDelta: pan, TiltDelta: tilt, ZoomDelta: zoom}, true
	}
	return PTZRelativeMove{}, false
}
