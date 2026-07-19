# Camera

Camera entities and runtime device API: `CameraDevice` (the per-camera handle your plugin receives in `ConfigureCameras`), camera sources, snapshots, streaming URL helpers, video frame data, detection events, and the property-change observables.

!!! note
    The reference below is auto-generated from Go doc comments via [`gomarkdoc`](https://github.com/princjef/gomarkdoc). Re-run `scripts/gen-api-docs.sh` to refresh it.

## func BuildSnapshotUrl

	func BuildSnapshotUrl(cameraName, sourceName, snapshotUrl string, opts *SnapshotUrlOptions) (string, error)

BuildSnapshotUrl constructs a go2rtc\-compatible snapshot URL for the given camera/source pair. Optional dimensions, rotation, cache and hardware transcode flags are appended as query parameters.

<a name="BuildTargetUrl"></a>

## func BuildTargetUrl

	func BuildTargetUrl(rtspUrl string, opts *RTSPUrlOptions) (string, error)

BuildTargetUrl constructs a go2rtc\-compatible RTSP target URL from a base RTSP URL and a set of stream selection options \(video/audio tracks, GOP, timeout\). Returns the URL with all selected query parameters.

<a name="CanCreateCameras"></a>

## type AudioCodec

AudioCodec is a supported audio codec \(RTP/SDP format name\).

	type AudioCodec string

<a name="AudioCodecPCMU"></a>

	const (
	    AudioCodecPCMU         AudioCodec = "PCMU"
	    AudioCodecPCMA         AudioCodec = "PCMA"
	    AudioCodecMPEG4Generic AudioCodec = "MPEG4-GENERIC"
	    AudioCodecOpus         AudioCodec = "opus"
	    AudioCodecG722         AudioCodec = "G722"
	    AudioCodecG726         AudioCodec = "G726"
	    AudioCodecMPA          AudioCodec = "MPA"
	    AudioCodecPCM          AudioCodec = "PCM"
	    AudioCodecFLAC         AudioCodec = "FLAC"
	    AudioCodecELD          AudioCodec = "ELD"
	    AudioCodecPCML         AudioCodec = "PCML"
	    AudioCodecL16          AudioCodec = "L16"
	)

<a name="AudioCodecProperties"></a>

## type AudioCodecProperties

AudioCodecProperties holds audio codec properties from a stream probe.

	type AudioCodecProperties struct {
	    // SampleRate is the audio sample rate in Hz.
	    SampleRate int `msgpack:"sampleRate" json:"sampleRate"`
	    // Channels is the number of audio channels.
	    Channels int `msgpack:"channels" json:"channels"`
	    // PayloadType is the RTP payload type number.
	    PayloadType int `msgpack:"payloadType" json:"payloadType"`
	    // FmtpInfo holds optional format parameters.
	    FmtpInfo *FMTPInfo `msgpack:"fmtpInfo,omitempty" json:"fmtpInfo,omitempty"`
	}

<a name="AudioDetectionInterface"></a>

## type AudioFFmpegCodec

AudioFFmpegCodec is an FFmpeg audio codec name used for transcoding.

	type AudioFFmpegCodec string

<a name="AudioFFmpegCodecPCMMulaw"></a>

	const (
	    AudioFFmpegCodecPCMMulaw AudioFFmpegCodec = "pcm_mulaw"
	    AudioFFmpegCodecPCMAlaw  AudioFFmpegCodec = "pcm_alaw"
	    AudioFFmpegCodecAAC      AudioFFmpegCodec = "aac"
	    AudioFFmpegCodecLibopus  AudioFFmpegCodec = "libopus"
	    AudioFFmpegCodecG722     AudioFFmpegCodec = "g722"
	    AudioFFmpegCodecG726     AudioFFmpegCodec = "g726"
	    AudioFFmpegCodecMP3      AudioFFmpegCodec = "mp3"
	    AudioFFmpegCodecPCMS16BE AudioFFmpegCodec = "pcm_s16be"
	    AudioFFmpegCodecPCMS16LE AudioFFmpegCodec = "pcm_s16le"
	    AudioFFmpegCodecFLAC     AudioFFmpegCodec = "flac"
	)

<a name="AudioFormat"></a>

## type AudioStreamInfo

AudioStreamInfo is audio stream information from a probe.

	type AudioStreamInfo struct {
	    // Codec is the audio codec.
	    Codec AudioCodec `msgpack:"codec" json:"codec"`
	    // FFmpegCodec is the FFmpeg codec name.
	    FFmpegCodec AudioFFmpegCodec `msgpack:"ffmpegCodec" json:"ffmpegCodec"`
	    // Properties are the codec properties.
	    Properties AudioCodecProperties `msgpack:"properties" json:"properties"`
	    // Direction is the stream direction.
	    Direction StreamDirection `msgpack:"direction" json:"direction"`
	}

<a name="BaseCamera"></a>

## type BaseCamera

BaseCamera is the stored camera data structure \(database row\) without resolved video sources. See Camera for the resolved form.

	type BaseCamera struct {
	    // ID is the unique camera ID.
	    ID  string `msgpack:"_id" json:"_id"`
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

<a name="BaseCameraConfig"></a>

## type BaseCameraConfig

BaseCameraConfig holds the camera configuration fields shared between creation and update operations.

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

<a name="BasePlugin"></a>

## type Camera

Camera is BaseCamera with its video sources resolved into streaming URLs.

	type Camera struct {
	    BaseCamera
	    // Sources are the video input sources.
	    Sources []CameraInput `msgpack:"sources,omitempty" json:"sources,omitempty"`
	}

<a name="CameraAspectRatio"></a>

## type CameraAspectRatio

CameraAspectRatio is the camera aspect ratio for UI display. The constants are the built\-in presets; any custom "width:height" ratio is also valid.

	type CameraAspectRatio string

<a name="CameraAspectRatio16x9"></a>

	const (
	    CameraAspectRatio16x9 CameraAspectRatio = "16:9"
	    CameraAspectRatio9x16 CameraAspectRatio = "9:16"
	    CameraAspectRatio8x3  CameraAspectRatio = "8:3"
	    CameraAspectRatio4x3  CameraAspectRatio = "4:3"
	    CameraAspectRatio1x1  CameraAspectRatio = "1:1"
	)

<a name="CameraConfig"></a>

## type CameraConfig

CameraConfig is the full camera configuration with sources, supplied when creating or adopting a camera.

	type CameraConfig struct {
	    BaseCameraConfig
	    // Sources are the video input sources.
	    Sources []CameraConfigInputSettings `msgpack:"sources" json:"sources"`
	}

<a name="CameraConfigInputSettings"></a>

## type CameraConfigInputSettings

CameraConfigInputSettings is a camera input/source definition supplied when creating or adopting a camera \(e.g. from DiscoveryProvider.OnAdoptCamera\). Unlike CameraInput, the URLs are raw source URLs the host resolves into streaming URLs.

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

<a name="CameraDetectionSettings"></a>

## type CameraDetectionSettings

CameraDetectionSettings is the combined detection settings for a camera.

	type CameraDetectionSettings struct {
	    // Motion is the motion detection settings.
	    Motion MotionDetectionSettings `msgpack:"motion" json:"motion"`
	    // Object is the object detection settings.
	    Object ObjectDetectionSettings `msgpack:"object" json:"object"`
	    // Audio is the audio detection settings.
	    Audio AudioDetectionSettings `msgpack:"audio" json:"audio"`
	    // Sensor is the sensor trigger settings.
	    Sensor SensorTriggerSettings `msgpack:"sensor" json:"sensor"`
	    // CascadeDetection enables the detection cascade.
	    CascadeDetection *bool `msgpack:"cascadeDetection,omitempty" json:"cascadeDetection,omitempty"`
	    // CascadeTimeout is the cascade hold-open window in seconds.
	    CascadeTimeout int `msgpack:"cascadeTimeout,omitempty" json:"cascadeTimeout,omitempty"`
	    // Snooze indicates whether detections are snoozed (paused).
	    Snooze bool `msgpack:"snooze,omitempty" json:"snooze,omitempty"`
	}

<a name="CameraDevice"></a>

## type CameraDevice

CameraDevice represents a camera assigned to this plugin. Plugins receive CameraDevice instances in ConfigureCameras and OnCameraAdded.

	type CameraDevice struct {
	    // contains filtered or unexported fields
	}

<a name="CameraDevice.AddSensor"></a>
### func \(\*CameraDevice\) AddSensor

	func (d *CameraDevice) AddSensor(s Sensor) error

AddSensor adds a sensor to this camera.

<a name="CameraDevice.Connect"></a>
### func \(\*CameraDevice\) Connect

	func (d *CameraDevice) Connect() error

Connect tells the server this camera is online. Only the plugin that owns this camera \(via pluginInfo\) may connect it.

<a name="CameraDevice.Connected"></a>
### func \(\*CameraDevice\) Connected

	func (d *CameraDevice) Connected() bool

Connected returns whether the camera is currently connected.

<a name="CameraDevice.DetectionLines"></a>
### func \(\*CameraDevice\) DetectionLines

	func (d *CameraDevice) DetectionLines() []DetectionLine

DetectionLines returns the detection line configurations \(virtual tripwires\).

<a name="CameraDevice.DetectionSettings"></a>
### func \(\*CameraDevice\) DetectionSettings

	func (d *CameraDevice) DetectionSettings() CameraDetectionSettings

DetectionSettings returns the detection settings.

<a name="CameraDevice.DetectionZones"></a>
### func \(\*CameraDevice\) DetectionZones

	func (d *CameraDevice) DetectionZones() []DetectionZone

DetectionZones returns the detection zone configurations.

<a name="CameraDevice.Disabled"></a>
### func \(\*CameraDevice\) Disabled

	func (d *CameraDevice) Disabled() bool

Disabled returns whether the camera is disabled.

<a name="CameraDevice.Disconnect"></a>
### func \(\*CameraDevice\) Disconnect

	func (d *CameraDevice) Disconnect() error

Disconnect tells the server this camera is offline. Only the plugin that owns this camera \(via pluginInfo\) may disconnect it.

<a name="CameraDevice.FrameWorkerConnected"></a>
### func \(\*CameraDevice\) FrameWorkerConnected

	func (d *CameraDevice) FrameWorkerConnected() bool

FrameWorkerConnected returns whether the frame worker is currently connected.

<a name="CameraDevice.FrameWorkerSettings"></a>
### func \(\*CameraDevice\) FrameWorkerSettings

	func (d *CameraDevice) FrameWorkerSettings() CameraFrameWorkerSettings

FrameWorkerSettings returns the frame worker settings.

<a name="CameraDevice.GetSensor"></a>
### func \(\*CameraDevice\) GetSensor

	func (d *CameraDevice) GetSensor(id string) Sensor

GetSensor returns a sensor by its ID \(checks both owned and foreign\).

<a name="CameraDevice.GetSensors"></a>
### func \(\*CameraDevice\) GetSensors

	func (d *CameraDevice) GetSensors() []Sensor

GetSensors returns all sensors on this camera \(owned \+ foreign\).

<a name="CameraDevice.GetSensorsByType"></a>
### func \(\*CameraDevice\) GetSensorsByType

	func (d *CameraDevice) GetSensorsByType(sensorType SensorType) []Sensor

GetSensorsByType returns all sensors of the given type \(owned \+ foreign\).

<a name="CameraDevice.GetSourceByID"></a>
### func \(\*CameraDevice\) GetSourceByID

	func (d *CameraDevice) GetSourceByID(id string) *CameraDeviceSource

GetSourceByID returns a source by its ID.

<a name="CameraDevice.HighResolutionSource"></a>
### func \(\*CameraDevice\) HighResolutionSource

	func (d *CameraDevice) HighResolutionSource() *CameraDeviceSource

HighResolutionSource returns the high\-resolution source.

<a name="CameraDevice.ID"></a>
### func \(\*CameraDevice\) ID

	func (d *CameraDevice) ID() string

ID returns the camera ID.

<a name="CameraDevice.Implement"></a>
### func \(\*CameraDevice\) Implement

	func (d *CameraDevice) Implement(impl any) error

Implement registers a camera implementation for streaming and/or snapshot. The impl value should implement StreamingInterface, SnapshotInterface, or both.

<a name="CameraDevice.Info"></a>
### func \(\*CameraDevice\) Info

	func (d *CameraDevice) Info() CameraInformation

Info returns the camera hardware information.

<a name="CameraDevice.InterfaceSettings"></a>
### func \(\*CameraDevice\) InterfaceSettings

	func (d *CameraDevice) InterfaceSettings() CameraUiSettings

InterfaceSettings returns the UI display settings.

<a name="CameraDevice.IsCloud"></a>
### func \(\*CameraDevice\) IsCloud

	func (d *CameraDevice) IsCloud() bool

IsCloud returns whether the camera streams from cloud.

<a name="CameraDevice.Logger"></a>
### func \(\*CameraDevice\) Logger

	func (d *CameraDevice) Logger() *Logger

Logger returns the camera's logger.

<a name="CameraDevice.LowResolutionSource"></a>
### func \(\*CameraDevice\) LowResolutionSource

	func (d *CameraDevice) LowResolutionSource() *CameraDeviceSource

LowResolutionSource returns the low\-resolution source.

<a name="CameraDevice.MidResolutionSource"></a>
### func \(\*CameraDevice\) MidResolutionSource

	func (d *CameraDevice) MidResolutionSource() *CameraDeviceSource

MidResolutionSource returns the mid\-resolution source.

<a name="CameraDevice.Name"></a>
### func \(\*CameraDevice\) Name

	func (d *CameraDevice) Name() string

Name returns the camera name.

<a name="CameraDevice.NativeID"></a>
### func \(\*CameraDevice\) NativeID

	func (d *CameraDevice) NativeID() string

NativeID returns the native device ID from the plugin, or empty string if not set.

<a name="CameraDevice.OnConnected"></a>
### func \(\*CameraDevice\) OnConnected

	func (d *CameraDevice) OnConnected() *Observable[bool]

OnConnected returns an Observable that emits distinct connection state changes.

<a name="CameraDevice.OnDetectionEvent"></a>
### func \(\*CameraDevice\) OnDetectionEvent

	func (d *CameraDevice) OnDetectionEvent(callback func(eventType DetectionEventType, event DetectionEvent)) *Disposable

OnDetectionEvent registers a callback for detection events \(start/update/end and segment\-start/segment\-update/segment\-end\). Segments only ship on the segment\-\* events; the 'end' message carries none. Thumbnails are inline in the segment structures: detection and attribute crops on 'segment\-start' and 'segment\-end', the scene thumbnail also once on the first 'segment\-update' after it becomes available. Returns a Disposable to unsubscribe.

<a name="CameraDevice.OnFrameWorkerConnected"></a>
### func \(\*CameraDevice\) OnFrameWorkerConnected

	func (d *CameraDevice) OnFrameWorkerConnected() *Observable[bool]

OnFrameWorkerConnected returns an Observable that emits distinct frame worker state changes.

<a name="CameraDevice.OnPropertyChange"></a>
### func \(\*CameraDevice\) OnPropertyChange

	func (d *CameraDevice) OnPropertyChange(properties ...string) *Observable[PropertyChangeEvent]

OnPropertyChange returns an Observable that emits when any of the specified camera properties change.

<a name="CameraDevice.OnSensorAdded"></a>
### func \(\*CameraDevice\) OnSensorAdded

	func (d *CameraDevice) OnSensorAdded(callback func(sensorID string, sensorType SensorType)) *Disposable

OnSensorAdded registers a callback for when a sensor from another plugin is added, and only when its type is listed in contract.consumes. This plugin's own sensors do not fire it. The callback receives \(sensorID, sensorType\). Returns a Disposable to unsubscribe.

<a name="CameraDevice.OnSensorProperty"></a>
### func \(\*CameraDevice\) OnSensorProperty

	func (d *CameraDevice) OnSensorProperty(sensorType SensorType, property string, callback func(value any, timestamp int64, sensor Sensor)) *Disposable

OnSensorProperty subscribes to a specific property on a sensor type with full lifecycle management. Automatically subscribes/unsubscribes when sensors of the given type are added/removed.

<a name="CameraDevice.OnSensorRemoved"></a>
### func \(\*CameraDevice\) OnSensorRemoved

	func (d *CameraDevice) OnSensorRemoved(callback func(string, SensorType)) *Disposable

OnSensorRemoved registers a callback for when a sensor is removed from this camera. Unlike OnSensorAdded it is not filtered: it fires for this plugin's own sensors and for other plugins' sensors alike. Returns a Disposable to unsubscribe.

<a name="CameraDevice.PTZAutotrack"></a>
### func \(\*CameraDevice\) PTZAutotrack

	func (d *CameraDevice) PTZAutotrack() PtzAutotrackSettings

PTZAutotrack returns the PTZ autotracking settings.

<a name="CameraDevice.PluginInfo"></a>
### func \(\*CameraDevice\) PluginInfo

	func (d *CameraDevice) PluginInfo() *CameraPluginInfo

PluginInfo returns the source plugin information, or nil if not set.

<a name="CameraDevice.RemoveSensor"></a>
### func \(\*CameraDevice\) RemoveSensor

	func (d *CameraDevice) RemoveSensor(sensorID string) error

RemoveSensor removes a sensor from this camera.

<a name="CameraDevice.Room"></a>
### func \(\*CameraDevice\) Room

	func (d *CameraDevice) Room() string

Room returns the room this camera belongs to.

<a name="CameraDevice.SnapshotSettings"></a>
### func \(\*CameraDevice\) SnapshotSettings

	func (d *CameraDevice) SnapshotSettings() SnapshotSettings

SnapshotSettings returns the snapshot settings.

<a name="CameraDevice.SnapshotSource"></a>
### func \(\*CameraDevice\) SnapshotSource

	func (d *CameraDevice) SnapshotSource() *CameraDeviceSource

SnapshotSource returns the snapshot source.

<a name="CameraDevice.Snooze"></a>
### func \(\*CameraDevice\) Snooze

	func (d *CameraDevice) Snooze() bool

Snooze returns whether detections are snoozed \(paused\).

<a name="CameraDevice.Sources"></a>
### func \(\*CameraDevice\) Sources

	func (d *CameraDevice) Sources() []*CameraDeviceSource

Sources returns the camera's source list.

<a name="CameraDevice.Storage"></a>
### func \(\*CameraDevice\) Storage

	func (d *CameraDevice) Storage() *DeviceStorage

Storage returns the camera's device storage.

<a name="CameraDevice.StreamSource"></a>
### func \(\*CameraDevice\) StreamSource

	func (d *CameraDevice) StreamSource() *CameraDeviceSource

StreamSource returns the primary streaming source \(first high\-resolution, or first available\).

<a name="CameraDevice.Type"></a>
### func \(\*CameraDevice\) Type

	func (d *CameraDevice) Type() CameraType

Type returns the camera type \(camera/doorbell\).

<a name="CameraDeviceSource"></a>

## type CameraDeviceSource

CameraDeviceSource is a camera source \(one of the camera's video inputs\) with snapshot, probe and URL\-generation capabilities.

	type CameraDeviceSource struct {
	    // contains filtered or unexported fields
	}

<a name="CameraDeviceSource.GenerateRTSPUrl"></a>
### func \(\*CameraDeviceSource\) GenerateRTSPUrl

	func (s *CameraDeviceSource) GenerateRTSPUrl(options *RTSPUrlOptions) (string, error)

GenerateRTSPUrl generates an RTSP URL for this source with the given options.

<a name="CameraDeviceSource.GenerateSnapshotUrl"></a>
### func \(\*CameraDeviceSource\) GenerateSnapshotUrl

	func (s *CameraDeviceSource) GenerateSnapshotUrl(options *SnapshotUrlOptions) (string, error)

GenerateSnapshotUrl generates a snapshot URL for this source with the given options.

<a name="CameraDeviceSource.GetStreamStatus"></a>
### func \(\*CameraDeviceSource\) GetStreamStatus

	func (s *CameraDeviceSource) GetStreamStatus() (string, error)

GetStreamStatus returns the current stream connection status \(e.g. "connected", "connecting", "error", "idle"\).

<a name="CameraDeviceSource.HotMode"></a>
### func \(\*CameraDeviceSource\) HotMode

	func (s *CameraDeviceSource) HotMode() bool

HotMode returns whether hot mode \(always\-on connection\) is enabled.

<a name="CameraDeviceSource.ID"></a>
### func \(\*CameraDeviceSource\) ID

	func (s *CameraDeviceSource) ID() string

ID returns the unique source ID.

<a name="CameraDeviceSource.Name"></a>
### func \(\*CameraDeviceSource\) Name

	func (s *CameraDeviceSource) Name() string

Name returns the source display name.

<a name="CameraDeviceSource.Preload"></a>
### func \(\*CameraDeviceSource\) Preload

	func (s *CameraDeviceSource) Preload() bool

Preload returns whether the stream is preloaded on startup.

<a name="CameraDeviceSource.ProbeStream"></a>
### func \(\*CameraDeviceSource\) ProbeStream

	func (s *CameraDeviceSource) ProbeStream(config *ProbeConfig, refresh bool) (*ProbeStream, error)

ProbeStream probes this source for codec and track information.

config selects which tracks to inspect \(nil probes the defaults\). When refresh is true a fresh probe is performed, ignoring any cached result.

<a name="CameraDeviceSource.Role"></a>
### func \(\*CameraDeviceSource\) Role

	func (s *CameraDeviceSource) Role() CameraRole

Role returns the resolution role of this source.

<a name="CameraDeviceSource.Snapshot"></a>
### func \(\*CameraDeviceSource\) Snapshot

	func (s *CameraDeviceSource) Snapshot(forceNew bool) ([]byte, error)

Snapshot returns a JPEG snapshot for this source. If forceNew is true, the snapshot cache is bypassed.

<a name="CameraDeviceSource.SourceURL"></a>
### func \(\*CameraDeviceSource\) SourceURL

	func (s *CameraDeviceSource) SourceURL() string

SourceURL returns the default RTSP URL for this source.

<a name="CameraDeviceSource.Urls"></a>
### func \(\*CameraDeviceSource\) Urls

	func (s *CameraDeviceSource) Urls() StreamUrls

Urls returns the generated stream URLs for this source.

<a name="CameraDeviceSource.UseForSnapshot"></a>
### func \(\*CameraDeviceSource\) UseForSnapshot

	func (s *CameraDeviceSource) UseForSnapshot() bool

UseForSnapshot returns whether this source is used for snapshots.

<a name="CameraFrameWorkerSettings"></a>

## type CameraFrameWorkerSettings

CameraFrameWorkerSettings is frame worker \(decoder\) settings.

	type CameraFrameWorkerSettings struct {
	    // FPS is the target frames per second for detection.
	    FPS int `msgpack:"fps" json:"fps"`
	    // Capture event thumbnails from the highest-resolution source.
	    HQSnapshots bool `msgpack:"hqSnapshots,omitempty" json:"hqSnapshots,omitempty"`
	}

<a name="CameraInformation"></a>

## type CameraInformation

CameraInformation is camera hardware/firmware information.

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

<a name="CameraInput"></a>

## type CameraInput

CameraInput is a camera video input/source with resolved URLs.

	type CameraInput struct {
	    // ID is the unique source ID.
	    ID  string `msgpack:"_id" json:"_id"`
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

<a name="CameraPluginInfo"></a>

## type CameraPluginInfo

CameraPluginInfo identifies the plugin that provides a camera \(id \+ display name\).

	type CameraPluginInfo struct {
	    // ID is the plugin ID.
	    ID  string `msgpack:"id" json:"id"`
	    // Name is the plugin display name.
	    Name string `msgpack:"name" json:"name"`
	}

<a name="CameraRole"></a>

## type CameraRole

CameraRole identifies the resolution tier of a camera source. Used to identify different quality streams from the same camera.

	type CameraRole string

<a name="CameraRoleHighRes"></a>

	const (
	    CameraRoleHighRes  CameraRole = "high-resolution"
	    CameraRoleMidRes   CameraRole = "mid-resolution"
	    CameraRoleLowRes   CameraRole = "low-resolution"
	    CameraRoleSnapshot CameraRole = "snapshot"
	)

<a name="CameraType"></a>

## type CameraType

CameraType is the camera device type.

- camera: Standard surveillance camera
- doorbell: Doorbell camera

	type CameraType string

<a name="CameraTypeCamera"></a>

	const (
	    CameraTypeCamera   CameraType = "camera"
	    CameraTypeDoorbell CameraType = "doorbell"
	)

<a name="CameraUiSettings"></a>

## type CameraUiSettings

CameraUiSettings is UI display settings for a camera.

	type CameraUiSettings struct {
	    // StreamingMode is the preferred streaming method.
	    StreamingMode VideoStreamingMode `msgpack:"streamingMode" json:"streamingMode"`
	    // StreamingSource is the preferred stream quality (StreamingRole).
	    StreamingSource string `msgpack:"streamingSource" json:"streamingSource"`
	    // AspectRatio is the display aspect ratio.
	    AspectRatio CameraAspectRatio `msgpack:"aspectRatio" json:"aspectRatio"`
	}

<a name="ChargingState"></a>

## type DetectionEvent

DetectionEvent is an aggregated detection event with lifecycle \(start \-\> update \-\> end\). Groups individual sensor detections into structured events.

	type DetectionEvent struct {
	    // ID is the unique event ID.
	    ID  string `msgpack:"id" json:"id"`
	    // CameraID is the camera that produced this event.
	    CameraID string `msgpack:"cameraId" json:"cameraId"`
	    // State is the event lifecycle state.
	    State DetectionEventState `msgpack:"state" json:"state"`
	    // StartTime is the event start time (Unix ms).
	    StartTime int64 `msgpack:"startTime" json:"startTime"`
	    // EndTime is the event end time (Unix ms, only when ended).
	    EndTime int64 `msgpack:"endTime,omitempty" json:"endTime,omitempty"`
	    // LastUpdate is the last activity timestamp (Unix ms).
	    LastUpdate int64 `msgpack:"lastUpdate" json:"lastUpdate"`
	    // Types lists the detection types present in this event (for filtering).
	    Types []string `msgpack:"types" json:"types"`
	    // Triggers are the event triggers (motion/audio/sensor/line-crossing).
	    Triggers []EventTrigger `msgpack:"triggers" json:"triggers"`
	    // Segments are detection segments (object detection phases).
	    // For segment-* messages: contains only the current segment.
	    // For start/end messages: empty.
	    Segments []EventSegment `msgpack:"segments" json:"segments"`
	    // SegmentIndex is the index of the segment in segments[0] for segment-* messages.
	    SegmentIndex int `msgpack:"segmentIndex,omitempty" json:"segmentIndex,omitempty"`
	    // ExpectedEndTime is the expected event end time (Unix ms) — the latest dwell expiry across all
	    // currently-active triggers. Monotonically non-decreasing during the event lifetime.
	    // Updated on each update / segment-* message.
	    ExpectedEndTime int64 `msgpack:"expectedEndTime,omitempty" json:"expectedEndTime,omitempty"`
	    // Thumbnail is a full-frame downscaled JPEG captured at event start. Inline only
	    // on the first message that delivers it (start or the first update); the NVR
	    // plugin persists it and clients fetch it on demand via GetEventThumbnails.
	    Thumbnail []byte `msgpack:"thumbnail,omitempty" json:"thumbnail,omitempty"`
	    // HasRecording reports whether recorded footage overlaps this event's time window.
	    // Populated only when the events query explicitly requests it (e.g. the recordings
	    // browser); the zero value otherwise carries no meaning.
	    HasRecording bool `msgpack:"hasRecording,omitempty" json:"hasRecording,omitempty"`
	}

<a name="DetectionEventData"></a>

## type DetectionEventData

DetectionEventData wraps a detection event with its lifecycle type.

	type DetectionEventData struct {
	    Type  DetectionEventType
	    Event DetectionEvent
	}

<a name="DetectionEventState"></a>

## type DetectionEventState

DetectionEventState is the lifecycle state of a detection event.

	type DetectionEventState = string

<a name="DetectionEventStateActive"></a>

	const (
	    DetectionEventStateActive DetectionEventState = "active"
	    DetectionEventStateEnded  DetectionEventState = "ended"
	)

<a name="DetectionEventType"></a>

## type DetectionEventType

DetectionEventType is the lifecycle phase of a detection event message.

	type DetectionEventType = string

<a name="DetectionEventStart"></a>

	const (
	    DetectionEventStart         DetectionEventType = "start"
	    DetectionEventEnd           DetectionEventType = "end"
	    DetectionEventUpdate        DetectionEventType = "update"
	    DetectionEventSegmentStart  DetectionEventType = "segment-start"
	    DetectionEventSegmentUpdate DetectionEventType = "segment-update"
	    DetectionEventSegmentEnd    DetectionEventType = "segment-end"
	)

<a name="DetectionLabel"></a>

## type DetectionLine

DetectionLine is a virtual tripwire for line crossing detection. The two points define grab\-handle positions; the actual crossing line is perpendicular through their midpoint.

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

<a name="DetectionZone"></a>

## type DetectionZone

DetectionZone is a polygon zone that restricts or drops detections.

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
	    // IsPrivacyMask indicates an ignore zone: detections fully inside it are dropped.
	    IsPrivacyMask bool `msgpack:"isPrivacyMask" json:"isPrivacyMask"`
	    // Color is the zone display color (hex).
	    Color string `msgpack:"color" json:"color"`
	}

<a name="DeviceManager"></a>

## type FMTPInfo

FMTPInfo holds format parameters \(fmtp\) from SDP.

	type FMTPInfo struct {
	    // Payload is the RTP payload type number.
	    Payload int `msgpack:"payload" json:"payload"`
	    // Config is the codec-specific configuration string.
	    Config string `msgpack:"config" json:"config"`
	}

<a name="FaceDetection"></a>

## type FrameFormat

FrameFormat identifies the pixel layout of a video frame.

	type FrameFormat string

<a name="FrameFormatNV12"></a>Supported video frame pixel formats.

	const (
	    FrameFormatNV12 FrameFormat = "nv12" // YUV 4:2:0 semi-planar
	    FrameFormatRGB  FrameFormat = "rgb"  // 3 bytes/pixel interleaved
	    FrameFormatRGBA FrameFormat = "rgba" // 4 bytes/pixel interleaved
	    FrameFormatGray FrameFormat = "gray" // 1 byte/pixel grayscale
	)

<a name="GarageControl"></a>

## type Go2RtcRTSPSource

Go2RtcRTSPSource contains RTSP streaming URLs from the stream provider.

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
	    // NoGop is the stream URL with GOP cache disabled.
	    NoGop string `msgpack:"noGop,omitempty" json:"noGop,omitempty"`
	}

<a name="Go2RtcSnapshotSource"></a>

## type Go2RtcSnapshotSource

Go2RtcSnapshotSource contains snapshot/image URLs from the stream provider.

	type Go2RtcSnapshotSource struct {
	    // MP4 is the MP4 single-frame video URL.
	    MP4 string `msgpack:"mp4,omitempty" json:"mp4,omitempty"`
	    // JPEG is the JPEG snapshot URL.
	    JPEG string `msgpack:"jpeg,omitempty" json:"jpeg,omitempty"`
	    // MJPEG is the MJPEG stream URL.
	    MJPEG string `msgpack:"mjpeg,omitempty" json:"mjpeg,omitempty"`
	}

<a name="Go2RtcWSSource"></a>

## type Go2RtcWSSource

Go2RtcWSSource contains WebSocket streaming URLs from the stream provider.

	type Go2RtcWSSource struct {
	    // WebRTC is the WebRTC signaling endpoint.
	    WebRTC string `msgpack:"webrtc,omitempty" json:"webrtc,omitempty"`
	    // MSE is the MSE streaming endpoint.
	    MSE string `msgpack:"mse,omitempty" json:"mse,omitempty"`
	}

<a name="HumidityInfo"></a>

## type LineDirection

LineDirection is the line crossing direction filter.

- both: Trigger on crossings in either direction
- a\-to\-b: Trigger only when crossing from A side to B side
- b\-to\-a: Trigger only when crossing from B side to A side

	type LineDirection = string

<a name="LineDirectionBoth"></a>

	const (
	    LineDirectionBoth LineDirection = "both"
	    LineDirectionAToB LineDirection = "a-to-b"
	    LineDirectionBToA LineDirection = "b-to-a"
	)

<a name="LockControl"></a>

## type MotionResolution

MotionResolution is the motion detection resolution setting. Higher resolution = more accurate but slower.

	type MotionResolution string

<a name="MotionResolutionLow"></a>

	const (
	    MotionResolutionLow    MotionResolution = "low"
	    MotionResolutionMedium MotionResolution = "medium"
	    MotionResolutionHigh   MotionResolution = "high"
	)

<a name="MotionResult"></a>

## type PTZCapability

PTZCapability defines PTZ capabilities.

	type PTZCapability string

<a name="PTZCapabilityPan"></a>

	const (
	    PTZCapabilityPan              PTZCapability = "pan"              // Camera supports panning (horizontal movement)
	    PTZCapabilityTilt             PTZCapability = "tilt"             // Camera supports tilting (vertical movement)
	    PTZCapabilityZoom             PTZCapability = "zoom"             // Camera supports zoom
	    PTZCapabilityPresets          PTZCapability = "presets"          // Camera supports named position presets
	    PTZCapabilityHome             PTZCapability = "home"             // Camera supports a home position
	    PTZCapabilityRelativeMove     PTZCapability = "relativeMove"     // Camera executes relative displacement moves
	    PTZCapabilityAbsolutePosition PTZCapability = "absolutePosition" // Camera accepts absolute position writes via `setPosition()`
	    PTZCapabilityVelocityControl  PTZCapability = "velocityControl"  // Camera accepts continuous-move commands via `setVelocity()`
	)

<a name="PTZControl"></a>

## type PTZDirection

PTZDirection represents PTZ movement speed for continuous move commands.

Speeds are in normalized range \[\-1, 1\] where \-1 is maximum speed in the negative direction, 0 stops movement, and 1 is maximum speed in the positive direction. Conventions: positive PanSpeed = right, positive TiltSpeed = up, positive ZoomSpeed = zoom in. Plugins should clamp values to \[\-1, 1\] and map them to hardware\-specific speeds.

	type PTZDirection struct {
	    PanSpeed  float64 `msgpack:"panSpeed" json:"panSpeed"`
	    TiltSpeed float64 `msgpack:"tiltSpeed" json:"tiltSpeed"`
	    ZoomSpeed float64 `msgpack:"zoomSpeed" json:"zoomSpeed"`
	}

<a name="PTZPosition"></a>

## type PTZPosition

PTZPosition represents an absolute PTZ position.

	type PTZPosition struct {
	    Pan  float64 `msgpack:"pan" json:"pan"`
	    Tilt float64 `msgpack:"tilt" json:"tilt"`
	    Zoom float64 `msgpack:"zoom" json:"zoom"`
	}

<a name="PTZRelativeMove"></a>

## type Point

Point is a zone polygon coordinate as \[x, y\] \(0\-100 percentage\).

	type Point [2]float64

<a name="ProbeAudioCodec"></a>

## type ProbeAudioCodec

ProbeAudioCodec is an audio codec supported for stream probing.

	type ProbeAudioCodec string

<a name="ProbeAudioCodecAAC"></a>

	const (
	    ProbeAudioCodecAAC  ProbeAudioCodec = "aac"
	    ProbeAudioCodecOpus ProbeAudioCodec = "opus"
	    ProbeAudioCodecPCMA ProbeAudioCodec = "pcma"
	)

<a name="ProbeConfig"></a>

## type ProbeConfig

ProbeConfig selects which tracks a stream probe inspects and returns.

	type ProbeConfig struct {
	    // Video includes video track info.
	    Video *bool `msgpack:"video,omitempty" json:"video,omitempty"`
	    // Audio includes audio track info — a bool, the string "all", or a
	    // []ProbeAudioCodec listing specific codecs.
	    Audio any `msgpack:"audio,omitempty" json:"audio,omitempty"`
	    // Microphone includes microphone/backchannel info.
	    Microphone *bool `msgpack:"microphone,omitempty" json:"microphone,omitempty"`
	}

<a name="ProbeStream"></a>

## type ProbeStream

ProbeStream is the result of a stream probe — SDP plus track information.

	type ProbeStream struct {
	    // SDP is the raw SDP string.
	    SDP string `msgpack:"sdp,omitempty" json:"sdp,omitempty"`
	    // Audio are the available audio tracks.
	    Audio []AudioStreamInfo `msgpack:"audio,omitempty" json:"audio,omitempty"`
	    // Video are the available video tracks.
	    Video []VideoStreamInfo `msgpack:"video,omitempty" json:"video,omitempty"`
	}

<a name="PropertyChangeEvent"></a>

## type PropertyChangeEvent

PropertyChangeEvent is emitted when a camera property changes.

	type PropertyChangeEvent struct {
	    Property  string
	    OldCamera Camera
	    NewCamera Camera
	}

<a name="PtzAutotrackSettings"></a>

## type PtzAutotrackSettings

PtzAutotrackSettings configures automatic PTZ tracking of detected objects.

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
	    // TrackingSpeed is how aggressively the camera moves to re-center the target (1 - 5).
	    // Higher reaches full pan/tilt speed at a smaller off-center error.
	    TrackingSpeed float64 `msgpack:"trackingSpeed" json:"trackingSpeed"`
	    // LeadMs is the motion prediction (0 - 4000): aim this many milliseconds ahead
	    // along the target's measured velocity, covering the time the camera needs to
	    // move and settle. 0 disables prediction.
	    LeadMs float64 `msgpack:"leadMs" json:"leadMs"`
	    // PanRate is the camera pan-rate calibration (0.1 - 3): assumed pan travel at
	    // full motor speed in normalized frame-widths per second. Lower it if the
	    // camera stops short of the target, raise it if it overshoots.
	    PanRate float64 `msgpack:"panRate" json:"panRate"`
	    // ReturnToHome enables returning to the home position when no target is found for HomeWaitMs.
	    ReturnToHome bool `msgpack:"returnToHome" json:"returnToHome"`
	    // HomeWaitMs is how long to wait (ms) without a target before returning home.
	    HomeWaitMs int `msgpack:"homeWaitMs" json:"homeWaitMs"`
	}

<a name="PythonVersion"></a>

## type RTSPAudioCodec

RTSPAudioCodec is an audio codec supported for RTSP streaming.

	type RTSPAudioCodec string

<a name="RTSPAudioCodecAAC"></a>

	const (
	    RTSPAudioCodecAAC  RTSPAudioCodec = "aac"
	    RTSPAudioCodecOpus RTSPAudioCodec = "opus"
	    RTSPAudioCodecPCMA RTSPAudioCodec = "pcma"
	)

<a name="RTSPUrlOptions"></a>

## type RTSPUrlOptions

RTSPUrlOptions is options for generating RTSP URLs.

	type RTSPUrlOptions struct {
	    // Video toggles inclusion of the video track.
	    Video bool `msgpack:"video,omitempty" json:"video"`
	    // Audio is the list of audio codecs to include.
	    Audio []RTSPAudioCodec `msgpack:"audio,omitempty" json:"audio"`
	    // GOP requests a keyframe at start.
	    GOP bool `msgpack:"gop,omitempty" json:"gop"`
	    // AudioSingleTrack combines audio tracks into a single track.
	    AudioSingleTrack bool `msgpack:"audioSingleTrack,omitempty" json:"audioSingleTrack"`
	    // Backchannel enables backchannel (two-way audio).
	    Backchannel bool `msgpack:"backchannel,omitempty" json:"backchannel"`
	    // Timeout is the connection timeout in seconds.
	    Timeout int `msgpack:"timeout,omitempty" json:"timeout"`
	}

<a name="ReplaySubject"></a>

## type SnapshotInterface

SnapshotInterface is optionally implemented to provide snapshots.

	type SnapshotInterface interface {
	    // Snapshot returns a snapshot image from the camera. When forceNew is true, the cache is bypassed for a fresh snapshot.
	    Snapshot(sourceID string, forceNew bool) ([]byte, error)
	}

<a name="SnapshotSettings"></a>

## type SnapshotSettings

SnapshotSettings is snapshot configuration for a camera.

	type SnapshotSettings struct {
	    // AutoRefresh enables automatic snapshot refresh.
	    AutoRefresh bool `msgpack:"autoRefresh" json:"autoRefresh"`
	    // TTL is the cache TTL in seconds (how long a snapshot is valid).
	    TTL int `msgpack:"ttl" json:"ttl"`
	    // Interval is the auto-refresh interval in seconds (min: 10, max: 60).
	    Interval int `msgpack:"interval" json:"interval"`
	}

<a name="SnapshotUrlOptions"></a>

## type SnapshotUrlOptions

SnapshotUrlOptions is options for generating snapshot URLs.

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
	    HW  string `msgpack:"hw,omitempty" json:"hw"`
	    // GOP requests a keyframe at start.
	    GOP bool `msgpack:"gop,omitempty" json:"gop"`
	}

