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

// Point is a zone polygon coordinate as [x, y] (0-100 percentage).
type Point [2]float64

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

// DetectionEventState is the lifecycle state of a detection event.
type DetectionEventState = string

const (
	DetectionEventStateActive DetectionEventState = "active"
	DetectionEventStateEnded  DetectionEventState = "ended"
)

// EventTriggerType is the type of an event trigger.
type EventTriggerType = string

const (
	EventTriggerMotion         EventTriggerType = "motion"
	EventTriggerAudio          EventTriggerType = "audio"
	EventTriggerContact        EventTriggerType = "contact"
	EventTriggerDoorbell       EventTriggerType = "doorbell"
	EventTriggerSwitch         EventTriggerType = "switch"
	EventTriggerLight          EventTriggerType = "light"
	EventTriggerSiren          EventTriggerType = "siren"
	EventTriggerSecuritySystem EventTriggerType = "security_system"
	EventTriggerLineCrossing   EventTriggerType = "line-crossing"
)

// DetectionEventType is the lifecycle phase of a detection event message.
type DetectionEventType = string

const (
	DetectionEventStart         DetectionEventType = "start"
	DetectionEventEnd           DetectionEventType = "end"
	DetectionEventUpdate        DetectionEventType = "update"
	DetectionEventSegmentStart  DetectionEventType = "segment-start"
	DetectionEventSegmentUpdate DetectionEventType = "segment-update"
	DetectionEventSegmentEnd    DetectionEventType = "segment-end"
)
