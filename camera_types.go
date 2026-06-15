package sdk

// CameraType is the camera device type.
//   - camera: Standard surveillance camera
//   - doorbell: Doorbell camera
type CameraType string

const (
	CameraTypeCamera   CameraType = "camera"
	CameraTypeDoorbell CameraType = "doorbell"
)

// CameraRole identifies the resolution tier of a camera source.
// Used to identify different quality streams from the same camera.
type CameraRole string

const (
	CameraRoleHighRes  CameraRole = "high-resolution"
	CameraRoleMidRes   CameraRole = "mid-resolution"
	CameraRoleLowRes   CameraRole = "low-resolution"
	CameraRoleSnapshot CameraRole = "snapshot"
)

// StreamingRole is the resolution role for live streaming (excludes snapshot).
type StreamingRole string

const (
	StreamingRoleHighRes StreamingRole = "high-resolution"
	StreamingRoleMidRes  StreamingRole = "mid-resolution"
	StreamingRoleLowRes  StreamingRole = "low-resolution"
)

// VideoStreamingMode is the video streaming mode for UI playback.
//   - auto: Automatically select best method
//   - webrtc: WebRTC with UDP (lowest latency)
//   - webrtc/tcp: WebRTC with TCP fallback
//   - mse: Media Source Extensions (browser native)
type VideoStreamingMode string

const (
	VideoStreamingModeAuto      VideoStreamingMode = "auto"
	VideoStreamingModeWebRTC    VideoStreamingMode = "webrtc"
	VideoStreamingModeMSE       VideoStreamingMode = "mse"
	VideoStreamingModeWebRTCTCP VideoStreamingMode = "webrtc/tcp"
)

// CameraAspectRatio is the camera aspect ratio for UI display.
type CameraAspectRatio string

const (
	CameraAspectRatio16x9 CameraAspectRatio = "16:9"
	CameraAspectRatio9x16 CameraAspectRatio = "9:16"
	CameraAspectRatio8x3  CameraAspectRatio = "8:3"
	CameraAspectRatio4x3  CameraAspectRatio = "4:3"
	CameraAspectRatioAuto CameraAspectRatio = "1:1"
)

// MotionResolution is the motion detection resolution setting.
// Higher resolution = more accurate but slower.
type MotionResolution string

const (
	MotionResolutionLow    MotionResolution = "low"
	MotionResolutionMedium MotionResolution = "medium"
	MotionResolutionHigh   MotionResolution = "high"
)

// ZoneType is the detection zone intersection type.
//   - intersect: Trigger when object touches the zone boundary
//   - contain: Trigger only when object is fully inside the zone
type ZoneType string

const (
	ZoneTypeIntersect ZoneType = "intersect"
	ZoneTypeContain   ZoneType = "contain"
)

// ZoneFilter is the detection zone filter mode.
//   - include: Only consider detections inside this zone
//   - exclude: Only consider detections outside this zone
type ZoneFilter string

const (
	ZoneFilterInclude ZoneFilter = "include"
	ZoneFilterExclude ZoneFilter = "exclude"
)

// StreamDirection is the direction of a media stream (from SDP).
type StreamDirection string

const (
	StreamDirectionSendOnly StreamDirection = "sendonly"
	StreamDirectionRecvOnly StreamDirection = "recvonly"
	StreamDirectionSendRecv StreamDirection = "sendrecv"
	StreamDirectionInactive StreamDirection = "inactive"
)

// RTSPAudioCodec is an audio codec supported for RTSP streaming.
type RTSPAudioCodec string

const (
	RTSPAudioCodecAAC  RTSPAudioCodec = "aac"
	RTSPAudioCodecOpus RTSPAudioCodec = "opus"
	RTSPAudioCodecPCMA RTSPAudioCodec = "pcma"
)