<a name="StorageController"></a>

## type StreamDirection

StreamDirection is the direction of a media stream \(from SDP\).

	type StreamDirection string

<a name="StreamDirectionSendOnly"></a>

	const (
	    StreamDirectionSendOnly StreamDirection = "sendonly"
	    StreamDirectionRecvOnly StreamDirection = "recvonly"
	    StreamDirectionSendRecv StreamDirection = "sendrecv"
	    StreamDirectionInactive StreamDirection = "inactive"
	)

<a name="StreamUrls"></a>

## type StreamUrls

StreamUrls is the collection of all streaming URLs for a camera source.

	type StreamUrls struct {
	    // WS are the WebSocket streaming URLs.
	    WS  Go2RtcWSSource `msgpack:"ws,omitempty" json:"ws"`
	    // RTSP are the RTSP streaming URLs.
	    RTSP Go2RtcRTSPSource `msgpack:"rtsp,omitempty" json:"rtsp"`
	    // Snapshot are the snapshot/image URLs.
	    Snapshot Go2RtcSnapshotSource `msgpack:"snapshot,omitempty" json:"snapshot"`
	}

<a name="StreamingInterface"></a>

## type StreamingInterface

StreamingInterface is optionally implemented to provide stream URLs.

	type StreamingInterface interface {
	    // StreamUrl returns the streaming URL for a source (e.g. rtsp://, rtmp://, or custom protocol).
	    StreamUrl(sourceID string) (string, error)
	}

