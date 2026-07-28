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

// FrameWorkerDecoderHardware is the hardware backend for the detection
// decoder. "auto" probes the platform order, "cpu" forces software decoding.
type FrameWorkerDecoderHardware string

const (
	FrameWorkerDecoderAuto         FrameWorkerDecoderHardware = "auto"
	FrameWorkerDecoderCPU          FrameWorkerDecoderHardware = "cpu"
	FrameWorkerDecoderCUDA         FrameWorkerDecoderHardware = "cuda"
	FrameWorkerDecoderVAAPI        FrameWorkerDecoderHardware = "vaapi"
	FrameWorkerDecoderQSV          FrameWorkerDecoderHardware = "qsv"
	FrameWorkerDecoderVideoToolbox FrameWorkerDecoderHardware = "videotoolbox"
	FrameWorkerDecoderD3D11VA      FrameWorkerDecoderHardware = "d3d11va"
	FrameWorkerDecoderD3D12VA      FrameWorkerDecoderHardware = "d3d12va"
	FrameWorkerDecoderDXVA2        FrameWorkerDecoderHardware = "dxva2"
	FrameWorkerDecoderVulkan       FrameWorkerDecoderHardware = "vulkan"
	FrameWorkerDecoderOpenCL       FrameWorkerDecoderHardware = "opencl"
	FrameWorkerDecoderDRM          FrameWorkerDecoderHardware = "drm"
	FrameWorkerDecoderRKMPP        FrameWorkerDecoderHardware = "rkmpp"
)

// FrameWorkerDecoderSettings is the decoder hardware selection for the
// frame worker.
type FrameWorkerDecoderSettings struct {
	// Hardware is the backend to decode with.
	Hardware FrameWorkerDecoderHardware `msgpack:"hardware" json:"hardware"`
	// Device is what the backend opens (GPU index like "0", or a path like
	// /dev/dri/renderD128). Backend default when empty.
	Device string `msgpack:"device,omitempty" json:"device,omitempty"`
}

// CameraFrameWorkerSettings is frame worker (decoder) settings.
type CameraFrameWorkerSettings struct {
	// FPS is the target frames per second for detection.
	FPS int `msgpack:"fps" json:"fps"`
	// Capture event thumbnails from the highest-resolution source.
	HQSnapshots bool `msgpack:"hqSnapshots,omitempty" json:"hqSnapshots,omitempty"`
	// Decoder is the decoder hardware selection. Applies on the machine that
	// decodes this camera (master or assigned worker); an unusable selection
	// falls back to auto.
	Decoder *FrameWorkerDecoderSettings `msgpack:"decoder,omitempty" json:"decoder,omitempty"`
}