// Go2RtcWSSource contains WebSocket streaming URLs from the stream provider.
type Go2RtcWSSource struct {
	// WebRTC is the WebRTC signaling endpoint.
	WebRTC string `msgpack:"webrtc,omitempty" json:"webrtc,omitempty"`
	// MSE is the MSE streaming endpoint.
	MSE string `msgpack:"mse,omitempty" json:"mse,omitempty"`
}

// Go2RtcRTSPSource contains RTSP streaming URLs from the stream provider.
type Go2RtcRTSPSource struct {
	// Base is the base RTSP URL.
	Base string `msgpack:"base,omitempty" json:"base,omitempty"`
	// Default is the default stream (video + audio).
	Default string `msgpack:"default,omitempty" json:"default,omitempty"`
	// Muted is the video-only stream.
	Muted string `msgpack:"muted,omitempty" json:"muted,omitempty"`
	// AudioOnly is the audio-only stream (no video).
	AudioOnly string `msgpack:"audioOnly,omitempty" json:"audioOnly,omitempty"`
	// AAC is the stream URL with AAC audio.
	AAC string `msgpack:"aac,omitempty" json:"aac,omitempty"`
	// Opus is the stream URL with Opus audio.
	Opus string `msgpack:"opus,omitempty" json:"opus,omitempty"`
	// PCMA is the stream URL with PCMA audio.
	PCMA string `msgpack:"pcma,omitempty" json:"pcma,omitempty"`
	// ONVIF is the ONVIF URL.
	ONVIF string `msgpack:"onvif,omitempty" json:"onvif,omitempty"`
	// Prebuffered is the prebuffered stream URL.
	Prebuffered string `msgpack:"prebuffered,omitempty" json:"prebuffered,omitempty"`
	// NoGop is the stream URL with GOP cache disabled.
	NoGop string `msgpack:"noGop,omitempty" json:"noGop,omitempty"`
}

// Go2RtcSnapshotSource contains snapshot/image URLs from the stream provider.
type Go2RtcSnapshotSource struct {
	// MP4 is the MP4 single-frame video URL.
	MP4 string `msgpack:"mp4,omitempty" json:"mp4,omitempty"`
	// JPEG is the JPEG snapshot URL.
	JPEG string `msgpack:"jpeg,omitempty" json:"jpeg,omitempty"`
	// MJPEG is the MJPEG stream URL.
	MJPEG string `msgpack:"mjpeg,omitempty" json:"mjpeg,omitempty"`
}

// StreamUrls is the collection of all streaming URLs for a camera source.
type StreamUrls struct {
	// WS are the WebSocket streaming URLs.
	WS Go2RtcWSSource `msgpack:"ws,omitempty" json:"ws"`
	// RTSP are the RTSP streaming URLs.
	RTSP Go2RtcRTSPSource `msgpack:"rtsp,omitempty" json:"rtsp"`
	// Snapshot are the snapshot/image URLs.
	Snapshot Go2RtcSnapshotSource `msgpack:"snapshot,omitempty" json:"snapshot"`
}

// RTSPUrlOptions is options for generating RTSP URLs.
type RTSPUrlOptions struct {
	// Video toggles inclusion of the video track.
	Video bool `msgpack:"video,omitempty" json:"video"`
	// Audio is the list of audio codecs to include.
	Audio []RTSPAudioCodec `msgpack:"audio,omitempty" json:"audio"`
	// GOP requests a keyframe at start.
	GOP bool `msgpack:"gop,omitempty" json:"gop"`
	// Prebuffer requests the prebuffered stream.
	Prebuffer bool `msgpack:"prebuffer,omitempty" json:"prebuffer"`
	// AudioSingleTrack combines audio tracks into a single track.
	AudioSingleTrack bool `msgpack:"audioSingleTrack,omitempty" json:"audioSingleTrack"`
	// Backchannel enables backchannel (two-way audio).
	Backchannel bool `msgpack:"backchannel,omitempty" json:"backchannel"`
	// Timeout is the connection timeout in seconds.
	Timeout int `msgpack:"timeout,omitempty" json:"timeout"`
}

