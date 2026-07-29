# Sensors

Detection sensors (motion, object, face, license-plate, audio, classifier, clip) and smart-home sensors (contact, doorbell, lock, garage, light, switch, PTZ, security system, environmental). Plus the sensor-level model specs and shared detection types (`Detection`, `BoundingBox`, `TrackedDetection`).

!!! note
    The reference below is auto-generated from Go doc comments via [`gomarkdoc`](https://github.com/princjef/gomarkdoc). Re-run `scripts/gen-api-docs.sh` to refresh it.

## type AudioDetector

AudioDetector is implemented by plugins that classify audio events. The runtime resamples and buffers audio to match ModelSpec before each call.

	type AudioDetector interface {
	    // ModelSpec declares the expected audio input format.
	    ModelSpec() AudioModelSpec
	    // DetectAudio analyzes a single audio frame and returns the audio result.
	    DetectAudio(audio AudioFrameData) (*AudioResult, error)
	}

<a name="AudioDetectorSensor"></a>

## type AudioDetectorSensor

AudioDetectorSensor is an audio sensor that consumes audio frames from the backend pipeline. Pair with an AudioDetector implementation.

	type AudioDetectorSensor struct {
	    AudioSensor
	}

<a name="NewAudioDetectorSensor"></a>
### func NewAudioDetectorSensor

	func NewAudioDetectorSensor(name string, opts ...SensorOption) *AudioDetectorSensor

NewAudioDetectorSensor creates an audio detector sensor with the given name and options.

<a name="AudioFFmpegCodec"></a>

## type AudioFormat

AudioFormat identifies the sample format of an audio buffer.

	type AudioFormat string

<a name="AudioFormatPCM16"></a>Supported audio sample formats.

	const (
	    AudioFormatPCM16   AudioFormat = "pcm16"   // 16-bit signed integer PCM
	    AudioFormatFloat32 AudioFormat = "float32" // 32-bit float
	)

<a name="AudioFrameData"></a>

## type AudioFrameData

AudioFrameData is audio frame data delivered to audio detector sensors by the backend pipeline.

	type AudioFrameData struct {
	    CameraID   string      `msgpack:"cameraId" json:"cameraId"`     // Camera the frame originated from
	    Data       []byte      `msgpack:"data" json:"data"`             // Raw audio sample buffer
	    SampleRate int         `msgpack:"sampleRate" json:"sampleRate"` // Sample rate of the buffer in Hz
	    Channels   int         `msgpack:"channels" json:"channels"`     // Channel count of the buffer (typically 1 = mono)
	    Format     AudioFormat `msgpack:"format" json:"format"`         // Sample format: pcm16 = 16-bit signed integer PCM, float32 = 32-bit float
	    Decibels   float64     `msgpack:"decibels" json:"decibels"`     // Pre-computed decibel level for this frame, if available
	    Timestamp  int64       `msgpack:"timestamp" json:"timestamp"`   // Capture timestamp in milliseconds since epoch
	}

<a name="AudioInputSpec"></a>

## type AudioLabel

AudioLabel is one of the built\-in audio labels, or any custom string emitted by an audio detector.

	type AudioLabel = string

<a name="AudioMetadata"></a>

## type AudioModelSpec

AudioModelSpec describes an audio detection model.

	type AudioModelSpec struct {
	    Input AudioInputSpec `msgpack:"input" json:"input"` // Required input audio format
	}

<a name="AudioResult"></a>

## type AudioResult

AudioResult is the return value of AudioDetector.DetectAudio.

	type AudioResult struct {
	    Detected   bool        `msgpack:"detected" json:"detected"`     // Whether an audio event is detected in this frame
	    Detections []Detection `msgpack:"detections" json:"detections"` // Detections emitted for this frame
	    Decibels   float64     `msgpack:"decibels" json:"decibels"`     // Optional decibel level computed for this frame
	}

<a name="AudioSensor"></a>

## type AudioSensor

AudioSensor reports audio events and decibel levels.

Plugin authors call ReportDetections to push detected audio events \(the detected flag is auto\-derived from the list\) and SetDecibels to publish the audio level.

	type AudioSensor struct {
	    BaseSensor
	}

<a name="NewAudioSensor"></a>
### func NewAudioSensor

	func NewAudioSensor(name string, opts ...SensorOption) *AudioSensor

NewAudioSensor creates an audio sensor with the given name and options.

<a name="AudioSensor.ClearDetections"></a>
### func \(\*AudioSensor\) ClearDetections

	func (s *AudioSensor) ClearDetections()

ClearDetections explicitly clears audio detection state \(detected = false, detections = \[\]\).

<a name="AudioSensor.GetCategory"></a>
### func \(\*AudioSensor\) GetCategory

	func (s *AudioSensor) GetCategory() SensorCategory



<a name="AudioSensor.GetDecibels"></a>
### func \(\*AudioSensor\) GetDecibels

	func (s *AudioSensor) GetDecibels() float64



<a name="AudioSensor.GetDetections"></a>
### func \(\*AudioSensor\) GetDetections

	func (s *AudioSensor) GetDetections() []Detection



<a name="AudioSensor.GetType"></a>
### func \(\*AudioSensor\) GetType

	func (s *AudioSensor) GetType() SensorType



<a name="AudioSensor.IsDetected"></a>
### func \(\*AudioSensor\) IsDetected

	func (s *AudioSensor) IsDetected() bool



<a name="AudioSensor.ReportDetections"></a>
### func \(\*AudioSensor\) ReportDetections

	func (s *AudioSensor) ReportDetections(detected bool, detections []Detection)

ReportDetections reports detected audio events.

- ReportDetections\(true, nil\): audio detected without specifics. The SDK synthesizes a single full\-frame "audio" detection.
- ReportDetections\(true, \[...\]\): audio detected with explicit detections.
- ReportDetections\(false, nil\): clear.

Example:

	sensor.ReportDetections(true, []Detection{
	    {Label: "glass_break", Confidence: 0.91, Box: &BoundingBox{X: 0, Y: 0, Width: 1, Height: 1}},
	})
	sensor.ReportDetections(false, nil)
	

<a name="AudioSensor.SetDecibels"></a>
### func \(\*AudioSensor\) SetDecibels

	func (s *AudioSensor) SetDecibels(value float64)

SetDecibels updates the current audio level \(in decibels\).

Example:

	sensor.SetDecibels(72)
	

<a name="AudioSensor.ToJSON"></a>
### func \(\*AudioSensor\) ToJSON

	func (s *AudioSensor) ToJSON() sensorJSON



<a name="AudioSensor.UpdateValue"></a>
### func \(\*AudioSensor\) UpdateValue

	func (s *AudioSensor) UpdateValue(property string, value any) error

UpdateValue on a read\-only sensor: external writes are ignored.

<a name="AudioStreamInfo"></a>

## type BaseSensor

BaseSensor is the base struct for all sensors. Embed this in concrete sensor types.

Sensors are standalone entities: the plugin supplies the durable identity \(WithNativeID\), everything else belongs to the user: camera assignments, display name and whether the sensor is exported or not. A plugin never decides where its sensor is used and never handles the export itself.

	type BaseSensor struct {
	    // contains filtered or unexported fields
	}

<a name="NewBaseSensor"></a>
### func NewBaseSensor

	func NewBaseSensor(name string, opts ...SensorOption) BaseSensor

NewBaseSensor creates the embedded base for a concrete sensor type. The id it assigns is provisional until the host registers the sensor, and Storage stays nil until then.

Example:

	type MySensor struct{ sdk.BaseSensor }
	
	s := &MySensor{BaseSensor: sdk.NewBaseSensor("Front Door", sdk.WithNativeID("dev-1"))}
	

<a name="BaseSensor.Connected"></a>
### func \(\*BaseSensor\) Connected

	func (s *BaseSensor) Connected() bool



<a name="BaseSensor.GetAssignedCameraIDs"></a>
### func \(\*BaseSensor\) GetAssignedCameraIDs

	func (s *BaseSensor) GetAssignedCameraIDs() []string



<a name="BaseSensor.GetCapabilities"></a>
### func \(\*BaseSensor\) GetCapabilities

	func (s *BaseSensor) GetCapabilities() []string



<a name="BaseSensor.GetDisplayName"></a>
### func \(\*BaseSensor\) GetDisplayName

	func (s *BaseSensor) GetDisplayName() string



<a name="BaseSensor.GetID"></a>
### func \(\*BaseSensor\) GetID

	func (s *BaseSensor) GetID() string



<a name="BaseSensor.GetName"></a>
### func \(\*BaseSensor\) GetName

	func (s *BaseSensor) GetName() string



<a name="BaseSensor.GetNativeID"></a>
### func \(\*BaseSensor\) GetNativeID

	func (s *BaseSensor) GetNativeID() string



<a name="BaseSensor.GetPluginID"></a>
### func \(\*BaseSensor\) GetPluginID

	func (s *BaseSensor) GetPluginID() string



<a name="BaseSensor.GetValue"></a>
### func \(\*BaseSensor\) GetValue

	func (s *BaseSensor) GetValue(property string) any



<a name="BaseSensor.GetValues"></a>
### func \(\*BaseSensor\) GetValues

	func (s *BaseSensor) GetValues() map[string]any



<a name="BaseSensor.HasCapability"></a>
### func \(\*BaseSensor\) HasCapability

	func (s *BaseSensor) HasCapability(cap string) bool

HasCapability reports whether the sensor advertises the given capability.

Example:

	dimmable := sensor.HasCapability(sdk.LightCapabilityBrightness)
	

<a name="BaseSensor.IsAssigned"></a>
### func \(\*BaseSensor\) IsAssigned

	func (s *BaseSensor) IsAssigned() bool



<a name="BaseSensor.OnAssignmentChanged"></a>
### func \(\*BaseSensor\) OnAssignmentChanged

	func (s *BaseSensor) OnAssignmentChanged(callback func([]string)) *Disposable

OnAssignmentChanged fires with the current camera id list whenever the user changes this sensor's camera assignments.

<a name="BaseSensor.OnCapabilitiesChanged"></a>
### func \(\*BaseSensor\) OnCapabilitiesChanged

	func (s *BaseSensor) OnCapabilitiesChanged(callback func([]string)) *Disposable

OnCapabilitiesChanged returns a Disposable that fires when capabilities change.

<a name="BaseSensor.OnConnectedChanged"></a>
### func \(\*BaseSensor\) OnConnectedChanged

	func (s *BaseSensor) OnConnectedChanged(callback func(bool)) *Disposable

OnConnectedChanged fires when the sensor's registration state changes.

<a name="BaseSensor.OnPropertyChanged"></a>
### func \(\*BaseSensor\) OnPropertyChanged

	func (s *BaseSensor) OnPropertyChanged(callback func(SensorPropertyChange)) *Disposable

OnPropertyChanged subscribes to property changes. Returns a Disposable to unsubscribe.

<a name="BaseSensor.SetCapabilities"></a>
### func \(\*BaseSensor\) SetCapabilities

	func (s *BaseSensor) SetCapabilities(caps []string)

SetCapabilities replaces the advertised feature flags and notifies the backend plus local listeners.

Example:

	sensor.SetCapabilities([]string{sdk.LightCapabilityBrightness})
	

<a name="BaseSensor.SetDisplayName"></a>
### func \(\*BaseSensor\) SetDisplayName

	func (s *BaseSensor) SetDisplayName(name string)

SetDisplayName sets the display name \(the only mutable identifier on a sensor\). name is the human\-readable label shown in the UI.

Example:

	sensor.SetDisplayName("Front Door Motion")
	

<a name="BaseSensor.Storage"></a>
### func \(\*BaseSensor\) Storage

	func (s *BaseSensor) Storage() *DeviceStorage



<a name="BatteryInfo"></a>

## type BatteryInfo

BatteryInfo reports battery level, charging state, and low\-battery alerts.

Plugin authors call SetLevel, SetCharging, and SetLow to push updates from the device.

	type BatteryInfo struct{ BaseSensor }

<a name="NewBatteryInfo"></a>
### func NewBatteryInfo

	func NewBatteryInfo(name string, opts ...SensorOption) *BatteryInfo

NewBatteryInfo creates a battery info sensor with the given name and options.

<a name="BatteryInfo.GetCategory"></a>
### func \(\*BatteryInfo\) GetCategory

	func (s *BatteryInfo) GetCategory() SensorCategory



<a name="BatteryInfo.GetCharging"></a>
### func \(\*BatteryInfo\) GetCharging

	func (s *BatteryInfo) GetCharging() ChargingState



<a name="BatteryInfo.GetLevel"></a>
### func \(\*BatteryInfo\) GetLevel

	func (s *BatteryInfo) GetLevel() int



<a name="BatteryInfo.GetType"></a>
### func \(\*BatteryInfo\) GetType

	func (s *BatteryInfo) GetType() SensorType



<a name="BatteryInfo.IsLow"></a>
### func \(\*BatteryInfo\) IsLow

	func (s *BatteryInfo) IsLow() bool



<a name="BatteryInfo.SetCharging"></a>
### func \(\*BatteryInfo\) SetCharging

	func (s *BatteryInfo) SetCharging(value ChargingState)

SetCharging sets the charging state.

Example:

	battery.SetCharging(ChargingStateCharging)
	

<a name="BatteryInfo.SetLevel"></a>
### func \(\*BatteryInfo\) SetLevel

	func (s *BatteryInfo) SetLevel(value int)

SetLevel reports a new battery level percentage, clamped to \[0,100\].

Example:

	battery.SetLevel(87)
	

<a name="BatteryInfo.SetLow"></a>
### func \(\*BatteryInfo\) SetLow

	func (s *BatteryInfo) SetLow(value bool)

SetLow sets the low\-battery alert flag.

Example:

	battery.SetLow(true)
	

<a name="BatteryInfo.ToJSON"></a>
### func \(\*BatteryInfo\) ToJSON

	func (s *BatteryInfo) ToJSON() sensorJSON



<a name="BatteryInfo.UpdateValue"></a>
### func \(\*BatteryInfo\) UpdateValue

	func (s *BatteryInfo) UpdateValue(property string, value any) error

UpdateValue on a read\-only sensor: external writes are ignored.

<a name="BehaviorSubject"></a>

## type BoundingBox

BoundingBox is the bounding box of a detection. All coordinates are normalized to 0\-1 \(fraction of frame dimensions\), so they are independent of resolution.

	type BoundingBox struct {
	    X      float64 `msgpack:"x" json:"x"`           // X coordinate of the top-left corner (0-1)
	    Y      float64 `msgpack:"y" json:"y"`           // Y coordinate of the top-left corner (0-1)
	    Width  float64 `msgpack:"width" json:"width"`   // Width as a fraction of frame width (0-1)
	    Height float64 `msgpack:"height" json:"height"` // Height as a fraction of frame height (0-1)
	}

<a name="ButtonColor"></a>

## type ChargingState

ChargingState defines battery charging states.

	type ChargingState string

<a name="ChargingStateNotCharging"></a>

	const (
	    ChargingStateNotCharging   ChargingState = "NOT_CHARGING"   // Battery is not charging
	    ChargingStateNotChargeable ChargingState = "NOT_CHARGEABLE" // Device has no rechargeable battery
	    ChargingStateCharging      ChargingState = "CHARGING"       // Battery is currently charging
	    ChargingStateFull          ChargingState = "FULL"           // Battery is fully charged
	)

<a name="ClassifierDetection"></a>

## type ClassifierDetection

ClassifierDetection is a classifier detection result with an open attribute for classifier categories. The Attribute field of the embedded Detection holds the classifier category \(e.g. "bird", "delivery"\).

	type ClassifierDetection struct {
	    Detection
	    SubAttribute string `msgpack:"subAttribute" json:"subAttribute"` // Classifier sub-category (e.g. "woodpecker", "amazon")
	}

<a name="ClassifierDetectionInterface"></a>

## type ClassifierDetector

ClassifierDetector is implemented by plugins that run image classification models against pre\-cropped trigger regions.

	type ClassifierDetector interface {
	    // ModelSpec declares the expected input dimensions and trigger labels. The
	    // runtime scales frames to match.
	    ModelSpec() ModelSpec
	    // DetectClassifications classifies a batch of frames, each scaled to
	    // ModelSpec().Input: normally a trigger region cropped by the upstream
	    // object detector, but the whole scene when no decoded frame is available.
	    // Must return exactly one ClassifierResult per input frame, in the same
	    // order.
	    DetectClassifications(frames []VideoFrameData) ([]ClassifierResult, error)
	}

<a name="ClassifierDetectorSensor"></a>

## type ClassifierDetectorSensor

ClassifierDetectorSensor is a classifier sensor that consumes video frames from the backend pipeline. Pair with a ClassifierDetector implementation.

	type ClassifierDetectorSensor struct {
	    ClassifierSensor
	}

<a name="NewClassifierDetectorSensor"></a>
### func NewClassifierDetectorSensor

	func NewClassifierDetectorSensor(name string, opts ...SensorOption) *ClassifierDetectorSensor

NewClassifierDetectorSensor creates a classifier detector sensor with the given name and options.

<a name="ClassifierResult"></a>

## type ClassifierResult

ClassifierResult is the return value of ClassifierDetector.DetectClassifications.

	type ClassifierResult struct {
	    Detected   bool                  `msgpack:"detected" json:"detected"`     // Whether any classification result is emitted for this frame
	    Detections []ClassifierDetection `msgpack:"detections" json:"detections"` // Detections emitted for this frame
	}

<a name="ClassifierSensor"></a>

## type ClassifierSensor

ClassifierSensor reports classification results from image analysis.

Plugin authors call ReportDetections to push classification results. The detected flag and labels are auto\-derived from the detection list.

	type ClassifierSensor struct{ BaseSensor }

<a name="NewClassifierSensor"></a>
### func NewClassifierSensor

	func NewClassifierSensor(name string, opts ...SensorOption) *ClassifierSensor

NewClassifierSensor creates a classifier sensor with the given name and options.

<a name="ClassifierSensor.ClearDetections"></a>
### func \(\*ClassifierSensor\) ClearDetections

	func (s *ClassifierSensor) ClearDetections()

ClearDetections explicitly clears classifier state \(detected = false, detections = \[\], labels = \[\]\).

<a name="ClassifierSensor.GetCategory"></a>
### func \(\*ClassifierSensor\) GetCategory

	func (s *ClassifierSensor) GetCategory() SensorCategory



<a name="ClassifierSensor.GetDetections"></a>
### func \(\*ClassifierSensor\) GetDetections

	func (s *ClassifierSensor) GetDetections() []ClassifierDetection



<a name="ClassifierSensor.GetLabels"></a>
### func \(\*ClassifierSensor\) GetLabels

	func (s *ClassifierSensor) GetLabels() []string



<a name="ClassifierSensor.GetType"></a>
### func \(\*ClassifierSensor\) GetType

	func (s *ClassifierSensor) GetType() SensorType



<a name="ClassifierSensor.IsDetected"></a>
### func \(\*ClassifierSensor\) IsDetected

	func (s *ClassifierSensor) IsDetected() bool



<a name="ClassifierSensor.ReportDetections"></a>
### func \(\*ClassifierSensor\) ReportDetections

	func (s *ClassifierSensor) ReportDetections(detected bool, detections []ClassifierDetection)

ReportDetections reports classification results. The detected flag and labels are auto\-derived from the detection list.

- ReportDetections\(true, nil\): generic classification trigger. The SDK synthesizes a single full\-frame detection with empty attribute and sub\-attribute.
- ReportDetections\(true, \[...\]\): explicit classifier detections.
- ReportDetections\(false, nil\): clear.

Example:

	sensor.ReportDetections(true, []ClassifierDetection{
	    {Detection: Detection{Label: "animal", Confidence: 0.88, Box: &BoundingBox{X: 0.1, Y: 0.2, Width: 0.3, Height: 0.4}, Attribute: "bird"}, SubAttribute: "woodpecker"},
	})
	sensor.ReportDetections(false, nil)
	

<a name="ClassifierSensor.ToJSON"></a>
### func \(\*ClassifierSensor\) ToJSON

	func (s *ClassifierSensor) ToJSON() sensorJSON



<a name="ClassifierSensor.UpdateValue"></a>
### func \(\*ClassifierSensor\) UpdateValue

	func (s *ClassifierSensor) UpdateValue(property string, value any) error

UpdateValue on a read\-only sensor: external writes are ignored.

<a name="ClipDetectionInterface"></a>

## type ClipDetector

ClipDetector is implemented by plugins that generate CLIP embeddings for downstream semantic search.

	type ClipDetector interface {
	    // ModelSpec declares the expected input dimensions and trigger labels.
	    ModelSpec() ModelSpec
	    // DetectEmbeddings produces CLIP embeddings for a batch of frames, each
	    // scaled to ModelSpec().Input: normally a trigger region cropped by the
	    // upstream object detector, but the whole scene when no decoded frame is
	    // available. Must return exactly one ClipResult per input frame, in the
	    // same order; use VideoFrameData.Label to tag the emitted embedding.
	    DetectEmbeddings(frames []VideoFrameData) ([]ClipResult, error)
	}

<a name="ClipDetectorSensor"></a>

## type ClipDetectorSensor

ClipDetectorSensor is a frame\-only sensor that generates CLIP embeddings from video frames. Pair with a ClipDetector implementation.

	type ClipDetectorSensor struct{ BaseSensor }

<a name="NewClipDetectorSensor"></a>
### func NewClipDetectorSensor

	func NewClipDetectorSensor(name string, opts ...SensorOption) *ClipDetectorSensor

NewClipDetectorSensor creates a CLIP detector sensor with the given name and options.

<a name="ClipDetectorSensor.GetCategory"></a>
### func \(\*ClipDetectorSensor\) GetCategory

	func (s *ClipDetectorSensor) GetCategory() SensorCategory



<a name="ClipDetectorSensor.GetType"></a>
### func \(\*ClipDetectorSensor\) GetType

	func (s *ClipDetectorSensor) GetType() SensorType



<a name="ClipDetectorSensor.ToJSON"></a>
### func \(\*ClipDetectorSensor\) ToJSON

	func (s *ClipDetectorSensor) ToJSON() sensorJSON



<a name="ClipDetectorSensor.UpdateValue"></a>
### func \(\*ClipDetectorSensor\) UpdateValue

	func (s *ClipDetectorSensor) UpdateValue(property string, value any) error

UpdateValue on a read\-only sensor: external writes are ignored.

<a name="ClipEmbedding"></a>

## type ClipEmbedding

ClipEmbedding is a CLIP embedding result for a detected region.

	type ClipEmbedding struct {
	    Label     string      `msgpack:"label" json:"label"`         // Detection label this embedding was computed for (e.g. "person", "vehicle")
	    Box       BoundingBox `msgpack:"box" json:"box"`             // Bounding box of the detected region in normalized coordinates
	    Embedding []float64   `msgpack:"embedding" json:"embedding"` // CLIP embedding vector
	}

<a name="ClipResult"></a>

## type ClipResult

ClipResult is the return value of ClipDetector.DetectEmbeddings.

	type ClipResult struct {
	    Embeddings     []ClipEmbedding `msgpack:"embeddings" json:"embeddings"`         // Embeddings emitted for this frame
	    EmbeddingModel string          `msgpack:"embeddingModel" json:"embeddingModel"` // Identifier of the embedding model used to produce the vectors
	}

<a name="ClipTextEmbeddingResult"></a>

## type ContactSensor

ContactSensor reports door/window open\-close state.

	type ContactSensor struct{ BaseSensor }

<a name="NewContactSensor"></a>
### func NewContactSensor

	func NewContactSensor(name string, opts ...SensorOption) *ContactSensor

NewContactSensor creates a contact sensor with the given name and options.

<a name="ContactSensor.GetCategory"></a>
### func \(\*ContactSensor\) GetCategory

	func (s *ContactSensor) GetCategory() SensorCategory



<a name="ContactSensor.GetType"></a>
### func \(\*ContactSensor\) GetType

	func (s *ContactSensor) GetType() SensorType



<a name="ContactSensor.IsDetected"></a>
### func \(\*ContactSensor\) IsDetected

	func (s *ContactSensor) IsDetected() bool



<a name="ContactSensor.SetDetected"></a>
### func \(\*ContactSensor\) SetDetected

	func (s *ContactSensor) SetDetected(detected bool)

SetDetected reports contact state \(true = open, false = closed\).

Example:

	contact.SetDetected(true)
	

<a name="ContactSensor.ToJSON"></a>
### func \(\*ContactSensor\) ToJSON

	func (s *ContactSensor) ToJSON() sensorJSON



<a name="ContactSensor.UpdateValue"></a>
### func \(\*ContactSensor\) UpdateValue

	func (s *ContactSensor) UpdateValue(property string, value any) error

UpdateValue on a read\-only sensor: external writes are ignored.

<a name="CoreManager"></a>

## type Detection

Detection is a single detection result emitted by any detection sensor.

	type Detection struct {
	    Label      string       `msgpack:"label" json:"label"`                             // Detection label (e.g. "person", "vehicle")
	    Confidence float64      `msgpack:"confidence" json:"confidence"`                   // Confidence score in the range 0-1
	    Box        *BoundingBox `msgpack:"box,omitempty" json:"box,omitempty"`             // Bounding box in normalized coordinates
	    Attribute  string       `msgpack:"attribute,omitempty" json:"attribute,omitempty"` // Optional sub-detection attribute (face, license_plate, or classifier-specific)
	}

<a name="DetectionAttribute"></a>

## type DetectionAttribute

DetectionAttribute identifies the kind of a sub\-detection \(face, license plate, ...\).

	type DetectionAttribute = string

<a name="DetectionEvent"></a>

## type DetectionLabel

DetectionLabel is a label identifying a type of detection.

	type DetectionLabel = string

<a name="DetectionLine"></a>

## type DoorbellTrigger

DoorbellTrigger fires doorbell ring events.

Plugin authors call Trigger to fire an event. The ring property is set to true and automatically reset to false after ringAutoResetMs.

	type DoorbellTrigger struct {
	    BaseSensor
	    // contains filtered or unexported fields
	}

<a name="NewDoorbellTrigger"></a>
### func NewDoorbellTrigger

	func NewDoorbellTrigger(name string, opts ...SensorOption) *DoorbellTrigger

NewDoorbellTrigger creates a doorbell trigger with the given name and options.

<a name="DoorbellTrigger.GetCategory"></a>
### func \(\*DoorbellTrigger\) GetCategory

	func (s *DoorbellTrigger) GetCategory() SensorCategory



<a name="DoorbellTrigger.GetType"></a>
### func \(\*DoorbellTrigger\) GetType

	func (s *DoorbellTrigger) GetType() SensorType



<a name="DoorbellTrigger.IsRinging"></a>
### func \(\*DoorbellTrigger\) IsRinging

	func (s *DoorbellTrigger) IsRinging() bool



<a name="DoorbellTrigger.ToJSON"></a>
### func \(\*DoorbellTrigger\) ToJSON

	func (s *DoorbellTrigger) ToJSON() sensorJSON



<a name="DoorbellTrigger.Trigger"></a>
### func \(\*DoorbellTrigger\) Trigger

	func (s *DoorbellTrigger) Trigger()

Trigger fires a doorbell ring event. Sets ring to true and auto\-resets after ringAutoResetMs. Re\-triggering while ringing resets the timer \(extends the ring phase\).

Example:

	doorbell.Trigger()
	

<a name="DoorbellTrigger.UpdateValue"></a>
### func \(\*DoorbellTrigger\) UpdateValue

	func (s *DoorbellTrigger) UpdateValue(property string, value any) error

UpdateValue routes generic property writes to the semantic setters. Writing ring=false is ignored, the auto\-reset timer owns the off transition.

<a name="DownloadCleanup"></a>

## type FaceDetection

FaceDetection is a face detection result, extending Detection with face\-specific fields. The Attribute field of the embedded Detection is fixed to "face".

	type FaceDetection struct {
	    Detection
	    Identity  string    `msgpack:"identity,omitempty" json:"identity,omitempty"`   // Recognized identity name, if matched against known faces
	    Embedding []float64 `msgpack:"embedding,omitempty" json:"embedding,omitempty"` // Face embedding vector for recognition/comparison
	    Thumbnail []byte    `msgpack:"thumbnail,omitempty" json:"thumbnail,omitempty"` // JPEG thumbnail crop of the detected face
	}

<a name="FaceDetectionInterface"></a>

## type FaceDetector

FaceDetector is implemented by plugins that perform face detection and recognition.

	type FaceDetector interface {
	    // ModelSpec declares the expected input dimensions and trigger labels. The
	    // runtime scales frames to match.
	    ModelSpec() ModelSpec
	    // DetectFaces analyzes a batch of frames, each scaled to ModelSpec().Input:
	    // normally a person region cropped by the upstream object detector, but the
	    // whole scene when no decoded frame is available. Must return exactly one
	    // FaceResult per input frame, in the same order.
	    DetectFaces(frames []VideoFrameData) ([]FaceResult, error)
	}

<a name="FaceDetectorSensor"></a>

## type FaceDetectorSensor

FaceDetectorSensor is a face sensor that consumes video frames from the backend pipeline. Pair with a FaceDetector implementation.

	type FaceDetectorSensor struct {
	    FaceSensor
	}

<a name="NewFaceDetectorSensor"></a>
### func NewFaceDetectorSensor

	func NewFaceDetectorSensor(name string, opts ...SensorOption) *FaceDetectorSensor

NewFaceDetectorSensor creates a face detector sensor with the given name and options.

<a name="FaceResult"></a>

## type FaceResult

FaceResult is the return value of FaceDetector.DetectFaces.

	type FaceResult struct {
	    Detected   bool            `msgpack:"detected" json:"detected"`     // Whether any face is detected in this frame
	    Detections []FaceDetection `msgpack:"detections" json:"detections"` // Detections emitted for this frame
	}

<a name="FaceSensor"></a>

## type FaceSensor

FaceSensor reports detected faces and optional identity matches.

Plugin authors call ReportDetections to push detected faces. The detected flag is auto\-derived from the detection list.

	type FaceSensor struct{ BaseSensor }

<a name="NewFaceSensor"></a>
### func NewFaceSensor

	func NewFaceSensor(name string, opts ...SensorOption) *FaceSensor

NewFaceSensor creates a face sensor with the given name and options.

<a name="FaceSensor.ClearDetections"></a>
### func \(\*FaceSensor\) ClearDetections

	func (s *FaceSensor) ClearDetections()

ClearDetections explicitly clears face detection state \(detected = false, detections = \[\]\).

<a name="FaceSensor.GetCategory"></a>
### func \(\*FaceSensor\) GetCategory

	func (s *FaceSensor) GetCategory() SensorCategory



<a name="FaceSensor.GetDetections"></a>
### func \(\*FaceSensor\) GetDetections

	func (s *FaceSensor) GetDetections() []FaceDetection



<a name="FaceSensor.GetType"></a>
### func \(\*FaceSensor\) GetType

	func (s *FaceSensor) GetType() SensorType



<a name="FaceSensor.IsDetected"></a>
### func \(\*FaceSensor\) IsDetected

	func (s *FaceSensor) IsDetected() bool



<a name="FaceSensor.ReportDetections"></a>
### func \(\*FaceSensor\) ReportDetections

	func (s *FaceSensor) ReportDetections(detected bool, detections []FaceDetection)

ReportDetections reports detected faces.

- ReportDetections\(true, nil\): face detected without specifics. The SDK synthesizes a single full\-frame face detection without identity.
- ReportDetections\(true, \[...\]\): explicit face detections with identity, embedding, and/or thumbnail.
- ReportDetections\(false, nil\): clear.

Example:

	sensor.ReportDetections(true, []FaceDetection{
	    {Detection: Detection{Label: "person", Confidence: 0.94, Box: &BoundingBox{X: 0.4, Y: 0.2, Width: 0.15, Height: 0.25}, Attribute: "face"}, Identity: "Alice"},
	})
	sensor.ReportDetections(false, nil)
	

<a name="FaceSensor.ToJSON"></a>
### func \(\*FaceSensor\) ToJSON

	func (s *FaceSensor) ToJSON() sensorJSON



<a name="FaceSensor.UpdateValue"></a>
### func \(\*FaceSensor\) UpdateValue

	func (s *FaceSensor) UpdateValue(property string, value any) error

UpdateValue on a read\-only sensor: external writes are ignored.

<a name="FormSubmitResponse"></a>

## type GarageControl

GarageControl is a garage door control sensor. Override SetTargetState \(by embedding GarageControl in your own type and shadowing the method\) to drive hardware and call the embedded GarageControl's SetTargetState once the hardware confirms: the base implementation updates both targetState and currentState.

For long\-running transitions \(Opening/Closing intermediate states\) override SetTargetState and write currentState separately as the door moves.

	type GarageControl struct{ BaseSensor }

<a name="NewGarageControl"></a>
### func NewGarageControl

	func NewGarageControl(name string, opts ...SensorOption) *GarageControl

NewGarageControl creates a garage door control with the given name and options.

<a name="GarageControl.GetCategory"></a>
### func \(\*GarageControl\) GetCategory

	func (s *GarageControl) GetCategory() SensorCategory



<a name="GarageControl.GetCurrentState"></a>
### func \(\*GarageControl\) GetCurrentState

	func (s *GarageControl) GetCurrentState() GarageState



<a name="GarageControl.GetTargetState"></a>
### func \(\*GarageControl\) GetTargetState

	func (s *GarageControl) GetTargetState() GarageState



<a name="GarageControl.GetType"></a>
### func \(\*GarageControl\) GetType

	func (s *GarageControl) GetType() SensorType



<a name="GarageControl.IsObstructionDetected"></a>
### func \(\*GarageControl\) IsObstructionDetected

	func (s *GarageControl) IsObstructionDetected() bool



<a name="GarageControl.SetCurrentState"></a>
### func \(\*GarageControl\) SetCurrentState

	func (s *GarageControl) SetCurrentState(value GarageState)

SetCurrentState publishes the actual door state. Use this to drive long\-running transitions \(Open, then Closing, then Closed\) independently of the user\-requested target state. Read\-only from cross\-process consumers, UpdateValue ignores it.

Example:

	garage.SetCurrentState(GarageStateClosing)
	

<a name="GarageControl.SetObstructionDetected"></a>
### func \(\*GarageControl\) SetObstructionDetected

	func (s *GarageControl) SetObstructionDetected(detected bool)

SetObstructionDetected publishes the obstruction\-detected state. Read\-only from cross\-process consumers, UpdateValue ignores it.

Example:

	garage.SetObstructionDetected(true)
	

<a name="GarageControl.SetTargetState"></a>
### func \(\*GarageControl\) SetTargetState

	func (s *GarageControl) SetTargetState(value GarageState)

SetTargetState sets the target state. Writes both targetState and currentState.

Example:

	garage.SetTargetState(GarageStateOpen)
	

<a name="GarageControl.ToJSON"></a>
### func \(\*GarageControl\) ToJSON

	func (s *GarageControl) ToJSON() sensorJSON



<a name="GarageControl.UpdateValue"></a>
### func \(\*GarageControl\) UpdateValue

	func (s *GarageControl) UpdateValue(property string, value any) error

UpdateValue routes generic property writes to the semantic setters. Only targetState is externally writable.

<a name="GarageState"></a>

## type GarageState

GarageState defines garage door states.

	type GarageState int

<a name="GarageStateOpen"></a>

	const (
	    GarageStateOpen    GarageState = 0 // Door is fully open
	    GarageStateClosed  GarageState = 1 // Door is fully closed
	    GarageStateOpening GarageState = 2 // Door is moving towards open
	    GarageStateClosing GarageState = 3 // Door is moving towards closed
	    GarageStateStopped GarageState = 4 // Door stopped part-way
	)

<a name="Go2RtcRTSPSource"></a>

## type HumidityInfo

HumidityInfo reports current relative humidity \(0\-100%\).

	type HumidityInfo struct{ BaseSensor }

<a name="NewHumidityInfo"></a>
### func NewHumidityInfo

	func NewHumidityInfo(name string, opts ...SensorOption) *HumidityInfo



<a name="HumidityInfo.GetCategory"></a>
### func \(\*HumidityInfo\) GetCategory

	func (s *HumidityInfo) GetCategory() SensorCategory



<a name="HumidityInfo.GetCurrent"></a>
### func \(\*HumidityInfo\) GetCurrent

	func (s *HumidityInfo) GetCurrent() float64



<a name="HumidityInfo.GetType"></a>
### func \(\*HumidityInfo\) GetType

	func (s *HumidityInfo) GetType() SensorType



<a name="HumidityInfo.SetCurrent"></a>
### func \(\*HumidityInfo\) SetCurrent

	func (s *HumidityInfo) SetCurrent(value float64)

SetCurrent sets the current relative humidity \(clamped to \[0,100\]\).

Example:

	humidity.SetCurrent(63)
	

<a name="HumidityInfo.ToJSON"></a>
### func \(\*HumidityInfo\) ToJSON

	func (s *HumidityInfo) ToJSON() sensorJSON



<a name="HumidityInfo.UpdateValue"></a>
### func \(\*HumidityInfo\) UpdateValue

	func (s *HumidityInfo) UpdateValue(property string, value any) error

UpdateValue on a read\-only sensor: external writes are ignored.

<a name="ImageMetadata"></a>

## type LeakSensor

LeakSensor reports water leak detection state.

	type LeakSensor struct{ BaseSensor }

<a name="NewLeakSensor"></a>
### func NewLeakSensor

	func NewLeakSensor(name string, opts ...SensorOption) *LeakSensor



<a name="LeakSensor.GetCategory"></a>
### func \(\*LeakSensor\) GetCategory

	func (s *LeakSensor) GetCategory() SensorCategory



<a name="LeakSensor.GetType"></a>
### func \(\*LeakSensor\) GetType

	func (s *LeakSensor) GetType() SensorType



<a name="LeakSensor.IsDetected"></a>
### func \(\*LeakSensor\) IsDetected

	func (s *LeakSensor) IsDetected() bool



<a name="LeakSensor.SetDetected"></a>
### func \(\*LeakSensor\) SetDetected

	func (s *LeakSensor) SetDetected(detected bool)

SetDetected reports leak detection state \(true when a water leak is currently detected\).

Example:

	leak.SetDetected(true)
	

<a name="LeakSensor.ToJSON"></a>
### func \(\*LeakSensor\) ToJSON

	func (s *LeakSensor) ToJSON() sensorJSON



<a name="LeakSensor.UpdateValue"></a>
### func \(\*LeakSensor\) UpdateValue

	func (s *LeakSensor) UpdateValue(property string, value any) error

UpdateValue on a read\-only sensor: external writes are ignored.

<a name="LicensePlateDetection"></a>

## type LicensePlateDetection

LicensePlateDetection is a license plate detection result, extending Detection with OCR fields. The Attribute field of the embedded Detection is fixed to "license\_plate".

	type LicensePlateDetection struct {
	    Detection
	    PlateText     string  `msgpack:"plateText" json:"plateText"`                             // Recognized plate text (e.g. "ABC 1234")
	    OcrConfidence float64 `msgpack:"ocrConfidence,omitempty" json:"ocrConfidence,omitempty"` // Average text recognition confidence (0-1), separate from the box confidence
	}

<a name="LicensePlateDetectionInterface"></a>

## type LicensePlateDetector

LicensePlateDetector is implemented by plugins that perform license plate detection and OCR.

	type LicensePlateDetector interface {
	    // ModelSpec declares the expected input dimensions and trigger labels. The
	    // runtime scales frames to match.
	    ModelSpec() ModelSpec
	    // DetectLicensePlates analyzes a batch of frames pre-scaled to the ModelSpec
	    // input: normally a vehicle region cropped by the upstream object detector,
	    // but the whole scene when no decoded frame is available. Must return exactly
	    // one result per input frame, in the same order.
	    DetectLicensePlates(frames []VideoFrameData) ([]LicensePlateResult, error)
	}

<a name="LicensePlateDetectorSensor"></a>

## type LicensePlateDetectorSensor

LicensePlateDetectorSensor is a license plate sensor that consumes video frames from the backend pipeline. Pair with a LicensePlateDetector implementation.

	type LicensePlateDetectorSensor struct {
	    LicensePlateSensor
	}

<a name="NewLicensePlateDetectorSensor"></a>
### func NewLicensePlateDetectorSensor

	func NewLicensePlateDetectorSensor(name string, opts ...SensorOption) *LicensePlateDetectorSensor



<a name="LicensePlateResult"></a>

## type LicensePlateResult

LicensePlateResult is the return value of LicensePlateDetector.DetectLicensePlates.

	type LicensePlateResult struct {
	    Detected   bool                    `msgpack:"detected" json:"detected"`     // Whether any license plate is detected in this frame
	    Detections []LicensePlateDetection `msgpack:"detections" json:"detections"` // Detections emitted for this frame
	}

<a name="LicensePlateSensor"></a>

## type LicensePlateSensor

LicensePlateSensor reports detected license plates and OCR results.

Plugin authors call ReportDetections to push detected plates. The detected flag is auto\-derived from the detection list.

	type LicensePlateSensor struct{ BaseSensor }

<a name="NewLicensePlateSensor"></a>
### func NewLicensePlateSensor

	func NewLicensePlateSensor(name string, opts ...SensorOption) *LicensePlateSensor



<a name="LicensePlateSensor.ClearDetections"></a>
### func \(\*LicensePlateSensor\) ClearDetections

	func (s *LicensePlateSensor) ClearDetections()

ClearDetections explicitly clears license plate state \(detected = false, detections = \[\]\).

<a name="LicensePlateSensor.GetCategory"></a>
### func \(\*LicensePlateSensor\) GetCategory

	func (s *LicensePlateSensor) GetCategory() SensorCategory



<a name="LicensePlateSensor.GetDetections"></a>
### func \(\*LicensePlateSensor\) GetDetections

	func (s *LicensePlateSensor) GetDetections() []LicensePlateDetection



<a name="LicensePlateSensor.GetType"></a>
### func \(\*LicensePlateSensor\) GetType

	func (s *LicensePlateSensor) GetType() SensorType



<a name="LicensePlateSensor.IsDetected"></a>
### func \(\*LicensePlateSensor\) IsDetected

	func (s *LicensePlateSensor) IsDetected() bool



<a name="LicensePlateSensor.ReportDetections"></a>
### func \(\*LicensePlateSensor\) ReportDetections

	func (s *LicensePlateSensor) ReportDetections(detected bool, detections []LicensePlateDetection)

ReportDetections reports detected license plates.

- ReportDetections\(true, nil\): plate detected without specifics, the SDK synthesizes a single full\-frame detection with empty plateText.
- ReportDetections\(true, \[...\]\): explicit plate detections with OCR text.
- ReportDetections\(false, nil\): clear.

Example:

	sensor.ReportDetections(true, []LicensePlateDetection{
	    {Detection: Detection{Label: "vehicle", Confidence: 0.93, Box: &BoundingBox{X: 0.2, Y: 0.5, Width: 0.2, Height: 0.08}, Attribute: "license_plate"}, PlateText: "ABC 1234"},
	})
	sensor.ReportDetections(false, nil)
	

<a name="LicensePlateSensor.ToJSON"></a>
### func \(\*LicensePlateSensor\) ToJSON

	func (s *LicensePlateSensor) ToJSON() sensorJSON



<a name="LicensePlateSensor.UpdateValue"></a>
### func \(\*LicensePlateSensor\) UpdateValue

	func (s *LicensePlateSensor) UpdateValue(property string, value any) error

UpdateValue on a read\-only sensor: external writes are ignored.

<a name="LightControl"></a>

## type LightControl

LightControl is a light on/off and brightness control sensor. Override SetOn / SetOff \(by embedding LightControl in your own type and shadowing the methods\) to drive your hardware, then call the embedded LightControl's methods to sync the SDK state.

Plugins with no hardware\-action use case can leave the methods unoverridden, the base implementation just updates the state.

For hardware\-pushed updates \(someone manually flipped the switch\), call the embedded LightControl's SetOn / SetOff directly from your event handler. That bypasses any plugin override and only syncs state.

	type LightControl struct{ BaseSensor }

<a name="NewLightControl"></a>
### func NewLightControl

	func NewLightControl(name string, opts ...SensorOption) *LightControl



<a name="LightControl.GetBrightness"></a>
### func \(\*LightControl\) GetBrightness

	func (s *LightControl) GetBrightness() int



<a name="LightControl.GetCategory"></a>
### func \(\*LightControl\) GetCategory

	func (s *LightControl) GetCategory() SensorCategory



<a name="LightControl.GetType"></a>
### func \(\*LightControl\) GetType

	func (s *LightControl) GetType() SensorType



<a name="LightControl.IsOn"></a>
### func \(\*LightControl\) IsOn

	func (s *LightControl) IsOn() bool



<a name="LightControl.SetBrightness"></a>
### func \(\*LightControl\) SetBrightness

	func (s *LightControl) SetBrightness(value int)

SetBrightness sets the brightness level \(clamped to \[0, 100\]\). Override \(via embedding\) to drive hardware and call the embedded LightControl's SetBrightness to sync the SDK state.

Example:

	light.SetBrightness(75)
	

<a name="LightControl.SetOff"></a>
### func \(\*LightControl\) SetOff

	func (s *LightControl) SetOff()

SetOff turns the light off. Override \(via embedding\) to drive hardware and call the embedded LightControl's SetOff to sync the SDK state.

Example:

	light.SetOff()
	

<a name="LightControl.SetOn"></a>
### func \(\*LightControl\) SetOn

	func (s *LightControl) SetOn()

SetOn turns the light on. Override \(via embedding\) to drive hardware and call the embedded LightControl's SetOn to sync the SDK state.

Example:

	light.SetOn()
	

<a name="LightControl.ToJSON"></a>
### func \(\*LightControl\) ToJSON

	func (s *LightControl) ToJSON() sensorJSON



<a name="LightControl.UpdateValue"></a>
### func \(\*LightControl\) UpdateValue

	func (s *LightControl) UpdateValue(property string, value any) error

UpdateValue routes generic property writes to the semantic setters. Only on and brightness are externally writable.

<a name="LineDirection"></a>

## type LockControl

LockControl is a lock/unlock control sensor. Override SetTargetState \(by embedding LockControl in your own type and shadowing the method\) to drive hardware and call the embedded LockControl's SetTargetState once the hardware confirms. The base implementation updates both targetState and currentState to the new value.

For asymmetric flows \(long\-running unlock with intermediate state\) override SetTargetState and write currentState separately when transitions complete.

	type LockControl struct{ BaseSensor }

<a name="NewLockControl"></a>
### func NewLockControl

	func NewLockControl(name string, opts ...SensorOption) *LockControl



<a name="LockControl.GetCategory"></a>
### func \(\*LockControl\) GetCategory

	func (s *LockControl) GetCategory() SensorCategory



<a name="LockControl.GetCurrentState"></a>
### func \(\*LockControl\) GetCurrentState

	func (s *LockControl) GetCurrentState() LockState



<a name="LockControl.GetTargetState"></a>
### func \(\*LockControl\) GetTargetState

	func (s *LockControl) GetTargetState() LockState



<a name="LockControl.GetType"></a>
### func \(\*LockControl\) GetType

	func (s *LockControl) GetType() SensorType



<a name="LockControl.SetCurrentState"></a>
### func \(\*LockControl\) SetCurrentState

	func (s *LockControl) SetCurrentState(value LockState)

SetCurrentState publishes the actual lock state. Use it when the physical state diverges from the requested target: motorized locks that take time to rotate \(publish LockStateUnknown while moving\), or hardware reporting an out\-of\-band state change. Read\-only from cross\-process consumers \(UpdateValue ignores it\).

Example:

	lock.SetCurrentState(LockStateUnknown)
	

<a name="LockControl.SetTargetState"></a>
### func \(\*LockControl\) SetTargetState

	func (s *LockControl) SetTargetState(value LockState)

SetTargetState sets the target lock state. Writes both targetState and currentState.

Example:

	lock.SetTargetState(LockStateSecured)
	

<a name="LockControl.ToJSON"></a>
### func \(\*LockControl\) ToJSON

	func (s *LockControl) ToJSON() sensorJSON



<a name="LockControl.UpdateValue"></a>
### func \(\*LockControl\) UpdateValue

	func (s *LockControl) UpdateValue(property string, value any) error

UpdateValue routes generic property writes to the semantic setters. Only targetState is externally writable, currentState is observed\-only.

<a name="LockState"></a>

## type LockState

LockState defines lock states.

	type LockState int

<a name="LockStateSecured"></a>

	const (
	    LockStateSecured   LockState = 0 // Locked
	    LockStateUnsecured LockState = 1 // Unlocked
	    LockStateUnknown   LockState = 2 // State cannot be determined, e.g. while a motorized lock is moving
	)

<a name="Logger"></a>

## type ModelSpec

ModelSpec describes a detection model with fixed output labels \(face, classifier, license plate\). It declares the input shape the backend should produce and the trigger labels that should activate this detector.

	type ModelSpec struct {
	    Input          VideoInputSpec `msgpack:"input" json:"input"`                                       // Required input frame dimensions and pixel format
	    TriggerLabels  []string       `msgpack:"triggerLabels" json:"triggerLabels"`                       // Labels emitted by an upstream object detector that activate this detector
	    EmbeddingModel string         `msgpack:"embeddingModel,omitempty" json:"embeddingModel,omitempty"` // Embedding model identifier, required for face recognition and CLIP: embeddings are stored and matched under this id
	}

<a name="MotionDetectionInterface"></a>

## type MotionDetector

MotionDetector is implemented by plugins that analyze video frames for motion. The runtime calls DetectMotion at the configured frame interval, zone\-filters the returned detections and applies them to the associated MotionSensor. Detected is re\-derived from the surviving detections, so a result with no detections reports no motion.

	type MotionDetector interface {
	    // DetectMotion analyzes a single video frame and returns the motion result.
	    DetectMotion(frame VideoFrameData) (*MotionResult, error)
	}

<a name="MotionDetectorSensor"></a>

## type MotionDetectorSensor

MotionDetectorSensor is a motion sensor that consumes video frames from the backend pipeline. Pair with a MotionDetector implementation; the backend invokes the detector at the configured frame interval and forwards results to this sensor.

	type MotionDetectorSensor struct {
	    MotionSensor
	}

<a name="NewMotionDetectorSensor"></a>
### func NewMotionDetectorSensor

	func NewMotionDetectorSensor(name string, opts ...SensorOption) *MotionDetectorSensor



<a name="MotionResolution"></a>

## type MotionResult

MotionResult is the return value of MotionDetector.DetectMotion.

	type MotionResult struct {
	    Detected   bool        `msgpack:"detected" json:"detected"`     // Whether motion is detected in this frame. Ignored by the backend, which re-derives it from the detections
	    Detections []Detection `msgpack:"detections" json:"detections"` // Detections emitted for this frame
	}

<a name="MotionSensor"></a>

## type MotionSensor

MotionSensor reports motion state and detection results.

Plugin authors call ReportDetections to push detection results. The detected flag is auto\-derived from the detection list. The blocked flag is read\-only and set by the backend dwell logic, ReportDetections is a no\-op while it is set.

	type MotionSensor struct {
	    BaseSensor
	}

<a name="NewMotionSensor"></a>
### func NewMotionSensor

	func NewMotionSensor(name string, opts ...SensorOption) *MotionSensor



<a name="MotionSensor.ClearDetections"></a>
### func \(\*MotionSensor\) ClearDetections

	func (s *MotionSensor) ClearDetections()

ClearDetections explicitly clears motion state \(detected = false, detections = \[\]\).

<a name="MotionSensor.GetCategory"></a>
### func \(\*MotionSensor\) GetCategory

	func (s *MotionSensor) GetCategory() SensorCategory



<a name="MotionSensor.GetDetections"></a>
### func \(\*MotionSensor\) GetDetections

	func (s *MotionSensor) GetDetections() []Detection



<a name="MotionSensor.GetType"></a>
### func \(\*MotionSensor\) GetType

	func (s *MotionSensor) GetType() SensorType



<a name="MotionSensor.IsBlocked"></a>
### func \(\*MotionSensor\) IsBlocked

	func (s *MotionSensor) IsBlocked() bool



<a name="MotionSensor.IsDetected"></a>
### func \(\*MotionSensor\) IsDetected

	func (s *MotionSensor) IsDetected() bool



<a name="MotionSensor.ReportDetections"></a>
### func \(\*MotionSensor\) ReportDetections

	func (s *MotionSensor) ReportDetections(detected bool, detections []Detection)

ReportDetections reports a motion detection result.

- ReportDetections\(true, nil\): motion detected without bounding box. The SDK synthesizes a single full\-frame "motion" detection.
- ReportDetections\(true, \[...\]\): motion detected with explicit detections.
- ReportDetections\(false, nil\): no motion \(clears detections\).

No\-op while the sensor is blocked by the backend dwell logic.

Example:

	sensor.ReportDetections(true, []Detection{
	    {Label: "motion", Confidence: 0.85, Box: &BoundingBox{X: 0.1, Y: 0.2, Width: 0.3, Height: 0.4}},
	})
	sensor.ReportDetections(false, nil)
	

<a name="MotionSensor.ToJSON"></a>
### func \(\*MotionSensor\) ToJSON

	func (s *MotionSensor) ToJSON() sensorJSON



<a name="MotionSensor.UpdateValue"></a>
### func \(\*MotionSensor\) UpdateValue

	func (s *MotionSensor) UpdateValue(property string, value any) error

UpdateValue on a read\-only sensor: external writes are ignored.

<a name="Notification"></a>

## type ObjectDetector

ObjectDetector is implemented by plugins that detect objects in video frames. The runtime scales frames to match ModelSpec before each call.

	type ObjectDetector interface {
	    // ModelSpec declares the expected input dimensions.
	    ModelSpec() ObjectModelSpec
	    // DetectObjects analyzes a single video frame and returns the object result.
	    DetectObjects(frame VideoFrameData) (*ObjectResult, error)
	}

<a name="ObjectDetectorSensor"></a>

## type ObjectDetectorSensor

ObjectDetectorSensor is an object sensor that consumes video frames from the backend pipeline. Pair with an ObjectDetector implementation.

	type ObjectDetectorSensor struct {
	    ObjectSensor
	}

<a name="NewObjectDetectorSensor"></a>
### func NewObjectDetectorSensor

	func NewObjectDetectorSensor(name string, opts ...SensorOption) *ObjectDetectorSensor



<a name="ObjectModelSpec"></a>

## type ObjectModelSpec

ObjectModelSpec describes an object detection model. Only declares input dimensions, the output label set is dynamic and comes from the model itself.

	type ObjectModelSpec struct {
	    Input VideoInputSpec `msgpack:"input" json:"input"` // Required input frame dimensions and pixel format
	}

<a name="ObjectResult"></a>

## type ObjectResult

ObjectResult is the return value of ObjectDetector.DetectObjects.

	type ObjectResult struct {
	    Detected   bool               `msgpack:"detected" json:"detected"`     // Whether any object is detected in this frame
	    Detections []TrackedDetection `msgpack:"detections" json:"detections"` // Detections emitted for this frame
	}

<a name="ObjectSensor"></a>

## type ObjectSensor

ObjectSensor reports detected objects \(person, vehicle, animal, etc.\).

Plugin authors call ReportDetections to push detection results. The detected flag and the labels are auto\-derived from the detection list.

	type ObjectSensor struct {
	    BaseSensor
	}

<a name="NewObjectSensor"></a>
### func NewObjectSensor

	func NewObjectSensor(name string, opts ...SensorOption) *ObjectSensor



<a name="ObjectSensor.ClearDetections"></a>
### func \(\*ObjectSensor\) ClearDetections

	func (s *ObjectSensor) ClearDetections()

ClearDetections explicitly clears detection state \(detected = false, detections = \[\], labels = \[\]\).

<a name="ObjectSensor.GetCategory"></a>
### func \(\*ObjectSensor\) GetCategory

	func (s *ObjectSensor) GetCategory() SensorCategory



<a name="ObjectSensor.GetDetections"></a>
### func \(\*ObjectSensor\) GetDetections

	func (s *ObjectSensor) GetDetections() []TrackedDetection



<a name="ObjectSensor.GetLabels"></a>
### func \(\*ObjectSensor\) GetLabels

	func (s *ObjectSensor) GetLabels() []string



<a name="ObjectSensor.GetType"></a>
### func \(\*ObjectSensor\) GetType

	func (s *ObjectSensor) GetType() SensorType



<a name="ObjectSensor.IsDetected"></a>
### func \(\*ObjectSensor\) IsDetected

	func (s *ObjectSensor) IsDetected() bool



<a name="ObjectSensor.ReportDetections"></a>
### func \(\*ObjectSensor\) ReportDetections

	func (s *ObjectSensor) ReportDetections(detected bool, detections []TrackedDetection)

ReportDetections reports detected objects. The detected flag and the labels are auto\-derived from the detection list.

- ReportDetections\(true, nil\): generic trigger, synthesizes a single full\-frame "motion" detection as a fallback.
- ReportDetections\(true, \[...\]\): explicit detections.
- ReportDetections\(false, nil\): clear.

Example:

	sensor.ReportDetections(true, []TrackedDetection{
	    {Detection: Detection{Label: "person", Confidence: 0.92, Box: &BoundingBox{X: 0.1, Y: 0.2, Width: 0.3, Height: 0.4}}},
	})
	sensor.ReportDetections(false, nil)
	

<a name="ObjectSensor.ToJSON"></a>
### func \(\*ObjectSensor\) ToJSON

	func (s *ObjectSensor) ToJSON() sensorJSON



<a name="ObjectSensor.UpdateValue"></a>
### func \(\*ObjectSensor\) UpdateValue

	func (s *ObjectSensor) UpdateValue(property string, value any) error

UpdateValue on a read\-only sensor: external writes are ignored.

<a name="Observable"></a>

## type OccupancySensor

OccupancySensor reports occupancy/presence state.

	type OccupancySensor struct{ BaseSensor }

<a name="NewOccupancySensor"></a>
### func NewOccupancySensor

	func NewOccupancySensor(name string, opts ...SensorOption) *OccupancySensor



<a name="OccupancySensor.GetCategory"></a>
### func \(\*OccupancySensor\) GetCategory

	func (s *OccupancySensor) GetCategory() SensorCategory



<a name="OccupancySensor.GetType"></a>
### func \(\*OccupancySensor\) GetType

	func (s *OccupancySensor) GetType() SensorType



<a name="OccupancySensor.IsDetected"></a>
### func \(\*OccupancySensor\) IsDetected

	func (s *OccupancySensor) IsDetected() bool



<a name="OccupancySensor.SetDetected"></a>
### func \(\*OccupancySensor\) SetDetected

	func (s *OccupancySensor) SetDetected(detected bool)

SetDetected reports occupancy state \(true when the area is currently occupied\).

Example:

	occupancy.SetDetected(true)
	

<a name="OccupancySensor.ToJSON"></a>
### func \(\*OccupancySensor\) ToJSON

	func (s *OccupancySensor) ToJSON() sensorJSON



<a name="OccupancySensor.UpdateValue"></a>
### func \(\*OccupancySensor\) UpdateValue

	func (s *OccupancySensor) UpdateValue(property string, value any) error

UpdateValue on a read\-only sensor: external writes are ignored.

<a name="PTZCapability"></a>

## type PTZControl

PTZControl is a pan\-tilt\-zoom camera control sensor. Override SetPosition / SetVelocity / SetTargetPreset \(by embedding PTZControl in your own type and shadowing the methods\) to drive hardware, then call the corresponding embedded method after success to sync the SDK state. For hardware\-pushed state updates \(e.g. PTZ position change events\), call the embedded methods directly from your event handler. That bypasses any plugin override and only syncs state.

Set capabilities to advertise supported axes and features. Use SetPresets to publish the discovered preset list and SetMoving to publish movement state.

	type PTZControl struct{ BaseSensor }

<a name="NewPTZControl"></a>
### func NewPTZControl

	func NewPTZControl(name string, opts ...SensorOption) *PTZControl



<a name="PTZControl.GetCategory"></a>
### func \(\*PTZControl\) GetCategory

	func (s *PTZControl) GetCategory() SensorCategory



<a name="PTZControl.GetPosition"></a>
### func \(\*PTZControl\) GetPosition

	func (s *PTZControl) GetPosition() PTZPosition



<a name="PTZControl.GetPresets"></a>
### func \(\*PTZControl\) GetPresets

	func (s *PTZControl) GetPresets() []string



<a name="PTZControl.GetTargetPreset"></a>
### func \(\*PTZControl\) GetTargetPreset

	func (s *PTZControl) GetTargetPreset() (string, bool)



<a name="PTZControl.GetType"></a>
### func \(\*PTZControl\) GetType

	func (s *PTZControl) GetType() SensorType



<a name="PTZControl.GetVelocity"></a>
### func \(\*PTZControl\) GetVelocity

	func (s *PTZControl) GetVelocity() (PTZDirection, bool)



<a name="PTZControl.GoHome"></a>
### func \(\*PTZControl\) GoHome

	func (s *PTZControl) GoHome()

GoHome moves the PTZ to the home position \(0, 0, 0\). To drive a hardware home command, shadow UpdateValue and handle "home" there: UpdateValue calls the embedded GoHome, so shadowing GoHome alone is never reached.

Example:

	ptz.GoHome()
	

<a name="PTZControl.IsMoving"></a>
### func \(\*PTZControl\) IsMoving

	func (s *PTZControl) IsMoving() bool



<a name="PTZControl.SetMoving"></a>
### func \(\*PTZControl\) SetMoving

	func (s *PTZControl) SetMoving(value bool)

SetMoving publishes the movement state.

Example:

	ptz.SetMoving(true)
	

<a name="PTZControl.SetPosition"></a>
### func \(\*PTZControl\) SetPosition

	func (s *PTZControl) SetPosition(value PTZPosition)

SetPosition sets the absolute PTZ position.

Example:

	ptz.SetPosition(PTZPosition{Pan: 0.25, Tilt: -0.1, Zoom: 0.5})
	

<a name="PTZControl.SetPresets"></a>
### func \(\*PTZControl\) SetPresets

	func (s *PTZControl) SetPresets(value []string)

SetPresets publishes the discovered preset list. The preset list stays empty until this runs.

Example:

	ptz.SetPresets([]string{"Home", "Driveway", "Backyard"})
	

<a name="PTZControl.SetRelativeMove"></a>
### func \(\*PTZControl\) SetRelativeMove

	func (s *PTZControl) SetRelativeMove(value PTZRelativeMove)

SetRelativeMove issues a relative displacement move. Shadow this method to drive hardware \(e.g. ONVIF RelativeMove in a translation space\) and call the embedded method after success to sync the SDK state. Advertise PTZCapabilityRelativeMove when the camera supports it.

Example:

	// move the view a third of a frame to the right, a tenth down
	ptz.SetRelativeMove(PTZRelativeMove{PanDelta: 0.33, TiltDelta: -0.1, ZoomDelta: 0})
	

<a name="PTZControl.SetTargetPreset"></a>
### func \(\*PTZControl\) SetTargetPreset

	func (s *PTZControl) SetTargetPreset(value string)

SetTargetPreset sets the target preset ID. The property is unset until this runs.

Example:

	ptz.SetTargetPreset("Driveway")
	

<a name="PTZControl.SetVelocity"></a>
### func \(\*PTZControl\) SetVelocity

	func (s *PTZControl) SetVelocity(value PTZDirection)

SetVelocity sets the continuous\-move velocity. The velocity property is unset until the first continuous move is issued.

Example:

	ptz.SetVelocity(PTZDirection{PanSpeed: 0.5, TiltSpeed: 0, ZoomSpeed: 0})
	ptz.SetVelocity(PTZDirection{}) // stop
	

<a name="PTZControl.ToJSON"></a>
### func \(\*PTZControl\) ToJSON

	func (s *PTZControl) ToJSON() sensorJSON



<a name="PTZControl.UpdateValue"></a>
### func \(\*PTZControl\) UpdateValue

	func (s *PTZControl) UpdateValue(property string, value any) error

UpdateValue routes generic property writes to the semantic setters.

<a name="PTZDirection"></a>

## type SecuritySystem

SecuritySystem is a security system arm/disarm control sensor.

	type SecuritySystem struct{ BaseSensor }

<a name="NewSecuritySystem"></a>
### func NewSecuritySystem

	func NewSecuritySystem(name string, opts ...SensorOption) *SecuritySystem



<a name="SecuritySystem.GetCategory"></a>
### func \(\*SecuritySystem\) GetCategory

	func (s *SecuritySystem) GetCategory() SensorCategory



<a name="SecuritySystem.GetCurrentState"></a>
### func \(\*SecuritySystem\) GetCurrentState

	func (s *SecuritySystem) GetCurrentState() SecuritySystemState



<a name="SecuritySystem.GetTargetState"></a>
### func \(\*SecuritySystem\) GetTargetState

	func (s *SecuritySystem) GetTargetState() SecuritySystemState



<a name="SecuritySystem.GetType"></a>
### func \(\*SecuritySystem\) GetType

	func (s *SecuritySystem) GetType() SensorType



<a name="SecuritySystem.SetCurrentState"></a>
### func \(\*SecuritySystem\) SetCurrentState

	func (s *SecuritySystem) SetCurrentState(value SecuritySystemState)

SetCurrentState publishes the actual security system state. Use this for transitions that diverge from the user\-requested target: AlarmTriggered when an intruder is detected, or arming\-delay intermediate states. Read\-only from cross\-process consumers \(UpdateValue ignores it\).

Example:

	alarm.SetCurrentState(SecuritySystemStateAlarmTriggered)
	

<a name="SecuritySystem.SetTargetState"></a>
### func \(\*SecuritySystem\) SetTargetState

	func (s *SecuritySystem) SetTargetState(value SecuritySystemState)

SetTargetState sets the target state. Writes both targetState and currentState. The target state is never SecuritySystemStateAlarmTriggered, publish that through SetCurrentState.

Example:

	alarm.SetTargetState(SecuritySystemStateAwayArm)
	

<a name="SecuritySystem.ToJSON"></a>
### func \(\*SecuritySystem\) ToJSON

	func (s *SecuritySystem) ToJSON() sensorJSON



<a name="SecuritySystem.UpdateValue"></a>
### func \(\*SecuritySystem\) UpdateValue

	func (s *SecuritySystem) UpdateValue(property string, value any) error

UpdateValue routes generic property writes to the semantic setters.

<a name="SecuritySystemState"></a>

## type SecuritySystemState

SecuritySystemState defines security system states.

	type SecuritySystemState int

<a name="SecuritySystemStateStayArm"></a>

	const (
	    SecuritySystemStateStayArm        SecuritySystemState = 0 // Armed, occupants home
	    SecuritySystemStateAwayArm        SecuritySystemState = 1 // Armed, occupants away
	    SecuritySystemStateNightArm       SecuritySystemState = 2 // Armed for night mode
	    SecuritySystemStateDisarmed       SecuritySystemState = 3 // System disarmed
	    SecuritySystemStateAlarmTriggered SecuritySystemState = 4 // Alarm is triggered
	)

<a name="Sensor"></a>

## type Sensor

Sensor is the interface all sensors must implement.

State\-modifying methods \(SetOn, ReportDetections, etc.\) live on the concrete sensor types, not on Sensor. Code that holds a Sensor reference can read state and observe changes, plus invoke UpdateValue for cross\-process generic property writes.

	type Sensor interface {
	    GetID() string
	    GetType() SensorType
	    GetCategory() SensorCategory
	    GetName() string
	    GetDisplayName() string
	    SetDisplayName(name string)
	    GetNativeID() string
	    GetPluginID() string
	    GetAssignedCameraIDs() []string
	    Connected() bool
	    GetCapabilities() []string
	    // SetCapabilities replaces the advertised feature flags.
	    SetCapabilities(caps []string)
	    // HasCapability reports whether the sensor advertises a capability.
	    HasCapability(cap string) bool
	    // GetValue returns the current value of a sensor property.
	    GetValue(property string) any
	    // GetValues returns a snapshot copy of all property values.
	    GetValues() map[string]any
	    // UpdateValue is the generic property write coming from a consumer. Concrete
	    // sensor types dispatch known properties to semantic methods (SetOn,
	    // SetTargetState) so plugin-side hardware overrides run. Read-only sensors
	    // implement it as a no-op. Plugin authors call the semantic methods instead.
	    UpdateValue(property string, value any) error
	    // OnPropertyChanged fires on every property change.
	    OnPropertyChanged(callback func(SensorPropertyChange)) *Disposable
	    // OnCapabilitiesChanged fires with the full capability list whenever it changes.
	    OnCapabilitiesChanged(callback func([]string)) *Disposable
	    // OnAssignmentChanged fires with the current camera id list whenever the
	    // user changes this sensor's camera assignments.
	    OnAssignmentChanged(callback func([]string)) *Disposable
	    // OnConnectedChanged fires when the owning plugin's connectivity changes.
	    OnConnectedChanged(callback func(bool)) *Disposable
	    // ToJSON returns the wire representation used to mirror the sensor across processes.
	    ToJSON() sensorJSON
	}

<a name="SensorCategory"></a>

## type SensorCategory

SensorCategory categorizes a sensor's role in the system. It determines how the backend treats the sensor, read\-only or controllable.

	type SensorCategory string

<a name="SensorCategorySensor"></a>

	const (
	    SensorCategorySensor  SensorCategory = "sensor"  // Read-only detection sensor (motion, object, audio, etc.)
	    SensorCategoryControl SensorCategory = "control" // Controllable sensor with set methods (light, siren, PTZ, etc.)
	    SensorCategoryTrigger SensorCategory = "trigger" // Event trigger (doorbell ring)
	    SensorCategoryInfo    SensorCategory = "info"    // Informational read-only state (battery level)
	)

<a name="SensorConsumer"></a>

## type SensorTriggerSettings

SensorTriggerSettings is the sensor trigger settings \(contact, doorbell, switch, light, etc.\).

	type SensorTriggerSettings struct {
	    // Timeout is the sensor trigger timeout in seconds.
	    Timeout int `msgpack:"timeout" json:"timeout"`
	    // Triggers are sensor entity ids that also trigger the detection cascade (in addition to motion/audio).
	    Triggers []string `msgpack:"triggers" json:"triggers"`
	}

<a name="SensorType"></a>

## type SensorType

SensorType identifies the kind of sensor. "Sensor" is camera.ui's umbrella term for the smallest smart\-home unit. It covers measuring devices and controllable ones alike.

	type SensorType string

<a name="SensorTypeMotion"></a>

	const (
	    SensorTypeMotion         SensorType = "motion"         // Video-based motion detection
	    SensorTypeObject         SensorType = "object"         // Object detection (person, vehicle, animal, etc.)
	    SensorTypeAudio          SensorType = "audio"          // Audio event detection (glass break, scream, etc.)
	    SensorTypeFace           SensorType = "face"           // Face detection and recognition
	    SensorTypeLicensePlate   SensorType = "licensePlate"   // License plate detection and OCR
	    SensorTypeClassifier     SensorType = "classifier"     // General-purpose image classifier
	    SensorTypeClip           SensorType = "clip"           // CLIP embedding generation for semantic search
	    SensorTypeObjectAssist   SensorType = "objectAssist"   // Locates objects in a frame so secondary detectors get real crops from camera-side detections
	    SensorTypeContact        SensorType = "contact"        // Contact/open-close sensor (door, window)
	    SensorTypeLight          SensorType = "light"          // Light on/off and brightness control
	    SensorTypeSiren          SensorType = "siren"          // Siren on/off and volume control
	    SensorTypeSwitch         SensorType = "switch"         // Generic on/off switch
	    SensorTypeLock           SensorType = "lock"           // Lock/unlock control
	    SensorTypePTZ            SensorType = "ptz"            // Pan-tilt-zoom camera control
	    SensorTypeSecuritySystem SensorType = "securitySystem" // Security system arm/disarm control
	    SensorTypeDoorbell       SensorType = "doorbell"       // Doorbell ring trigger
	    SensorTypeTemperature    SensorType = "temperature"    // Temperature sensor (°C)
	    SensorTypeHumidity       SensorType = "humidity"       // Humidity sensor (0-100%)
	    SensorTypeOccupancy      SensorType = "occupancy"      // Occupancy/presence sensor
	    SensorTypeSmoke          SensorType = "smoke"          // Smoke detector
	    SensorTypeLeak           SensorType = "leak"           // Water leak detector
	    SensorTypeGarage         SensorType = "garage"         // Garage door opener
	    SensorTypeBattery        SensorType = "battery"        // Battery level and charging state
	)

<a name="Severity"></a>

## type SirenControl

SirenControl is a siren on/off and volume control sensor. Override SetActive / SetInactive \(by embedding SirenControl in your own type and shadowing the methods\) to drive your hardware, then call the embedded SirenControl's methods to sync the SDK state. For hardware\-pushed updates, call the embedded methods directly from your event handler. That bypasses any plugin override and only syncs state.

	type SirenControl struct{ BaseSensor }

<a name="NewSirenControl"></a>
### func NewSirenControl

	func NewSirenControl(name string, opts ...SensorOption) *SirenControl



<a name="SirenControl.GetCategory"></a>
### func \(\*SirenControl\) GetCategory

	func (s *SirenControl) GetCategory() SensorCategory



<a name="SirenControl.GetType"></a>
### func \(\*SirenControl\) GetType

	func (s *SirenControl) GetType() SensorType



<a name="SirenControl.GetVolume"></a>
### func \(\*SirenControl\) GetVolume

	func (s *SirenControl) GetVolume() int



<a name="SirenControl.IsActive"></a>
### func \(\*SirenControl\) IsActive

	func (s *SirenControl) IsActive() bool



<a name="SirenControl.SetActive"></a>
### func \(\*SirenControl\) SetActive

	func (s *SirenControl) SetActive()

SetActive activates the siren.

Example:

	siren.SetActive()
	

<a name="SirenControl.SetInactive"></a>
### func \(\*SirenControl\) SetInactive

	func (s *SirenControl) SetInactive()

SetInactive deactivates the siren.

Example:

	siren.SetInactive()
	

<a name="SirenControl.SetVolume"></a>
### func \(\*SirenControl\) SetVolume

	func (s *SirenControl) SetVolume(value int)

SetVolume sets the siren volume \(clamped to \[0,100\]\).

Example:

	siren.SetVolume(80)
	

<a name="SirenControl.ToJSON"></a>
### func \(\*SirenControl\) ToJSON

	func (s *SirenControl) ToJSON() sensorJSON



<a name="SirenControl.UpdateValue"></a>
### func \(\*SirenControl\) UpdateValue

	func (s *SirenControl) UpdateValue(property string, value any) error

UpdateValue routes generic property writes to the semantic setters.

<a name="SmokeSensor"></a>

## type SmokeSensor

SmokeSensor reports smoke detection state.

	type SmokeSensor struct{ BaseSensor }

<a name="NewSmokeSensor"></a>
### func NewSmokeSensor

	func NewSmokeSensor(name string, opts ...SensorOption) *SmokeSensor



<a name="SmokeSensor.GetCategory"></a>
### func \(\*SmokeSensor\) GetCategory

	func (s *SmokeSensor) GetCategory() SensorCategory



<a name="SmokeSensor.GetType"></a>
### func \(\*SmokeSensor\) GetType

	func (s *SmokeSensor) GetType() SensorType



<a name="SmokeSensor.IsDetected"></a>
### func \(\*SmokeSensor\) IsDetected

	func (s *SmokeSensor) IsDetected() bool



<a name="SmokeSensor.SetDetected"></a>
### func \(\*SmokeSensor\) SetDetected

	func (s *SmokeSensor) SetDetected(detected bool)

SetDetected reports the smoke detection state.

Example:

	smoke.SetDetected(true)
	

<a name="SmokeSensor.ToJSON"></a>
### func \(\*SmokeSensor\) ToJSON

	func (s *SmokeSensor) ToJSON() sensorJSON



<a name="SmokeSensor.UpdateValue"></a>
### func \(\*SmokeSensor\) UpdateValue

	func (s *SmokeSensor) UpdateValue(property string, value any) error

UpdateValue on a read\-only sensor: external writes are ignored.

<a name="SnapshotInterface"></a>

## type SwitchControl

SwitchControl is a generic on/off switch control sensor. Override SetOn / SetOff \(by embedding SwitchControl in your own type and shadowing the methods\) to drive hardware, then call the embedded SwitchControl's methods to sync the SDK state. For hardware\-pushed updates, call the embedded methods directly from your event handler. That bypasses any plugin override and only syncs state.

	type SwitchControl struct{ BaseSensor }

<a name="NewSwitchControl"></a>
### func NewSwitchControl

	func NewSwitchControl(name string, opts ...SensorOption) *SwitchControl



<a name="SwitchControl.GetCategory"></a>
### func \(\*SwitchControl\) GetCategory

	func (s *SwitchControl) GetCategory() SensorCategory



<a name="SwitchControl.GetType"></a>
### func \(\*SwitchControl\) GetType

	func (s *SwitchControl) GetType() SensorType



<a name="SwitchControl.IsOn"></a>
### func \(\*SwitchControl\) IsOn

	func (s *SwitchControl) IsOn() bool



<a name="SwitchControl.SetOff"></a>
### func \(\*SwitchControl\) SetOff

	func (s *SwitchControl) SetOff()

SetOff turns the switch off.

Example:

	sw.SetOff()
	

<a name="SwitchControl.SetOn"></a>
### func \(\*SwitchControl\) SetOn

	func (s *SwitchControl) SetOn()

SetOn turns the switch on.

Example:

	sw.SetOn()
	

<a name="SwitchControl.ToJSON"></a>
### func \(\*SwitchControl\) ToJSON

	func (s *SwitchControl) ToJSON() sensorJSON



<a name="SwitchControl.UpdateValue"></a>
### func \(\*SwitchControl\) UpdateValue

	func (s *SwitchControl) UpdateValue(property string, value any) error

UpdateValue routes generic property writes to the semantic setters.

<a name="TemperatureInfo"></a>

## type TemperatureInfo

TemperatureInfo reports the current temperature in degrees Celsius.

	type TemperatureInfo struct{ BaseSensor }

<a name="NewTemperatureInfo"></a>
### func NewTemperatureInfo

	func NewTemperatureInfo(name string, opts ...SensorOption) *TemperatureInfo



<a name="TemperatureInfo.GetCategory"></a>
### func \(\*TemperatureInfo\) GetCategory

	func (s *TemperatureInfo) GetCategory() SensorCategory



<a name="TemperatureInfo.GetCurrent"></a>
### func \(\*TemperatureInfo\) GetCurrent

	func (s *TemperatureInfo) GetCurrent() float64



<a name="TemperatureInfo.GetType"></a>
### func \(\*TemperatureInfo\) GetType

	func (s *TemperatureInfo) GetType() SensorType



<a name="TemperatureInfo.SetCurrent"></a>
### func \(\*TemperatureInfo\) SetCurrent

	func (s *TemperatureInfo) SetCurrent(value float64)

SetCurrent reports a new temperature reading \(clamped to \[\-270,100\]\).

Example:

	temperature.SetCurrent(21.5)
	

<a name="TemperatureInfo.ToJSON"></a>
### func \(\*TemperatureInfo\) ToJSON

	func (s *TemperatureInfo) ToJSON() sensorJSON



<a name="TemperatureInfo.UpdateValue"></a>
### func \(\*TemperatureInfo\) UpdateValue

	func (s *TemperatureInfo) UpdateValue(property string, value any) error

UpdateValue on a read\-only sensor: external writes are ignored.

<a name="ToastMessage"></a>

## type TrackVelocity

TrackVelocity is the signed centroid velocity in normalized units per frame. Positive X = moving right, positive Y = moving down. Prefer it over deriving velocity from frame\-to\-frame position deltas.

	type TrackVelocity struct {
	    X   float64 `msgpack:"x" json:"x"`
	    Y   float64 `msgpack:"y" json:"y"`
	}

<a name="TrackedDetection"></a>

## type TrackedDetection

TrackedDetection extends Detection with tracking metadata \(stable IDs, velocity\). Tracking fields are omitempty: plugins return plain Detection and the server\-side tracker fills these in.

	type TrackedDetection struct {
	    Detection
	    TrackId       *int           `msgpack:"trackId,omitempty" json:"trackId,omitempty"`             // Stable sequential ID for this object across frames
	    TrackAge      *int           `msgpack:"trackAge,omitempty" json:"trackAge,omitempty"`           // Number of frames this object has been continuously tracked
	    TrackSpeed    *float64       `msgpack:"trackSpeed,omitempty" json:"trackSpeed,omitempty"`       // Velocity magnitude in normalized units per frame; 0 = stationary
	    TrackVelocity *TrackVelocity `msgpack:"trackVelocity,omitempty" json:"trackVelocity,omitempty"` // Signed centroid velocity in normalized units per frame
	    TrackLost     *bool          `msgpack:"trackLost,omitempty" json:"trackLost,omitempty"`         // True if the object was not matched in the current frame
	}

<a name="VideoCodec"></a>