<a name="StreamingRole"></a>

## type StreamingRole

StreamingRole is the resolution role for live streaming \(excludes snapshot\).

	type StreamingRole string

<a name="StreamingRoleHighRes"></a>

	const (
	    StreamingRoleHighRes StreamingRole = "high-resolution"
	    StreamingRoleMidRes  StreamingRole = "mid-resolution"
	    StreamingRoleLowRes  StreamingRole = "low-resolution"
	)

<a name="StringFormat"></a>

## type VideoCodec

VideoCodec is a supported video codec \(RTP/SDP format name\).

	type VideoCodec string

<a name="VideoCodecH264"></a>

	const (
	    VideoCodecH264 VideoCodec = "H264"
	    VideoCodecH265 VideoCodec = "H265"
	    VideoCodecVP8  VideoCodec = "VP8"
	    VideoCodecVP9  VideoCodec = "VP9"
	    VideoCodecAV1  VideoCodec = "AV1"
	    VideoCodecJPEG VideoCodec = "JPEG"
	    VideoCodecRAW  VideoCodec = "RAW"
	)

<a name="VideoCodecProperties"></a>

## type VideoCodecProperties

VideoCodecProperties holds video codec properties from a stream probe.

	type VideoCodecProperties struct {
	    // ClockRate is the video clock rate.
	    ClockRate int `msgpack:"clockRate" json:"clockRate"`
	    // PayloadType is the RTP payload type number.
	    PayloadType int `msgpack:"payloadType" json:"payloadType"`
	    // FmtpInfo holds optional format parameters.
	    FmtpInfo *FMTPInfo `msgpack:"fmtpInfo,omitempty" json:"fmtpInfo,omitempty"`
	}

