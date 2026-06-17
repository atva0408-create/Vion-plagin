package sdk

// SnapshotSettings is snapshot configuration for a camera.
type SnapshotSettings struct {
	// AutoRefresh enables automatic snapshot refresh.
	AutoRefresh bool `msgpack:"autoRefresh" json:"autoRefresh"`
	// TTL is the cache TTL in seconds (how long a snapshot is valid).
	TTL int `msgpack:"ttl" json:"ttl"`
	// Interval is the auto-refresh interval in seconds (min: 10, max: 60).
	Interval int `msgpack:"interval" json:"interval"`
}

// CameraFrameWorkerSettings is frame worker (decoder) settings.
type CameraFrameWorkerSettings struct {
	// FPS is the target frames per second for detection.
	FPS int `msgpack:"fps" json:"fps"`
}
