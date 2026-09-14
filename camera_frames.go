package sdk

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

// SnapshotRefreshMode is when a camera takes a new snapshot. "interval"
// runs a timer, "onView" fetches for a viewer once the stored picture is
// older than MaxAge, "onDemand" only on an explicit request (automations,
// the refresh button, the API).
type SnapshotRefreshMode string

const (
	SnapshotRefreshInterval SnapshotRefreshMode = "interval"
	SnapshotRefreshOnView   SnapshotRefreshMode = "onView"
	SnapshotRefreshOnDemand SnapshotRefreshMode = "onDemand"
)

// SnapshotSettings is the snapshot settings for a camera.
type SnapshotSettings struct {
	// Mode is when a new picture is taken.
	Mode SnapshotRefreshMode `msgpack:"mode" json:"mode"`
	// Interval is the timer interval in seconds for "interval" mode (10 to 3600).
	Interval int `msgpack:"interval" json:"interval"`
	// MaxAge is the age in seconds after which a viewer gets a new picture in
	// "onView" mode (10 to 3600).
	MaxAge int `msgpack:"maxAge" json:"maxAge"`
}

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
	// MainStreamAnalysis analyses the main stream while something is detected,
	// instead of the detection stream.
	MainStreamAnalysis bool `msgpack:"mainStreamAnalysis,omitempty" json:"mainStreamAnalysis,omitempty"`
	// Decoder is the decoder hardware selection. Applies on the machine that
	// decodes this camera (master or assigned worker); an unusable selection
	// falls back to auto.
	Decoder *FrameWorkerDecoderSettings `msgpack:"decoder,omitempty" json:"decoder,omitempty"`
	// WorkerDecoder is the decoder hardware selection used instead of Decoder
	// while this camera decodes on its assigned worker. Falls back to Decoder
	// when nil.
	WorkerDecoder *FrameWorkerDecoderSettings `msgpack:"workerDecoder,omitempty" json:"workerDecoder,omitempty"`
}
