package sdk

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
	// Preload keeps a keyframe cache for this source so the view opens faster.
	// Use HotMode to keep the stream connected.
	Preload bool `msgpack:"preload,omitempty" json:"preload,omitempty"`
	// Muted strips the audio track from this source.
	Muted bool `msgpack:"muted,omitempty" json:"muted,omitempty"`
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
	// Clip is the assigned CLIP embedding plugin.
	Clip *AssignedPlugin `msgpack:"clip,omitempty" json:"clip,omitempty"`

	// Multi-provider sensors

	// Light are the assigned light control plugins.
	Light []AssignedPlugin `msgpack:"light,omitempty" json:"light,omitempty"`
	// Siren are the assigned siren control plugins.
	Siren []AssignedPlugin `msgpack:"siren,omitempty" json:"siren,omitempty"`
	// Contact are the assigned contact sensor plugins.
	Contact []AssignedPlugin `msgpack:"contact,omitempty" json:"contact,omitempty"`
	// Doorbell are the assigned doorbell trigger plugins.
	Doorbell []AssignedPlugin `msgpack:"doorbell,omitempty" json:"doorbell,omitempty"`
	// Switch are the assigned switch control plugins.
	Switch []AssignedPlugin `msgpack:"switch,omitempty" json:"switch,omitempty"`
	// SecuritySystem are the assigned security system control plugins.
	SecuritySystem []AssignedPlugin `msgpack:"securitySystem,omitempty" json:"securitySystem,omitempty"`
	// Lock are the assigned lock control plugins.
	Lock []AssignedPlugin `msgpack:"lock,omitempty" json:"lock,omitempty"`
	// Garage are the assigned garage control plugins.
	Garage []AssignedPlugin `msgpack:"garage,omitempty" json:"garage,omitempty"`
	// Occupancy are the assigned occupancy sensor plugins.
	Occupancy []AssignedPlugin `msgpack:"occupancy,omitempty" json:"occupancy,omitempty"`
	// Smoke are the assigned smoke sensor plugins.
	Smoke []AssignedPlugin `msgpack:"smoke,omitempty" json:"smoke,omitempty"`
	// Leak are the assigned leak sensor plugins.
	Leak []AssignedPlugin `msgpack:"leak,omitempty" json:"leak,omitempty"`
	// Temperature are the assigned temperature info plugins.
	Temperature []AssignedPlugin `msgpack:"temperature,omitempty" json:"temperature,omitempty"`
	// Humidity are the assigned humidity info plugins.
	Humidity []AssignedPlugin `msgpack:"humidity,omitempty" json:"humidity,omitempty"`
	// Classifier are the assigned image classifier plugins.
	Classifier []AssignedPlugin `msgpack:"classifier,omitempty" json:"classifier,omitempty"`
	// Hub are the assigned hub/bridge plugins.
	Hub []AssignedPlugin `msgpack:"hub,omitempty" json:"hub,omitempty"`
}

// BaseCamera is the stored camera data structure (database row) without
// resolved video sources. See Camera for the resolved form.
type BaseCamera struct {
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
	// Plugins are the installed plugins for this camera.
	Plugins []AssignedPlugin `msgpack:"plugins,omitempty" json:"plugins,omitempty"`
}

// Camera is BaseCamera with its video sources resolved into streaming URLs.
type Camera struct {
	BaseCamera
	// Sources are the video input sources.
	Sources []CameraInput `msgpack:"sources,omitempty" json:"sources,omitempty"`
}

// CameraPluginInfo identifies the plugin that provides a camera (id + display name).
type CameraPluginInfo struct {
	// ID is the plugin ID.
	ID string `msgpack:"id" json:"id"`
	// Name is the plugin display name.
	Name string `msgpack:"name" json:"name"`
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

// CameraConfigInputSettings is a camera input/source definition supplied when
// creating or adopting a camera (e.g. from DiscoveryProvider.OnAdoptCamera).
// Unlike CameraInput, the URLs are raw source URLs the host resolves into
// streaming URLs.
type CameraConfigInputSettings struct {
	// Name is the source display name.
	Name string `msgpack:"name" json:"name"`
	// Role is the resolution role of this source.
	Role CameraRole `msgpack:"role" json:"role"`
	// UseForSnapshot indicates whether this source is used for snapshots.
	UseForSnapshot bool `msgpack:"useForSnapshot" json:"useForSnapshot"`
	// HotMode keeps the connection always active.
	HotMode bool `msgpack:"hotMode" json:"hotMode"`
	// Preload keeps a keyframe cache for this source so the view opens faster.
	// Use HotMode to keep the stream connected.
	Preload bool `msgpack:"preload" json:"preload"`
	// Muted strips the audio track from this source.
	Muted bool `msgpack:"muted,omitempty" json:"muted,omitempty"`
	// ChildSourceId is the child source ID (for snapshot fallback).
	ChildSourceId string `msgpack:"childSourceId,omitempty" json:"childSourceId,omitempty"`
	// Urls are the raw source URLs (resolved into streaming URLs by the host).
	Urls []string `msgpack:"urls,omitempty" json:"urls,omitempty"`
}

// BaseCameraConfig holds the camera configuration fields shared between
// creation and update operations.
type BaseCameraConfig struct {
	// Name is the camera display name.
	Name string `msgpack:"name" json:"name"`
	// NativeID is the native device ID from the source plugin.
	NativeID string `msgpack:"nativeId,omitempty" json:"nativeId,omitempty"`
	// IsCloud indicates whether the camera streams from cloud.
	IsCloud bool `msgpack:"isCloud,omitempty" json:"isCloud,omitempty"`
	// Disabled disables this camera.
	Disabled bool `msgpack:"disabled,omitempty" json:"disabled,omitempty"`
	// Info is the camera hardware information.
	Info *CameraInformation `msgpack:"info,omitempty" json:"info,omitempty"`
}

// CameraConfig is the full camera configuration with sources, supplied when
// creating or adopting a camera.
type CameraConfig struct {
	BaseCameraConfig
	// Sources are the video input sources.
	Sources []CameraConfigInputSettings `msgpack:"sources" json:"sources"`
}