// SnapshotUrlOptions is options for generating snapshot URLs.
type SnapshotUrlOptions struct {
	// Width is the output width in pixels.
	Width int `msgpack:"width,omitempty" json:"width"`
	// Height is the output height in pixels.
	Height int `msgpack:"height,omitempty" json:"height"`
	// Rotate is the rotation in degrees.
	Rotate int `msgpack:"rotate,omitempty" json:"rotate"`
	// Cache is the cache key/strategy.
	Cache string `msgpack:"cache,omitempty" json:"cache"`
	// HW is the hardware acceleration backend.
	HW string `msgpack:"hw,omitempty" json:"hw"`
	// GOP requests a keyframe at start.
	GOP bool `msgpack:"gop,omitempty" json:"gop"`
	// Prebuffer requests the prebuffered stream.
	Prebuffer bool `msgpack:"prebuffer,omitempty" json:"prebuffer"`
}

// CameraInput is a camera video input/source with resolved URLs.
type CameraInput struct {
	// ID is the unique source ID.
	ID string `msgpack:"_id" json:"_id"`
	// Name is the source display name.
	Name string `msgpack:"name,omitempty" json:"name,omitempty"`
	// Role is the resolution role of this source.
	Role CameraRole `msgpack:"role,omitempty" json:"role,omitempty"`
	// UseForSnapshot indicates whether this source is used for snapshots.
	UseForSnapshot bool `msgpack:"useForSnapshot,omitempty" json:"useForSnapshot,omitempty"`
	// HotMode keeps the connection always active.
	HotMode bool `msgpack:"hotMode,omitempty" json:"hotMode,omitempty"`
	// Preload toggles stream preloading on startup.
	Preload bool `msgpack:"preload,omitempty" json:"preload,omitempty"`
	// Prebuffer enables stream prebuffering.
	Prebuffer bool `msgpack:"prebuffer,omitempty" json:"prebuffer,omitempty"`
	// Urls are the generated streaming URLs.
	Urls StreamUrls `msgpack:"urls,omitempty" json:"urls"`
	// ChildSourceId is the child source ID (for snapshot fallback).
	ChildSourceId string `msgpack:"childSourceId,omitempty" json:"childSourceId,omitempty"`
}

// CameraInformation is camera hardware/firmware information.
type CameraInformation struct {
	// Manufacturer is the manufacturer name.
	Manufacturer string `msgpack:"manufacturer,omitempty" json:"manufacturer,omitempty"`
	// Model is the camera model name.
	Model string `msgpack:"model,omitempty" json:"model,omitempty"`
	// Hardware is the hardware version/revision.
	Hardware string `msgpack:"hardware,omitempty" json:"hardware,omitempty"`
	// SerialNumber is the device serial number.
	SerialNumber string `msgpack:"serialNumber,omitempty" json:"serialNumber,omitempty"`
	// FirmwareVersion is the current firmware version.
	FirmwareVersion string `msgpack:"firmwareVersion,omitempty" json:"firmwareVersion,omitempty"`
	// SupportUrl is the manufacturer support URL.
	SupportUrl string `msgpack:"supportUrl,omitempty" json:"supportUrl,omitempty"`
}

// AssignedPlugin is plugin assignment info (id + display name).
type AssignedPlugin struct {
	// ID is the plugin ID.
	ID string `msgpack:"id" json:"id"`
	// Name is the plugin display name.
	Name string `msgpack:"name" json:"name"`
}