<a name="VideoFFmpegCodec"></a>

## type VideoFFmpegCodec

VideoFFmpegCodec is an FFmpeg video codec name used for transcoding.

	type VideoFFmpegCodec string

<a name="VideoFFmpegCodecH264"></a>

	const (
	    VideoFFmpegCodecH264     VideoFFmpegCodec = "h264"
	    VideoFFmpegCodecHEVC     VideoFFmpegCodec = "hevc"
	    VideoFFmpegCodecVP8      VideoFFmpegCodec = "vp8"
	    VideoFFmpegCodecVP9      VideoFFmpegCodec = "vp9"
	    VideoFFmpegCodecAV1      VideoFFmpegCodec = "av1"
	    VideoFFmpegCodecMJPEG    VideoFFmpegCodec = "mjpeg"
	    VideoFFmpegCodecRawvideo VideoFFmpegCodec = "rawvideo"
	)

<a name="VideoFrameData"></a>

## type VideoFrameData

VideoFrameData is the video frame payload delivered to detector sensors by the backend pipeline. The backend handles capture, decoding, and scaling — detectors only need to process the pixel buffer.

	type VideoFrameData struct {
	    ID        string      `msgpack:"id" json:"id"`                           // Unique frame or crop identifier used to map batch results back to inputs
	    CameraID  string      `msgpack:"cameraId" json:"cameraId"`               // Camera the frame originated from
	    Data      []byte      `msgpack:"data" json:"data"`                       // Raw pixel buffer
	    Width     int         `msgpack:"width" json:"width"`                     // Frame width in pixels
	    Height    int         `msgpack:"height" json:"height"`                   // Frame height in pixels
	    Format    FrameFormat `msgpack:"format" json:"format"`                   // Pixel format: rgb = 3 bytes/pixel interleaved, rgba = 4 bytes/pixel, gray = 1 byte/pixel, nv12 = YUV semi-planar
	    Timestamp int64       `msgpack:"timestamp" json:"timestamp"`             // Capture timestamp in milliseconds since epoch
	    Label     string      `msgpack:"label,omitempty" json:"label,omitempty"` // Trigger label propagated by the coordinator for secondary detectors
	}

