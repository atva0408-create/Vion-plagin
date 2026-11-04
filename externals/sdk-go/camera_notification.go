package sdk

// NotificationSpeed decides how long a push waits for a good picture.
type NotificationSpeed = string

const (
	NotificationSpeedImmediate NotificationSpeed = "immediate" // send right away, with a picture only if one is ready
	NotificationSpeedBalanced  NotificationSpeed = "balanced"  // wait up to 2 seconds for the best picture
	NotificationSpeedBest      NotificationSpeed = "best"      // wait up to 4 seconds for the best picture
)

// CameraNotificationSettings is the push notification configuration of a camera.
type CameraNotificationSettings struct {
	// Enabled reports whether detections on this camera send a push at all.
	Enabled bool `msgpack:"enabled" json:"enabled"`
	// Video attaches a short clip of the moment. Needs recording, uses the lowest recorded quality.
	Video bool `msgpack:"video" json:"video"`
	// Audio are the audio events that send a push. "other" covers custom audio labels.
	Audio []string `msgpack:"audio,omitempty" json:"audio,omitempty"`
	// Sensors are the sensor triggers that send a push, by sensor type.
	Sensors []string `msgpack:"sensors,omitempty" json:"sensors,omitempty"`
	// Cooldown is the minimum seconds between pushes. Critical alerts bypass it
	// and do not count toward it.
	Cooldown float64 `msgpack:"cooldown,omitempty" json:"cooldown"`
	// Speed decides how long a push waits for a good picture.
	Speed NotificationSpeed `msgpack:"speed,omitempty" json:"speed"`
}