// PluginAssignments maps sensor types to their assigned plugin(s) for a camera.
// Single-provider sensor types use *AssignedPlugin (nil when unassigned).
// Multi-provider sensor types use []AssignedPlugin.
type PluginAssignments struct {
	// Single-provider sensors

	// Motion is the assigned motion detection plugin.
	Motion *AssignedPlugin `msgpack:"motion,omitempty" json:"motion,omitempty"`
	// Object is the assigned object detection plugin.
	Object *AssignedPlugin `msgpack:"object,omitempty" json:"object,omitempty"`
	// Audio is the assigned audio detection plugin.
	Audio *AssignedPlugin `msgpack:"audio,omitempty" json:"audio,omitempty"`
	// Face is the assigned face detection plugin.
	Face *AssignedPlugin `msgpack:"face,omitempty" json:"face,omitempty"`
	// LicensePlate is the assigned license plate detection plugin.
	LicensePlate *AssignedPlugin `msgpack:"licensePlate,omitempty" json:"licensePlate,omitempty"`
	// PTZ is the assigned PTZ control plugin.
	PTZ *AssignedPlugin `msgpack:"ptz,omitempty" json:"ptz,omitempty"`
	// Battery is the assigned battery info plugin.
	Battery *AssignedPlugin `msgpack:"battery,omitempty" json:"battery,omitempty"`
	// CameraController is the assigned camera controller plugin.
	CameraController *AssignedPlugin `msgpack:"cameraController,omitempty" json:"cameraController,omitempty"`

	// Multi-provider sensors

	// Light are the assigned light control plugins.
	Light []AssignedPlugin `msgpack:"light,omitempty" json:"light,omitempty"`
	// Siren are the assigned siren control plugins.
	Siren []AssignedPlugin `msgpack:"siren,omitempty" json:"siren,omitempty"`
	// Contact are the assigned contact sensor plugins.
	Contact []AssignedPlugin `msgpack:"contact,omitempty" json:"contact,omitempty"`
	// Doorbell are the assigned doorbell trigger plugins.
	Doorbell []AssignedPlugin `msgpack:"doorbell,omitempty" json:"doorbell,omitempty"`
	// Hub are the assigned hub/bridge plugins.
	Hub []AssignedPlugin `msgpack:"hub,omitempty" json:"hub,omitempty"`
}

// Camera is the raw camera data structure delivered from the server (database row + resolved sources).
type Camera struct {
	// ID is the unique camera ID.
	ID string `msgpack:"_id" json:"_id"`
	// Name is the camera display name.
	Name string `msgpack:"name" json:"name"`
	// Room is the room this camera belongs to.
	Room string `msgpack:"room" json:"room"`
	// NativeID is the native device ID from the source plugin.
	NativeID string `msgpack:"nativeId,omitempty" json:"nativeId,omitempty"`
	// PluginInfo identifies the source plugin.
	PluginInfo *CameraPluginInfo `msgpack:"pluginInfo,omitempty" json:"pluginInfo,omitempty"`
	// Type is the camera type (camera/doorbell).
	Type CameraType `msgpack:"type,omitempty" json:"type,omitempty"`
	// Disabled indicates whether the camera is disabled.
	Disabled bool `msgpack:"disabled,omitempty" json:"disabled,omitempty"`
	// IsCloud indicates whether the camera streams from cloud.
	IsCloud bool `msgpack:"isCloud,omitempty" json:"isCloud,omitempty"`
	// Info is the camera hardware information.
	Info CameraInformation `msgpack:"info,omitempty" json:"info"`
	// Sources are the video input sources.
	Sources []CameraInput `msgpack:"sources,omitempty" json:"sources,omitempty"`
	// Assignments are sensor-to-plugin assignments.
	Assignments PluginAssignments `msgpack:"assignments,omitempty" json:"assignments"`
	// SnapshotSettings are the snapshot settings.
	SnapshotSettings SnapshotSettings `msgpack:"snapshotSettings,omitempty" json:"snapshotSettings"`
	// DetectionZones are the detection zone configurations.
	DetectionZones []DetectionZone `msgpack:"detectionZones,omitempty" json:"detectionZones,omitempty"`
	// DetectionLines are the detection line configurations (virtual tripwires).
	DetectionLines []DetectionLine `msgpack:"detectionLines,omitempty" json:"detectionLines,omitempty"`
	// DetectionSettings are the detection settings.
	DetectionSettings CameraDetectionSettings `msgpack:"detectionSettings,omitempty" json:"detectionSettings"`
	// PtzAutotrack is the PTZ autotracking configuration.
	PtzAutotrack PtzAutotrackSettings `msgpack:"ptzAutotrack,omitempty" json:"ptzAutotrack"`
	// FrameWorkerSettings is the frame worker configuration.
	FrameWorkerSettings CameraFrameWorkerSettings `msgpack:"frameWorkerSettings,omitempty" json:"frameWorkerSettings"`
	// InterfaceSettings is the UI display settings.
	InterfaceSettings CameraUiSettings `msgpack:"interfaceSettings,omitempty" json:"interfaceSettings"`
	// Interface is a server-side alias for InterfaceSettings (kept for compatibility).
	Interface CameraUiSettings `msgpack:"interface,omitempty" json:"interface"`
	// Plugins are the installed plugins for this camera.
	Plugins []AssignedPlugin `msgpack:"plugins,omitempty" json:"plugins,omitempty"`
}

