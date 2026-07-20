# Plugin API

Core plugin lifecycle and capability surface: the `Plugin` interface every plugin implements, the `BasePlugin` boilerplate-saver, the `PluginContract` manifest, lifecycle event names (`APIEvent*`), and every optional interface — `DiscoveryProvider`, `NotifierInterface`, and the seven detection interfaces.

!!! note
    The reference below is auto-generated from Go doc comments via [`gomarkdoc`](https://github.com/princjef/gomarkdoc). Re-run `scripts/gen-api-docs.sh` to refresh it.

## func CanCreateCameras

	func CanCreateCameras(c *PluginContract) bool

CanCreateCameras reports whether the plugin can create cameras \(role is CameraController or CameraAndSensorProvider\). Used to gate camera\-creating operations such as DiscoveryProvider adoption.

Example:

	if CanCreateCameras(contract) {
	    enableAdoption()
	}
	

<a name="CanProvideSensorsToAnyCameras"></a>

## func CanProvideSensorsToAnyCameras

	func CanProvideSensorsToAnyCameras(c *PluginContract) bool

CanProvideSensorsToAnyCameras reports whether the plugin is allowed to add sensors to cameras owned by other plugins \(true for SensorProvider and CameraAndSensorProvider\). Hub and pure CameraController plugins only see their own cameras.

Example:

	if CanProvideSensorsToAnyCameras(contract) {
	    listAllCameras()
	}
	

<a name="FirstValueFrom"></a>

## func GetContractValidationErrors

	func GetContractValidationErrors(c *PluginContract) []string

GetContractValidationErrors checks a typed contract's values: the name is non\-empty and the role, provided/consumed sensor types, interfaces and capabilities are all members of their accepted enum sets. It returns one human\-readable error per problem found, or an empty slice when the contract is valid.

Example:

	errs := GetContractValidationErrors(rawManifest)
	if len(errs) > 0 {
	    return fmt.Errorf("invalid contract: %s", strings.Join(errs, "; "))
	}
	

<a name="HasCapability"></a>

## func HasCapability

	func HasCapability(c *PluginContract, cap PluginCapability) bool

HasCapability reports whether the plugin requested the given capability \(i.e. cap is listed in the contract's Capabilities\).

Example:

	if HasCapability(contract, CapabilityPublishNotifications) {
	    allowPublish()
	}
	

<a name="HasInterface"></a>

## func HasInterface

	func HasInterface(c *PluginContract, iface PluginInterface) bool

HasInterface reports whether the plugin implements the given capability \(i.e. iface is listed in the contract's Interfaces\).

Example:

	if HasInterface(contract, PluginInterfaceDiscoveryProvider) {
	    startScan()
	}
	

<a name="Int"></a>

## func IsHub

	func IsHub(c *PluginContract) bool

IsHub reports whether the plugin's role is Hub \(a cross\-camera aggregator such as a smart\-home bridge or recorder, which owns no cameras of its own\).

Example:

	if IsHub(contract) {
	    skipLocalDiscovery()
	}
	

<a name="Run"></a>

## func Run

	func Run(constructor pluginConstructor)

Run is the entry point a Go plugin's main package calls to hand control to the SDK runtime.

<a name="ValidateContractConsistency"></a>

## func ValidateContractConsistency

	func ValidateContractConsistency(c *PluginContract, pluginName string) error

ValidateContractConsistency enforces role\-specific consistency rules on top of the structural check \(e.g. SensorProvider plugins must declare at least one provided sensor; Hub plugins cannot expose sensors\). Returns a non\-nil error on the first violation.

Example:

	if err := ValidateContractConsistency(contract, "my-plugin"); err != nil {
	    return err
	}
	

<a name="APIEvent"></a>

## type APIEvent

APIEvent identifies a lifecycle event emitted on the PluginAPI eventEmitter. Plugins subscribe with api.On\(string\(APIEventX\), handler\) to react to host\-driven phase changes.

	type APIEvent string

<a name="APIEventFinishLaunching"></a>

	const (
	    // APIEventFinishLaunching is emitted exactly once after the plugin has
	    // been constructed, all assigned cameras have been wired up, and
	    // ConfigureCameras has returned. Use it to start background work that
	    // must wait until the camera set is stable (timers, model warm-up,
	    // outbound connections).
	    APIEventFinishLaunching APIEvent = "finishLaunching"
	    // APIEventShutdown is emitted when the host is tearing the plugin down
	    // (graceful stop, reload or process exit). Listeners must release
	    // resources synchronously enough to finish before the host kills the
	    // process — open files, sockets, timers, child processes.
	    APIEventShutdown APIEvent = "shutdown"
	)

<a name="AssignedPlugin"></a>

## type AssignedPlugin

AssignedPlugin is plugin assignment info \(id \+ display name\).

	type AssignedPlugin struct {
	    // ID is the plugin ID.
	    ID  string `msgpack:"id" json:"id"`
	    // Name is the plugin display name.
	    Name string `msgpack:"name" json:"name"`
	}

<a name="AudioCodec"></a>

## type AudioDetectionInterface

AudioDetectionInterface is implemented by plugins that perform audio event or keyword detection.

	type AudioDetectionInterface interface {
	    // TestAudio runs detection on an audio buffer captured by the UI test
	    // panel; metadata carries the input MIME type (mpeg/wav/ogg).
	    TestAudio(audioData []byte, metadata AudioMetadata, config map[string]any) (*AudioDetectionResponse, error)
	    // AudioSettings returns the JSON schema used to render the
	    // audio-detection settings form in the UI. Return nil for no schema.
	    AudioSettings() ([]JsonSchema, error)
	}

<a name="AudioDetectionResponse"></a>

## type AudioDetectionResponse

AudioDetectionResponse is the result of an audio detection run.

	type AudioDetectionResponse struct {
	    Detected   bool        `msgpack:"detected" json:"detected"`
	    Detections []Detection `msgpack:"detections" json:"detections"`
	    Decibels   float64     `msgpack:"decibels,omitempty" json:"decibels,omitempty"`
	}

<a name="AudioDetectionSettings"></a>

## type AudioDetectionSettings

AudioDetectionSettings is audio detection configuration.

	type AudioDetectionSettings struct {
	    // MinDecibels is the minimum volume threshold in dBFS (-100 to 0). Audio below this level is skipped.
	    MinDecibels float64 `msgpack:"minDecibels" json:"minDecibels"`
	    // Timeout is the audio dwell time in seconds.
	    Timeout int `msgpack:"timeout" json:"timeout"`
	}

<a name="AudioDetector"></a>

## type AudioMetadata

AudioMetadata is audio metadata passed to audio detector test methods.

	type AudioMetadata struct {
	    MimeType string `msgpack:"mimeType" json:"mimeType"`
	}

<a name="AudioModelSpec"></a>

## type BasePlugin

BasePlugin embeds the three dependencies every plugin needs \(logger, API handle, storage\). Embed it in your plugin struct to avoid repeating that boilerplate.

Example:

	type MyPlugin struct {
	    sdk.BasePlugin
	    cameras map[string]*sdk.CameraDevice
	}
	
	func NewPlugin(logger *sdk.Logger, api *sdk.PluginAPI, storage *sdk.DeviceStorage) sdk.Plugin {
	    return &MyPlugin{
	        BasePlugin: sdk.NewBasePlugin(logger, api, storage),
	        cameras:    make(map[string]*sdk.CameraDevice),
	    }
	}
	

	type BasePlugin struct {
	    Logger  *Logger
	    API     *PluginAPI
	    Storage *DeviceStorage
	}

<a name="NewBasePlugin"></a>
### func NewBasePlugin

	func NewBasePlugin(logger *Logger, api *PluginAPI, storage *DeviceStorage) BasePlugin

NewBasePlugin builds a BasePlugin value from the constructor arguments. Use it inside your pluginConstructor implementation.

<a name="BaseSensor"></a>

## type ClassifierDetectionInterface

ClassifierDetectionInterface is implemented by plugins that run a generic image classifier and emit attribute/label pairs \(e.g. weather, scene, activity\).

	type ClassifierDetectionInterface interface {
	    // TestClassifier runs classification on a single image captured by the
	    // UI test panel and returns the result for preview rendering.
	    TestClassifier(imageData []byte, metadata ImageMetadata, config map[string]any) (*ClassifierDetectionResponse, error)
	    // DetectClassifications runs classification on a pre-decoded video frame.
	    DetectClassifications(frame VideoFrameData, config map[string]any) (*ClassifierDetectionResponse, error)
	    // ClassifierSettings returns the JSON schema for the
	    // classifier-detection settings form in the UI. Return nil for no
	    // schema.
	    ClassifierSettings() ([]JsonSchema, error)
	}

<a name="ClassifierDetectionResponse"></a>

## type ClassifierDetectionResponse

ClassifierDetectionResponse is the result of a classifier detection run.

	type ClassifierDetectionResponse struct {
	    Detected   bool                  `msgpack:"detected" json:"detected"`
	    Detections []ClassifierDetection `msgpack:"detections" json:"detections"`
	}

<a name="ClassifierDetector"></a>

## type ClipDetectionInterface

ClipDetectionInterface is implemented by plugins that generate CLIP image and text embeddings used for semantic search over recorded events.

	type ClipDetectionInterface interface {
	    // TestClipEmbedding runs the CLIP image branch on a single image
	    // captured by the UI test panel.
	    TestClipEmbedding(imageData []byte, metadata ImageMetadata, config map[string]any) (*ClipResult, error)
	    // DetectClipEmbedding runs the CLIP image branch on a pre-decoded
	    // video frame.
	    DetectClipEmbedding(frame VideoFrameData, config map[string]any) (*ClipResult, error)
	    // GetTextEmbedding runs the CLIP text branch and returns a single
	    // embedding vector usable for semantic-search queries against
	    // previously stored image embeddings.
	    GetTextEmbedding(text string) (*ClipTextEmbeddingResult, error)
	    // ClipSettings returns the JSON schema for the CLIP settings form in
	    // the UI. Return nil for no schema.
	    ClipSettings() ([]JsonSchema, error)
	}

<a name="ClipDetector"></a>

## type ClipTextEmbeddingResult

ClipTextEmbeddingResult is the return type for ClipDetectionInterface.GetTextEmbedding — a single embedding vector plus the model name used to produce it \(so downstream code can refuse to mix embeddings from different models\).

	type ClipTextEmbeddingResult struct {
	    Embedding      []float64 `msgpack:"embedding" json:"embedding"`
	    EmbeddingModel string    `msgpack:"embeddingModel" json:"embeddingModel"`
	}

<a name="ContactSensor"></a>

## type DiscoveredCamera

DiscoveredCamera is a camera found during discovery by a discovery provider plugin.

	type DiscoveredCamera struct {
	    // ID is the discovery ID (typically a stable native identifier).
	    ID  string `msgpack:"id" json:"id"`
	    // Name is the discovered camera display name.
	    Name string `msgpack:"name" json:"name"`
	    // Manufacturer is the manufacturer name (if known).
	    Manufacturer string `msgpack:"manufacturer,omitempty" json:"manufacturer,omitempty"`
	    // Model is the model name (if known).
	    Model string `msgpack:"model,omitempty" json:"model,omitempty"`
	    // Address is the network address (IP or hostname) shown in the UI to disambiguate same-model cameras.
	    Address string `msgpack:"address,omitempty" json:"address,omitempty"`
	}

<a name="DiscoveryProvider"></a>

## type DiscoveryProvider

DiscoveryProvider is implemented by plugins that can scan the network for new cameras and adopt them. Only plugins with a camera\-controlling role \(CameraController or CameraAndSensorProvider\) are queried for discovery.

	type DiscoveryProvider interface {
	    // OnDiscoverCameras scans the network and returns the cameras the
	    // plugin can offer for adoption. Called by the host on demand (UI
	    // rescan button) or on a polling schedule.
	    OnDiscoverCameras() ([]DiscoveredCamera, error)
	    // OnGetCameraSettings returns a JSON schema describing the form fields
	    // (credentials, transport options, ...) the user must fill in to adopt
	    // this specific discovered camera.
	    OnGetCameraSettings(camera DiscoveredCamera) ([]JsonSchema, error)
	    // OnAdoptCamera probes the device with the user-provided settings and
	    // returns the camera configuration the host should persist. The host
	    // then creates the camera and invokes the plugin's OnCameraAdded.
	    OnAdoptCamera(camera DiscoveredCamera, cameraSettings map[string]any) (map[string]any, error)
	}

<a name="Disposable"></a>

## type FaceDetectionInterface

FaceDetectionInterface is implemented by plugins that locate faces and emit per\-face embeddings. The NVR owns matching against enrolled faces; the plugin only emits raw detections \+ embeddings.

	type FaceDetectionInterface interface {
	    // TestFaces runs face detection on a single image captured by the UI
	    // test panel and returns the result for preview rendering.
	    TestFaces(imageData []byte, metadata ImageMetadata, config map[string]any) (*FaceDetectionResponse, error)
	    // DetectFaces runs face detection on a pre-decoded video frame.
	    DetectFaces(frame VideoFrameData, config map[string]any) (*FaceDetectionResponse, error)
	    // FaceSettings returns the JSON schema for the face-detection settings
	    // form in the UI. Return nil for no schema.
	    FaceSettings() ([]JsonSchema, error)
	}

<a name="FaceDetectionResponse"></a>

## type FaceDetectionResponse

FaceDetectionResponse is the result of a face detection run.

	type FaceDetectionResponse struct {
	    Detected       bool            `msgpack:"detected" json:"detected"`
	    Detections     []FaceDetection `msgpack:"detections" json:"detections"`
	    EmbeddingModel string          `msgpack:"embeddingModel,omitempty" json:"embeddingModel,omitempty"`
	}

<a name="FaceDetectionSettings"></a>

## type ImageMetadata

ImageMetadata is image metadata passed to detector test methods.

	type ImageMetadata struct {
	    Width  int `msgpack:"width" json:"width"`
	    Height int `msgpack:"height" json:"height"`
	}

<a name="JsonSchema"></a>

## type LicensePlateDetectionInterface

LicensePlateDetectionInterface is implemented by plugins that locate license plates and run OCR on them.

	type LicensePlateDetectionInterface interface {
	    // TestPlates runs detection on a single image captured by the UI test
	    // panel and returns the result for preview rendering.
	    TestPlates(imageData []byte, metadata ImageMetadata, config map[string]any) (*LicensePlateDetectionResponse, error)
	    // DetectLicensePlates runs detection on a pre-decoded video frame.
	    DetectLicensePlates(frame VideoFrameData, config map[string]any) (*LicensePlateDetectionResponse, error)
	    // PlateSettings returns the JSON schema for the license-plate-detection
	    // settings form in the UI. Return nil for no schema.
	    PlateSettings() ([]JsonSchema, error)
	}

<a name="LicensePlateDetectionResponse"></a>

## type LicensePlateDetectionResponse

LicensePlateDetectionResponse is the result of a license plate detection run.

	type LicensePlateDetectionResponse struct {
	    Detected   bool                    `msgpack:"detected" json:"detected"`
	    Detections []LicensePlateDetection `msgpack:"detections" json:"detections"`
	}

<a name="LicensePlateDetectionSettings"></a>

## type MotionDetectionInterface

MotionDetectionInterface is implemented by plugins that perform video\-based motion detection. The host invokes TestMotion from the UI test panel and DetectMotion from automation / benchmarking pipelines.

	type MotionDetectionInterface interface {
	    // TestMotion runs detection on a raw video buffer captured by the UI
	    // test panel and returns the result for preview rendering.
	    TestMotion(videoData []byte, config map[string]any) (*MotionDetectionResponse, error)
	    // DetectMotion runs detection on already-decoded VideoFrameData.
	    // Called from automation / benchmark pipelines that supply pre-decoded
	    // frames directly to avoid re-encoding.
	    DetectMotion(frames []VideoFrameData, config map[string]any) (*MotionDetectionResponse, error)
	    // MotionSettings returns the JSON schema used to render the
	    // motion-detection settings form in the UI. Return nil for no schema.
	    MotionSettings() ([]JsonSchema, error)
	}

<a name="MotionDetectionResponse"></a>

## type MotionDetectionResponse

MotionDetectionResponse is the result of a motion detection run. VideoData optionally carries an annotated re\-encoded clip for the UI test panel.

	type MotionDetectionResponse struct {
	    Detected   bool        `msgpack:"detected" json:"detected"`
	    Detections []Detection `msgpack:"detections" json:"detections"`
	    VideoData  []byte      `msgpack:"videoData,omitempty" json:"videoData,omitempty"`
	}

<a name="MotionDetectionSettings"></a>

## type MotionDetectionSettings

MotionDetectionSettings is motion detection configuration.

	type MotionDetectionSettings struct {
	    // Resolution is the detection resolution quality.
	    Resolution MotionResolution `msgpack:"resolution" json:"resolution"`
	    // Timeout is the motion dwell time in seconds.
	    Timeout int `msgpack:"timeout" json:"timeout"`
	}

<a name="MotionDetector"></a>

## type Notification

Notification is the payload published via api.NotificationManager.Publish or routed by the host. Plugins fill the user\-visible fields; the host stamps the message id, timestamp and source identifier on receive — plugins do not set those.

	type Notification struct {
	    // Title is the headline shown by every notifier.
	    Title string `msgpack:"title" json:"title"`
	    // Subtitle is an optional second bold line between Title and Body.
	    // Honoured natively on iOS (APNs alert.subtitle); other notifiers may
	    // fold it into the body or ignore it.
	    Subtitle string `msgpack:"subtitle,omitempty" json:"subtitle,omitempty"`
	    // Body is the optional secondary text.
	    Body string `msgpack:"body,omitempty" json:"body,omitempty"`
	    // Severity drives DND / Critical-Alerts behaviour and Quiet-Hours
	    // bypass. Defaults to SeverityInfo if empty.
	    Severity Severity `msgpack:"severity,omitempty" json:"severity,omitempty"`
	    // Tag is a collapse-key (e.g. "motion:cam-1"). The host uses it to replace
	    // an older entry with the same tag in the in-app notification list.
	    // Delivery is not throttled: every publish is sent. Notifiers may map it to
	    // a platform collapse-id.
	    Tag string `msgpack:"tag,omitempty" json:"tag,omitempty"`
	    // Thumbnail is an optional inline JPEG attached to the notification.
	    Thumbnail []byte `msgpack:"thumbnail,omitempty" json:"thumbnail,omitempty"`
	    // ImageURL is a publicly-fetchable URL to a rich image (e.g. a detection
	    // snapshot). Notifier-agnostic: FCM/APNs and other notifiers fetch it to
	    // render the image. Preferred over inline Thumbnail bytes when a URL is
	    // available; empty renders text-only.
	    ImageURL string `msgpack:"imageUrl,omitempty" json:"imageUrl,omitempty"`
	    // DeepLink is a router-relative path consumed by mobile / web tap
	    // handlers (e.g. "/cameras/cam-1?startTs=…"). No host, no scheme.
	    DeepLink string `msgpack:"deepLink,omitempty" json:"deepLink,omitempty"`
	    // Data carries plugin-specific context (cameraId, eventId, plugin-
	    // defined keys). String values keep the wire format predictable across
	    // notifier implementations.
	    Data map[string]string `msgpack:"data,omitempty" json:"data,omitempty"`
	    // AdminOnly restricts delivery to users with the master or admin role.
	    // Use it for operational alerts that concern whoever runs the instance —
	    // camera offline, disk full, plugin failures — so they don't reach guests
	    // the instance is merely shared with. Defaults to false (every user of the
	    // instance receives it, subject to their own notification settings).
	    AdminOnly bool `msgpack:"adminOnly,omitempty" json:"adminOnly,omitempty"`
	}

<a name="NotificationManager"></a>

## type NotifierDevice

NotifierDevice represents a single push\-target managed by a notifier plugin \(one phone, one chat, one mailbox, ...\). Devices are owned by the plugin that registered them; the NotificationManager queries plugins for their device list rather than maintaining a shared registry.

	type NotifierDevice struct {
	    ID          string         `msgpack:"id" json:"id"`
	    OwnerUserID string         `msgpack:"ownerUserId" json:"ownerUserId"`
	    Name        string         `msgpack:"name" json:"name"`
	    Active      bool           `msgpack:"active" json:"active"`
	    Metadata    map[string]any `msgpack:"metadata,omitempty" json:"metadata,omitempty"`
	}

<a name="NotifierInterface"></a>

## type NotifierInterface

NotifierInterface is implemented by plugins that deliver notifications. The NotificationManager invokes these methods over RPC. Plugins own their device storage — the manager never persists devices itself.

	type NotifierInterface interface {
	    // GetDevices returns every device this notifier knows about for the given
	    // users. Each returned device carries its OwnerUserID so the caller can
	    // map results back. May return nil/empty when the notifier is unavailable
	    // (e.g. license invalid). Called frequently — keep cheap.
	    GetDevices(ownerUserIDs []string) ([]NotifierDevice, error)
	    // GetDevice fetches a single device by id. Returns nil if not found.
	    GetDevice(deviceID string) (*NotifierDevice, error)
	    // SendNotification delivers a notification to the given devices in one
	    // call. Errors are logged; the manager never aborts a fan-out because one
	    // notifier failed.
	    SendNotification(deviceIDs []string, n *Notification) error
	    // RegisterDevice creates a new device on this notifier. The `input`
	    // shape is plugin-specific JSON whose schema the notifier defines; the
	    // NotificationManager forwards it opaquely.
	    RegisterDevice(ownerUserID string, input map[string]any) (*NotifierDevice, error)
	    // RevokeDevice deletes a device permanently. Called when the user
	    // revokes the device through their notifier-specific UI.
	    RevokeDevice(deviceID string) error
	    // UpdateDevice mutates a subset of fields on an existing device.
	    // `patch` is plugin-agnostic (`name`, `active`); plugins ignore unknown
	    // keys. Returns the updated device or nil if the id isn't ours so the
	    // manager can probe the next plugin.
	    UpdateDevice(deviceID string, patch map[string]any) (*NotifierDevice, error)
	    // NotificationSettings returns the JSON schema used to render the
	    // notifier's settings form in the UI. Return nil for no schema.
	    NotificationSettings() ([]JsonSchema, error)
	}

<a name="OAuthAuthCodeFlowCapable"></a>

## type OAuthAuthCodeFlowCapable

OAuthAuthCodeFlowCapable is implemented by plugins that use the OAuth 2.0 Authorization Code Flow with PKCE. The plugin builds the auth URL \(keeping the PKCE verifier internal\); the host opens it and, on IdP redirect to /oauth/callback/:pluginId, forwards the code\+state to CompleteAuthCodeFlow.

	type OAuthAuthCodeFlowCapable interface {
	    OAuthCapable
	    // StartAuthCodeFlow builds the authorization URL for the given scopes and
	    // returns the awaiting-user state (AuthURL set).
	    StartAuthCodeFlow(scope []string) (*OAuthState, error)
	    // CompleteAuthCodeFlow exchanges the IdP-returned code for tokens after
	    // validating state against the value bound in StartAuthCodeFlow.
	    CompleteAuthCodeFlow(code, state string) (*OAuthState, error)
	    // CancelAuthCodeFlow aborts an in-progress authorization-code flow.
	    CancelAuthCodeFlow() error
	}

<a name="OAuthCapable"></a>

## type OAuthCapable

OAuthCapable is the base interface every OAuth\-capable plugin implements, alongside at least one flow sub\-interface \(Device / AuthCode / ClientCredentials\). It is IdP\-agnostic — the plugin brings its own endpoint config and knows nothing about the host's internals.

	type OAuthCapable interface {
	    // GetOAuthMetadata returns the IdP display info, scope descriptions and
	    // which flow sub-interfaces the plugin implements. Called on UI mount.
	    GetOAuthMetadata() (*OAuthMetadata, error)
	    // GetOAuthState returns a snapshot of the current lifecycle state; the
	    // host polls this to mirror progress.
	    GetOAuthState() (*OAuthState, error)
	    // Disconnect revokes the current grant at the IdP and clears the stored
	    // tokens.
	    Disconnect() error
	}

<a name="OAuthClientCredentialsCapable"></a>

## type OAuthClientCredentialsCapable

OAuthClientCredentialsCapable is implemented by plugins that authenticate with a user\-supplied client\_id \+ client\_secret \(no user redirect\). The plugin validates by fetching a token immediately.

	type OAuthClientCredentialsCapable interface {
	    OAuthCapable
	    // ConfigureClientCredentials stores the supplied credentials and fetches
	    // an initial token to validate them, returning the resulting state.
	    ConfigureClientCredentials(clientID, clientSecret string) (*OAuthState, error)
	}

<a name="OAuthDeviceFlowCapable"></a>

## type OAuthDeviceFlowCapable

OAuthDeviceFlowCapable is implemented by plugins whose IdP supports the RFC 8628 Device Authorization Grant. The plugin polls the IdP internally; the host only polls GetOAuthState to mirror progress.

	type OAuthDeviceFlowCapable interface {
	    OAuthCapable
	    // StartDeviceFlow requests a device code for the given scopes and begins
	    // polling the IdP. Returns the awaiting-user state (code + verification
	    // URI) for the UI to render.
	    StartDeviceFlow(scope []string) (*OAuthState, error)
	    // CancelDeviceFlow aborts an in-progress device flow.
	    CancelDeviceFlow() error
	}

<a name="OAuthMetadata"></a>

## type OAuthMetadata

OAuthMetadata is informational data the host renders in the connect dialog.

	type OAuthMetadata struct {
	    // IdpDisplayName is the human name of the identity provider, e.g.
	    // "cameraui.com", "Spotify", "GitHub".
	    IdpDisplayName string `msgpack:"idpDisplayName" json:"idpDisplayName"`
	    // ScopeDescriptions maps each scope to a human-readable description.
	    ScopeDescriptions map[string]string `msgpack:"scopeDescriptions" json:"scopeDescriptions"`
	    // SupportedFlows lists the flow sub-interfaces the plugin implements, so
	    // the host knows which connect affordance to render.
	    SupportedFlows []PluginInterface `msgpack:"supportedFlows" json:"supportedFlows"`
	}

<a name="OAuthProviderConfig"></a>

## type OAuthProviderConfig

OAuthProviderConfig points the plugin's OAuth manager at an identity provider.

	type OAuthProviderConfig struct {
	    // Preset names a built-in IdP endpoint set. When empty the explicit
	    // endpoint fields are used.
	    Preset string `msgpack:"preset,omitempty" json:"preset,omitempty"`
	    // DeviceAuthURL / TokenURL / RevokeURL are the IdP endpoints used when
	    // Preset is empty.
	    DeviceAuthURL string `msgpack:"deviceAuthUrl,omitempty" json:"deviceAuthUrl,omitempty"`
	    AuthURL       string `msgpack:"authUrl,omitempty" json:"authUrl,omitempty"`
	    TokenURL      string `msgpack:"tokenUrl,omitempty" json:"tokenUrl,omitempty"`
	    RevokeURL     string `msgpack:"revokeUrl,omitempty" json:"revokeUrl,omitempty"`
	}

<a name="OAuthProviderDeclaration"></a>

## type OAuthProviderDeclaration

OAuthProviderDeclaration is one provider a plugin integrates with. A single\-provider plugin declares exactly one.

	type OAuthProviderDeclaration struct {
	    // ID is the plugin-local provider identifier (storage key dimension for
	    // multi-provider plugins).
	    ID  string `msgpack:"id" json:"id"`
	    // Provider configures the IdP endpoints.
	    Provider OAuthProviderConfig `msgpack:"provider" json:"provider"`
	    // ClientID is the OAuth client id the plugin authenticates as.
	    ClientID string `msgpack:"clientId" json:"clientId"`
	    // Scopes are the scopes requested for this provider.
	    Scopes []string `msgpack:"scopes" json:"scopes"`
	    // Required marks the provider as mandatory for the plugin to function.
	    Required bool `msgpack:"required,omitempty" json:"required,omitempty"`
	    // Description is a one-line UI hint shown alongside the connect button.
	    Description string `msgpack:"description,omitempty" json:"description,omitempty"`
	}

<a name="OAuthState"></a>

## type OAuthState

OAuthState is a snapshot of a provider connection's lifecycle. It lives in the plugin and is the source of truth for both the host UI and downstream plugin code that needs a token. The host polls it via GetOAuthState while a flow is in progress.

	type OAuthState struct {
	    // Status is the current lifecycle phase (see OAuthStatus values).
	    Status OAuthStatus `msgpack:"status" json:"status"`
	
	    // UserCode / VerificationURI / VerificationURIComplete are set while a
	    // Device Flow is awaiting the user. VerificationURIComplete embeds the
	    // user code and is what the host renders as a QR code.
	    UserCode                string `msgpack:"userCode,omitempty" json:"userCode,omitempty"`
	    VerificationURI         string `msgpack:"verificationUri,omitempty" json:"verificationUri,omitempty"`
	    VerificationURIComplete string `msgpack:"verificationUriComplete,omitempty" json:"verificationUriComplete,omitempty"`
	
	    // AuthURL is set while an Authorization Code Flow is awaiting the user —
	    // the URL the browser must open to authorize.
	    AuthURL string `msgpack:"authUrl,omitempty" json:"authUrl,omitempty"`
	
	    // UserEmail / ConnectedAt / ScopesGranted describe an established grant
	    // (Status connected). ConnectedAt is a Unix timestamp.
	    UserEmail     string   `msgpack:"userEmail,omitempty" json:"userEmail,omitempty"`
	    ConnectedAt   int64    `msgpack:"connectedAt,omitempty" json:"connectedAt,omitempty"`
	    ScopesGranted []string `msgpack:"scopesGranted,omitempty" json:"scopesGranted,omitempty"`
	
	    // ErrorCode / ErrorMessage are set while Status is error. ErrorCode uses
	    // OAuth spec values ("access_denied", "expired_token", "server_error").
	    ErrorCode    string `msgpack:"errorCode,omitempty" json:"errorCode,omitempty"`
	    ErrorMessage string `msgpack:"errorMessage,omitempty" json:"errorMessage,omitempty"`
	}

<a name="OAuthStatus"></a>

## type OAuthStatus

OAuthStatus is the lifecycle phase of an OAuth provider connection, carried in OAuthState.Status.

	type OAuthStatus = string

<a name="OAuthStatusDisconnected"></a>

	const (
	    OAuthStatusDisconnected OAuthStatus = "disconnected"
	    OAuthStatusAwaitingUser OAuthStatus = "awaiting_user"
	    OAuthStatusPolling      OAuthStatus = "polling"
	    OAuthStatusConnected    OAuthStatus = "connected"
	    OAuthStatusError        OAuthStatus = "error"
	)

<a name="ObjectDetectionInterface"></a>

## type ObjectDetectionInterface

ObjectDetectionInterface is implemented by plugins that perform object detection \(person, vehicle, animal, ...\).

	type ObjectDetectionInterface interface {
	    // TestObjects runs detection on a single image captured by the UI test
	    // panel; metadata carries the image dimensions.
	    TestObjects(imageData []byte, metadata ImageMetadata, config map[string]any) (*ObjectDetectionResponse, error)
	    // DetectObjects runs detection on a pre-decoded video frame. Called
	    // from automation / benchmark pipelines.
	    DetectObjects(frame VideoFrameData, config map[string]any) (*ObjectDetectionResponse, error)
	    // ObjectSettings returns the JSON schema used to render the
	    // object-detection settings form in the UI. Return nil for no schema.
	    ObjectSettings() ([]JsonSchema, error)
	}

<a name="ObjectDetectionResponse"></a>

## type ObjectDetectionResponse

ObjectDetectionResponse is the result of an object detection run.

	type ObjectDetectionResponse struct {
	    Detected   bool        `msgpack:"detected" json:"detected"`
	    Detections []Detection `msgpack:"detections" json:"detections"`
	}

<a name="ObjectDetectionSettings"></a>

## type ObjectDetectionSettings

ObjectDetectionSettings is object detection configuration.

	type ObjectDetectionSettings struct {
	    // Confidence is the minimum confidence threshold (0.3 - 1.0).
	    Confidence float64 `msgpack:"confidence" json:"confidence"`
	    // SuppressStatic suppresses events from objects that stay stationary across events (e.g. parked cars). Defaults to true.
	    SuppressStatic *bool `msgpack:"suppressStatic,omitempty" json:"suppressStatic,omitempty"`
	}

<a name="ObjectDetector"></a>

## type Plugin

Plugin is the lifecycle contract every camera.ui plugin must implement. The host calls these methods in a strict order: ConfigureCameras once at startup, then OnCameraAdded / OnCameraReleased as the user adds or removes cameras at runtime.

	type Plugin interface {
	    // ConfigureCameras is called once on startup with every camera that is
	    // already assigned to this plugin. The plugin should attach handlers,
	    // open vendor sessions, and warm up models. Returning an error aborts
	    // plugin startup.
	    ConfigureCameras(cameras []*CameraDevice) error
	    // OnCameraAdded is called whenever a camera is assigned to this plugin
	    // at runtime — after a discovery adoption (DiscoveryProvider.OnAdoptCamera)
	    // or after the user re-assigns an existing camera in the UI. The plugin
	    // should set up the same per-camera state as in ConfigureCameras.
	    OnCameraAdded(camera *CameraDevice) error
	    // OnCameraReleased is called when a camera is unassigned from this
	    // plugin or deleted from the system. The plugin must release per-camera
	    // resources (sessions, timers, decoders) before returning.
	    OnCameraReleased(cameraID string) error
	}

<a name="PluginAPI"></a>

## type PluginAPI

PluginAPI is injected into the plugin at runtime and exposes the system services the plugin is allowed to talk to. It also acts as an eventEmitter for plugin lifecycle events \(see APIEvent constants in plugin.go\).

Example:

	// Access FFmpeg path
	ffmpeg, err := api.CoreManager.GetFFmpegPath()
	

	type PluginAPI struct {
	
	    // CoreManager exposes system-level operations such as the FFmpeg path
	    // and server addresses.
	    CoreManager *CoreManager
	    // DeviceManager owns the camera devices assigned to this plugin and
	    // publishes camera-state changes.
	    DeviceManager *DeviceManager
	    // DownloadManager mints token-protected download URLs for files the
	    // plugin wants to expose to the UI.
	    DownloadManager *DownloadManager
	    // NotificationManager publishes notifications into the host so they fan
	    // out to every installed Notifier-plugin and the in-app UI. Requires
	    // CapabilityPublishNotifications in the plugin contract.
	    NotificationManager *NotificationManager
	    // StoragePath is the absolute path to the plugin's writable storage
	    // directory (created and cleaned up by the host).
	    StoragePath string
	    // contains filtered or unexported fields
	}

<a name="PluginAssignments"></a>

## type PluginAssignments

PluginAssignments maps sensor types to their assigned plugin\(s\) for a camera. Single\-provider sensor types use \*AssignedPlugin \(nil when unassigned\). Multi\-provider sensor types use \[\]AssignedPlugin.

	type PluginAssignments struct {
	
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

<a name="PluginCapability"></a>

## type PluginCapability

PluginCapability is a permission a plugin requests so it can call a host\-provided system feature. Each capability gates one outgoing SDK call — calls without the matching capability are rejected by the host.

	type PluginCapability string

<a name="CapabilityPublishNotifications"></a>

	const (
	    // CapabilityPublishNotifications grants the plugin permission to call
	    // api.NotificationManager.Publish. Without this capability the host
	    // silently drops published notifications and logs an error.
	    CapabilityPublishNotifications PluginCapability = "publishNotifications"
	)

<a name="PluginContract"></a>

## type PluginContract

PluginContract is the manifest contract a plugin declares so the host knows what it does and what it needs at load time. Validated by ValidateContract \(plugin\_helper.go\) before the plugin is started.

	type PluginContract struct {
	    // Name is the stable, unique identifier for the plugin instance — used
	    // as the registry key, log prefix and the storage namespace.
	    Name string `msgpack:"name" json:"name"`
	    // Role is the plugin's role (see PluginRole).
	    Role PluginRole `msgpack:"role,omitempty" json:"role,omitempty"`
	    // Provides lists the sensor types the plugin produces. Empty for hubs
	    // and pure camera-controllers; required for sensor providers.
	    Provides []SensorType `msgpack:"provides" json:"provides"`
	    // Consumes lists the sensor types the plugin reads from other plugins
	    // (e.g. a face plugin consumes camera video frames).
	    Consumes []SensorType `msgpack:"consumes" json:"consumes"`
	    // Interfaces are the capability flags the plugin implements (see
	    // PluginInterface).
	    Interfaces []PluginInterface `msgpack:"interfaces,omitempty" json:"interfaces,omitempty"`
	    // Capabilities are permissions the plugin requests to call host system
	    // features (see PluginCapability). The host enforces these — calls
	    // without a matching capability are rejected.
	    Capabilities []PluginCapability `msgpack:"capabilities,omitempty" json:"capabilities,omitempty"`
	    // PythonVersion is the required Python interpreter version for Python
	    // plugins. Ignored by Node / Go plugins.
	    PythonVersion PythonVersion `msgpack:"pythonVersion,omitempty" json:"pythonVersion,omitempty"`
	    // Dependencies are extra package dependencies installed into the
	    // plugin's runtime (Go module paths for Go plugins; PyPI / npm names
	    // for Python and Node plugins).
	    Dependencies []string `msgpack:"dependencies,omitempty" json:"dependencies,omitempty"`
	}

<a name="PluginInfo"></a>

## type PluginInfo

PluginInfo is a lightweight handle identifying an installed plugin — used in RPC payloads and managers to refer to the plugin without shipping its full state.

	type PluginInfo struct {
	    // ID is the unique runtime ID assigned by the host (stable across
	    // restarts).
	    ID  string `msgpack:"id" json:"id"`
	    // Name is the plugin package name (matches PluginContract.Name).
	    Name string `msgpack:"name" json:"name"`
	    // Contract is the full contract the plugin was loaded with.
	    Contract PluginContract `msgpack:"contract" json:"contract"`
	}

<a name="PluginInterface"></a>

## type PluginInterface

PluginInterface is a capability flag a plugin advertises in its contract. The host uses these to decide which RPC handlers to wire up and which UI affordances to show.

	type PluginInterface string

<a name="PluginInterfaceMotionDetection"></a>

	const (
	    // PluginInterfaceMotionDetection — plugin implements
	    // MotionDetectionInterface (video-based motion detection).
	    PluginInterfaceMotionDetection PluginInterface = "MotionDetection"
	    // PluginInterfaceObjectDetection — plugin implements
	    // ObjectDetectionInterface (e.g. person, vehicle, animal).
	    PluginInterfaceObjectDetection PluginInterface = "ObjectDetection"
	    // PluginInterfaceAudioDetection — plugin implements
	    // AudioDetectionInterface (event/keyword audio detection).
	    PluginInterfaceAudioDetection PluginInterface = "AudioDetection"
	    // PluginInterfaceFaceDetection — plugin implements FaceDetectionInterface
	    // (face localisation + embeddings). The NVR owns matching against
	    // enrolled faces; the plugin only emits detections + embeddings.
	    PluginInterfaceFaceDetection PluginInterface = "FaceDetection"
	    // PluginInterfaceLicensePlateDetection — plugin implements
	    // LicensePlateDetectionInterface (plate localisation + OCR).
	    PluginInterfaceLicensePlateDetection PluginInterface = "LicensePlateDetection"
	    // PluginInterfaceClassifierDetection — plugin implements
	    // ClassifierDetectionInterface (generic image classification emitting
	    // attribute/label pairs).
	    PluginInterfaceClassifierDetection PluginInterface = "ClassifierDetection"
	    // PluginInterfaceClipDetection — plugin implements ClipDetectionInterface
	    // (CLIP image and text embeddings used for semantic search).
	    PluginInterfaceClipDetection PluginInterface = "ClipDetection"
	    // PluginInterfaceDiscoveryProvider — plugin implements DiscoveryProvider
	    // and can scan the network for new cameras and adopt them. Only valid
	    // for camera-controlling roles.
	    PluginInterfaceDiscoveryProvider PluginInterface = "DiscoveryProvider"
	    // PluginInterfaceNVR — plugin implements NVRInterface, persisting events
	    // and recordings and serving them back to the UI / mobile clients.
	    // Exactly one plugin per host fills this role at runtime.
	    PluginInterfaceNVR PluginInterface = "NVR"
	    // PluginInterfaceNotifier — plugin implements NotifierInterface
	    // (GetDevices, SendNotification, ...). Lets the central
	    // NotificationManager dispatch notifications to this plugin regardless
	    // of role. See plugin_notifier.go.
	    PluginInterfaceNotifier PluginInterface = "Notifier"
	    // PluginInterfaceOAuthCapable — plugin implements the OAuthCapable base
	    // interface (GetOAuthMetadata, GetOAuthState, Disconnect) plus at least
	    // one of the flow sub-interfaces below. See plugin_oauth.go.
	    PluginInterfaceOAuthCapable PluginInterface = "OAuthCapable"
	    // PluginInterfaceOAuthDeviceFlow — plugin implements
	    // OAuthDeviceFlowCapable (RFC 8628 Device Authorization Grant).
	    PluginInterfaceOAuthDeviceFlow PluginInterface = "OAuthDeviceFlow"
	    // PluginInterfaceOAuthAuthCodeFlow — plugin implements
	    // OAuthAuthCodeFlowCapable (Authorization Code Flow + PKCE).
	    PluginInterfaceOAuthAuthCodeFlow PluginInterface = "OAuthAuthCodeFlow"
	    // PluginInterfaceOAuthClientCredentials — plugin implements
	    // OAuthClientCredentialsCapable (user-supplied client_id + client_secret).
	    PluginInterfaceOAuthClientCredentials PluginInterface = "OAuthClientCredentials"
	)

<a name="PluginRole"></a>

## type PluginRole

PluginRole identifies the role a plugin plays in the system. The role decides which lifecycle hooks the host invokes and which contract validations apply \(see plugin\_helper.go\).

	type PluginRole string

<a name="PluginRoleHub"></a>

	const (
	    // PluginRoleHub is a system-wide aggregator that attaches to cameras owned
	    // by other plugins to provide a cross-camera service (e.g. bridging cameras
	    // and sensors into a smart-home platform, or recording and notifications).
	    // A hub creates no cameras of its own and provides no sensors (Provides must
	    // be empty); it attaches to cameras via the "hub" assignment and typically
	    // reads camera and sensor state through Consumes.
	    PluginRoleHub PluginRole = "hub"
	    // PluginRoleSensorProvider adds sensors to existing cameras without
	    // owning the camera itself. Typical use: a detection plugin that
	    // consumes another plugin's video frames and emits motion / object /
	    // face detections back into the system.
	    PluginRoleSensorProvider PluginRole = "sensorProvider"
	    // PluginRoleCameraController manages cameras and their media streams
	    // (ONVIF, RTSP, generic IP, ...). The plugin is responsible for stream
	    // URLs, PTZ, snapshots, and the lifecycle hooks in BasePlugin. It does
	    // not produce sensors for foreign cameras.
	    PluginRoleCameraController PluginRole = "cameraController"
	    // PluginRoleCameraAndSensorProvider is the combined role: plugin both
	    // manages cameras and exposes sensors (its own cameras and, when
	    // consumes is set, also foreign cameras).
	    PluginRoleCameraAndSensorProvider PluginRole = "cameraAndSensorProvider"
	)

<a name="PluginStatus"></a>

## type PluginStatus

PluginStatus reports the lifecycle state of the plugin process as seen by the host.

	type PluginStatus string

<a name="PluginStatusReady"></a>

	const (
	    PluginStatusReady    PluginStatus = "ready"
	    PluginStatusStarting PluginStatus = "starting"
	    PluginStatusStarted  PluginStatus = "started"
	    PluginStatusStopping PluginStatus = "stopping"
	    PluginStatusStopped  PluginStatus = "stopped"
	    PluginStatusError    PluginStatus = "error"
	    PluginStatusUnknown  PluginStatus = "unknown"
	    PluginStatusDisabled PluginStatus = "disabled"
	)

<a name="PluginStorage"></a>

## type PluginStorage

PluginStorage carries the storage paths the host hands to the plugin during the start handshake. Plugin code should read PluginAPI.StoragePath instead.

	type PluginStorage struct {
	    InstallPath string `msgpack:"installPath" json:"installPath"`
	    StoragePath string `msgpack:"storagePath" json:"storagePath"`
	}

<a name="Point"></a>

## type PythonVersion

PythonVersion is the Python interpreter major.minor version a Python plugin requires. The host ensures a matching interpreter exists in its venv pool before launching the plugin; Node and Go plugins ignore this field.

	type PythonVersion = string

<a name="PythonVersion311"></a>

	const (
	    PythonVersion311 PythonVersion = "3.11"
	    PythonVersion312 PythonVersion = "3.12"
	)

<a name="RTSPAudioCodec"></a>

## type Severity

Severity classifies how urgent a Notification is. Notifiers map this to platform\-specific delivery characteristics; the host bypasses user\-configured Quiet Hours for SeverityCritical.

	type Severity string

<a name="SeverityInfo"></a>

	const (
	    // SeverityInfo is a standard notification — default delivery (sound +
	    // banner) on every notifier.
	    SeverityInfo Severity = "info"
	    // SeverityWarn signals heightened attention; notifiers may use a
	    // different sound / colour.
	    SeverityWarn Severity = "warn"
	    // SeverityError signals a failure or action-required notification.
	    SeverityError Severity = "error"
	    // SeverityCritical requests highest-priority delivery on supporting
	    // notifiers; bypasses user-configured Quiet Hours on the host.
	    SeverityCritical Severity = "critical"
	)

<a name="SirenControl"></a>

## type StorageSchemaProvider

StorageSchemaProvider is an optional interface plugins can implement to register a JSON schema for their plugin\-level storage. The host renders it as a settings form in the UI.

	type StorageSchemaProvider interface {
	    StorageSchema() []JsonSchema
	}

<a name="StreamDirection"></a>