<a name="VideoInputSpec"></a>

## type VideoStreamInfo

VideoStreamInfo is video stream information from a probe.

	type VideoStreamInfo struct {
	    // Codec is the video codec.
	    Codec VideoCodec `msgpack:"codec" json:"codec"`
	    // FFmpegCodec is the FFmpeg codec name.
	    FFmpegCodec VideoFFmpegCodec `msgpack:"ffmpegCodec" json:"ffmpegCodec"`
	    // Properties are the codec properties.
	    Properties VideoCodecProperties `msgpack:"properties" json:"properties"`
	    // Direction is the stream direction.
	    Direction StreamDirection `msgpack:"direction" json:"direction"`
	}

<a name="VideoStreamingMode"></a>

## type VideoStreamingMode

VideoStreamingMode is the video streaming mode for UI playback.

- auto: Automatically select best method
- webrtc: WebRTC with UDP \(lowest latency\)
- webrtc/tcp: WebRTC with TCP fallback
- mse: Media Source Extensions \(browser native\)

	type VideoStreamingMode string

<a name="VideoStreamingModeAuto"></a>

	const (
	    VideoStreamingModeAuto      VideoStreamingMode = "auto"
	    VideoStreamingModeWebRTC    VideoStreamingMode = "webrtc"
	    VideoStreamingModeMSE       VideoStreamingMode = "mse"
	    VideoStreamingModeWebRTCTCP VideoStreamingMode = "webrtc/tcp"
	)

<a name="ZoneFilter"></a>

## type ZoneFilter

ZoneFilter is the detection zone filter mode.

- include: Only consider detections inside this zone
- exclude: Only consider detections outside this zone

	type ZoneFilter string

<a name="ZoneFilterInclude"></a>

	const (
	    ZoneFilterInclude ZoneFilter = "include"
	    ZoneFilterExclude ZoneFilter = "exclude"
	)

<a name="ZoneType"></a>

## type ZoneType

ZoneType is the detection zone intersection type.

- intersect: Trigger when object overlaps the zone at all
- contain: Trigger only when object is fully inside the zone

	type ZoneType string

<a name="ZoneTypeIntersect"></a>

	const (
	    ZoneTypeIntersect ZoneType = "intersect"
	    ZoneTypeContain   ZoneType = "contain"
	)

Generated by [gomarkdoc](<https://github.com/princjef/gomarkdoc>)