// CameraPluginInfo identifies the plugin that provides a camera (id + display name).
type CameraPluginInfo struct {
	// ID is the plugin ID.
	ID string `msgpack:"id" json:"id"`
	// Name is the plugin display name.
	Name string `msgpack:"name" json:"name"`
}

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

// CameraUiSettings is UI display settings for a camera.
type CameraUiSettings struct {
	// StreamingMode is the preferred streaming method.
	StreamingMode VideoStreamingMode `msgpack:"streamingMode" json:"streamingMode"`
	// StreamingSource is the preferred stream quality (StreamingRole).
	StreamingSource string `msgpack:"streamingSource" json:"streamingSource"`
	// AspectRatio is the display aspect ratio.
	AspectRatio CameraAspectRatio `msgpack:"aspectRatio" json:"aspectRatio"`
}

// Point is a zone polygon coordinate as [x, y] (0-100 percentage).
type Point [2]float64

// DetectionZone is a polygon zone used for detection filtering or privacy masking.
type DetectionZone struct {
	// Name is the zone display name.
	Name string `msgpack:"name" json:"name"`
	// Points are the polygon points (0-100 percentage coordinates).
	Points []Point `msgpack:"points" json:"points"`
	// Type is the intersection detection type.
	Type ZoneType `msgpack:"type" json:"type"`
	// Filter is the include/exclude filter mode.
	Filter ZoneFilter `msgpack:"filter" json:"filter"`
	// Labels are the labels to filter (empty = all labels).
	Labels []DetectionLabel `msgpack:"labels" json:"labels"`
	// IsPrivacyMask indicates whether this is a privacy mask (blur/block area).
	IsPrivacyMask bool `msgpack:"isPrivacyMask" json:"isPrivacyMask"`
	// Color is the zone display color (hex).
	Color string `msgpack:"color" json:"color"`
}

// LineDirection is the line crossing direction filter.
//   - both: Trigger on crossings in either direction
//   - a-to-b: Trigger only when crossing from A side to B side
//   - b-to-a: Trigger only when crossing from B side to A side
type LineDirection = string

const (
	LineDirectionBoth LineDirection = "both"
	LineDirectionAToB LineDirection = "a-to-b"
	LineDirectionBToA LineDirection = "b-to-a"
)

// DetectionLine is a virtual tripwire for line crossing detection.
// The two points define grab-handle positions; the actual crossing line
// is perpendicular through their midpoint.
type DetectionLine struct {
	// Name is the line display name.
	Name string `msgpack:"name" json:"name"`
	// Points are the grab-handle positions (0-100%). The crossing line is perpendicular through the midpoint.
	Points [2]Point `msgpack:"points" json:"points"`
	// Direction controls which crossing direction(s) trigger events.
	Direction LineDirection `msgpack:"direction" json:"direction"`
	// Labels are the labels to filter (empty = all labels).
	Labels []DetectionLabel `msgpack:"labels" json:"labels"`
	// Color is the line display color (hex).
	Color string `msgpack:"color" json:"color"`
}

// StreamProperties contains codec properties from a stream probe.
type StreamProperties struct {
	// ClockRate is the codec clock rate.
	ClockRate int `msgpack:"clockRate,omitempty" json:"clockRate,omitempty"`
	// PayloadType is the RTP payload type number.
	PayloadType int `msgpack:"payloadType,omitempty" json:"payloadType,omitempty"`
	// FmtpInfo is the codec-specific fmtp configuration string.
	FmtpInfo string `msgpack:"fmtpInfo,omitempty" json:"fmtpInfo,omitempty"`
}

// ProbeStream is the result of a stream probe — SDP plus track information.
type ProbeStream struct {
	Video []VideoStreamInfo `msgpack:"video,omitempty" json:"video,omitempty"`
	Audio []AudioStreamInfo `msgpack:"audio,omitempty" json:"audio,omitempty"`
	SDP   string            `msgpack:"sdp,omitempty" json:"sdp,omitempty"`
}

// VideoStreamInfo is video stream information from a probe.
type VideoStreamInfo struct {
	// Codec is the video codec.
	Codec string `msgpack:"codec,omitempty" json:"codec,omitempty"`
	// FFmpegCodec is the FFmpeg codec name.
	FFmpegCodec string `msgpack:"ffmpegCodec,omitempty" json:"ffmpegCodec,omitempty"`
	// Width is the video width in pixels.
	Width int `msgpack:"width,omitempty" json:"width,omitempty"`
	// Height is the video height in pixels.
	Height int `msgpack:"height,omitempty" json:"height,omitempty"`
	// FPS is the framerate.
	FPS int `msgpack:"fps,omitempty" json:"fps,omitempty"`
	// Bitrate is the video bitrate.
	Bitrate int `msgpack:"bitrate,omitempty" json:"bitrate,omitempty"`
	// Properties are the codec properties.
	Properties StreamProperties `msgpack:"properties,omitempty" json:"properties"`
	// Direction is the stream direction.
	Direction StreamDirection `msgpack:"direction,omitempty" json:"direction,omitempty"`
}

// AudioStreamInfo is audio stream information from a probe.
type AudioStreamInfo struct {
	// Codec is the audio codec.
	Codec string `msgpack:"codec,omitempty" json:"codec,omitempty"`
	// FFmpegCodec is the FFmpeg codec name.
	FFmpegCodec string `msgpack:"ffmpegCodec,omitempty" json:"ffmpegCodec,omitempty"`
	// SampleRate is the audio sample rate in Hz.
	SampleRate int `msgpack:"sampleRate,omitempty" json:"sampleRate,omitempty"`
	// Channels is the number of audio channels.
	Channels int `msgpack:"channels,omitempty" json:"channels,omitempty"`
	// Properties are the codec properties.
	Properties StreamProperties `msgpack:"properties,omitempty" json:"properties"`
	// Direction is the stream direction.
	Direction StreamDirection `msgpack:"direction,omitempty" json:"direction,omitempty"`
}

// MotionDetectionSettings is motion detection configuration.
type MotionDetectionSettings struct {
	// Resolution is the detection resolution quality.
	Resolution MotionResolution `msgpack:"resolution" json:"resolution"`
	// Timeout is the motion dwell time in seconds.
	Timeout int `msgpack:"timeout" json:"timeout"`
}

// ObjectDetectionSettings is object detection configuration.
type ObjectDetectionSettings struct {
	// Confidence is the minimum confidence threshold (0-1).
	Confidence float64 `msgpack:"confidence" json:"confidence"`
}

// AudioDetectionSettings is audio detection configuration.
type AudioDetectionSettings struct {
	// MinDecibels is the minimum volume threshold in dBFS (-100 to 0). Audio below this level is skipped.
	MinDecibels float64 `msgpack:"minDecibels" json:"minDecibels"`
	// Timeout is the audio dwell time in seconds.
	Timeout int `msgpack:"timeout" json:"timeout"`
}

// SensorTriggerRef is a stable reference to a sensor for cascade trigger configuration.
// Uses composite key (sensorType + sensorName + pluginId) instead of UUID
// so references survive plugin restarts.
type SensorTriggerRef struct {
	// SensorType is the sensor type (e.g. "contact", "doorbell").
	SensorType SensorType `msgpack:"sensorType" json:"sensorType"`
	// SensorName is the sensor name (stable across restarts).
	SensorName string `msgpack:"sensorName" json:"sensorName"`
	// PluginID is the plugin ID that provides this sensor.
	PluginID string `msgpack:"pluginId" json:"pluginId"`
}

// SensorTriggerSettings is configuration for sensor cascade triggers (contact, doorbell, switch, light, etc.).
type SensorTriggerSettings struct {
	// Timeout is the sensor trigger timeout in seconds.
	Timeout int `msgpack:"timeout" json:"timeout"`
	// Triggers are sensors that also trigger the detection cascade (in addition to motion/audio).
	Triggers []SensorTriggerRef `msgpack:"triggers" json:"triggers"`
}

// CameraDetectionSettings is the combined detection settings for a camera.
type CameraDetectionSettings struct {
	Motion MotionDetectionSettings `msgpack:"motion" json:"motion"`
	Object ObjectDetectionSettings `msgpack:"object" json:"object"`
	Audio  AudioDetectionSettings  `msgpack:"audio" json:"audio"`
	Sensor SensorTriggerSettings   `msgpack:"sensor" json:"sensor"`
	// CascadeDetection enables the detection cascade.
	CascadeDetection *bool `msgpack:"cascadeDetection,omitempty" json:"cascadeDetection,omitempty"`
	// CascadeTimeout is the cascade hold-open window in seconds.
	CascadeTimeout int `msgpack:"cascadeTimeout,omitempty" json:"cascadeTimeout,omitempty"`
	// Snooze indicates whether detections are snoozed (paused).
	Snooze bool `msgpack:"snooze,omitempty" json:"snooze,omitempty"`
}

// PtzAutotrackSettings configures automatic PTZ tracking of detected objects.
type PtzAutotrackSettings struct {
	// Enabled toggles PTZ autotracking.
	Enabled bool `msgpack:"enabled" json:"enabled"`
	// TargetLabels are the object labels to track (e.g. "person", "vehicle").
	TargetLabels []string `msgpack:"targetLabels" json:"targetLabels"`
	// MinConfidence is the minimum detection confidence to track (0.3 - 1.0).
	MinConfidence float64 `msgpack:"minConfidence" json:"minConfidence"`
	// TriggerDeadZone is the dead zone around frame center (0 - 0.3).
	// No motor command is issued while the target is inside this zone.
	TriggerDeadZone float64 `msgpack:"triggerDeadZone" json:"triggerDeadZone"`
	// ReturnToHome enables returning to the home position when no target is found for HomeWaitMs.
	ReturnToHome bool `msgpack:"returnToHome" json:"returnToHome"`
	// HomeWaitMs is how long to wait (ms) without a target before returning home.
	HomeWaitMs int `msgpack:"homeWaitMs" json:"homeWaitMs"`
}

// DiscoveredCamera is a camera found during discovery by a discovery provider plugin.
type DiscoveredCamera struct {
	// ID is the discovery ID (typically a stable native identifier).
	ID string `msgpack:"id" json:"id"`
	// Name is the discovered camera display name.
	Name string `msgpack:"name" json:"name"`
	// Manufacturer is the manufacturer name (if known).
	Manufacturer string `msgpack:"manufacturer,omitempty" json:"manufacturer,omitempty"`
	// Model is the model name (if known).
	Model string `msgpack:"model,omitempty" json:"model,omitempty"`
}
