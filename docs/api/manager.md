# Manager

System-level services injected onto `PluginAPI`: `CoreManager` for FFmpeg path / inter-plugin RPC / cloud signing, `DeviceManager` for camera lookup and async discovery, `DownloadManager` for token-protected downloads, and `NotificationManager` for publishing notifications into the host.

!!! note
    The reference below is auto-generated from Go doc comments via [`gomarkdoc`](https://github.com/princjef/gomarkdoc). Re-run `scripts/gen-api-docs.sh` to refresh it.

## type CoreManager

CoreManager provides system\-level functionality via RPC.

Exposes cross\-cutting services like the FFmpeg binary path, server addresses, the cloud server id, inter\-plugin lookup, and a stream of core system events. Accessed via api.CoreManager from within a plugin.

	type CoreManager struct {
	    // contains filtered or unexported fields
	}

<a name="CoreManager.ConnectToPlugin"></a>
### func \(\*CoreManager\) ConnectToPlugin

	func (cm *CoreManager) ConnectToPlugin(pluginName string) (*pluginProxy, error)

ConnectToPlugin connects to a plugin by name and returns a proxy for RPC calls. Returns nil if the plugin is not found. Connections are cached.

<a name="CoreManager.GetCloudServerID"></a>
### func \(\*CoreManager\) GetCloudServerID

	func (cm *CoreManager) GetCloudServerID() (string, error)

GetCloudServerID returns the cloud server identity this server is registered as.

Returns the cloud server\_id from the active cloud pairing, or an empty string when the server is not connected to the cloud.

<a name="CoreManager.GetFFmpegPath"></a>
### func \(\*CoreManager\) GetFFmpegPath

	func (cm *CoreManager) GetFFmpegPath() (string, error)

GetFFmpegPath returns the path to the FFmpeg binary.

<a name="CoreManager.GetPluginsByInterface"></a>
### func \(\*CoreManager\) GetPluginsByInterface

	func (cm *CoreManager) GetPluginsByInterface(interfaceName PluginInterface) ([]PluginInfo, error)

GetPluginsByInterface returns all installed, enabled plugins that implement a specific interface. Plugins the admin disabled are excluded. A returned plugin may still be starting up or may have crashed, so a call into one can fail.

<a name="CoreManager.GetServerAddresses"></a>
### func \(\*CoreManager\) GetServerAddresses

	func (cm *CoreManager) GetServerAddresses() ([]string, error)

GetServerAddresses returns the server addresses.

<a name="CoreManager.OnEvent"></a>
### func \(\*CoreManager\) OnEvent

	func (cm *CoreManager) OnEvent() *Observable[CoreManagerEvent]

OnEvent returns an Observable for core manager events \(e.g. cloud account changes\).

<a name="CoreManagerEvent"></a>

## type CoreManagerEvent

CoreManagerEvent is the payload emitted by CoreManager.OnEvent.

The host currently publishes one event type, "cloudAccountChanged". Subscribe via OnEvent to react to it.

	type CoreManagerEvent struct {
	    // Type is the event type identifier (e.g. "cloudAccountChanged").
	    Type string
	    // Data is the event-specific payload. Shape depends on the event type.
	    Data any
	}

<a name="CreateDownloadOptions"></a>

## type CreateDownloadOptions

CreateDownloadOptions specifies how to register an existing file as a downloadable artifact.

	type CreateDownloadOptions struct {
	    // FilePath is the absolute path to the file on disk.
	    FilePath string `msgpack:"filePath" json:"filePath"`
	    // Filename is the value used in the Content-Disposition header
	    // (defaults to the basename of FilePath).
	    Filename string `msgpack:"filename,omitempty" json:"filename,omitempty"`
	    // MimeType is the value used in the Content-Type header
	    // (defaults to "application/octet-stream").
	    MimeType string `msgpack:"mimeType,omitempty" json:"mimeType,omitempty"`
	    // TTLMs is the time-to-live in milliseconds (defaults to 10 minutes).
	    TTLMs int64 `msgpack:"ttlMs,omitempty" json:"ttlMs,omitempty"`
	    // Cleanup controls when the file on disk is deleted (see DownloadCleanup).
	    Cleanup DownloadCleanup `msgpack:"cleanup,omitempty" json:"cleanup,omitempty"`
	}

<a name="CreateStreamDownloadOptions"></a>

## type CreateStreamDownloadOptions

CreateStreamDownloadOptions specifies how to register a file that is still being written and served progressively.

	type CreateStreamDownloadOptions struct {
	    // FilePath is the absolute path to the file being written.
	    FilePath string `msgpack:"filePath" json:"filePath"`
	    // Filename is the value used in the Content-Disposition header.
	    Filename string `msgpack:"filename,omitempty" json:"filename,omitempty"`
	    // MimeType is the value used in the Content-Type header.
	    MimeType string `msgpack:"mimeType,omitempty" json:"mimeType,omitempty"`
	    // TTLMs is the time-to-live in milliseconds.
	    TTLMs int64 `msgpack:"ttlMs,omitempty" json:"ttlMs,omitempty"`
	    // Cleanup controls when the file on disk is deleted (see DownloadCleanup).
	    Cleanup DownloadCleanup `msgpack:"cleanup,omitempty" json:"cleanup,omitempty"`
	    // MarkerPath is the path to a marker file whose existence signals
	    // that writing is still in progress; when removed, the download
	    // server closes the response.
	    MarkerPath string `msgpack:"markerPath" json:"markerPath"`
	}

<a name="Detection"></a>

## type DeviceManager

DeviceManager provides camera lookup and discovery operations via RPC.

Use GetCamera to retrieve a camera by ID or name, and PushDiscoveredCameras to surface cameras found during async discovery \(e.g. after a cloud login\).

Accessed via api.DeviceManager from within a plugin.

	type DeviceManager struct {
	    // contains filtered or unexported fields
	}

<a name="DeviceManager.GetCamera"></a>
### func \(\*DeviceManager\) GetCamera

	func (dm *DeviceManager) GetCamera(cameraIDOrName string) (*CameraDevice, error)

GetCamera retrieves a camera by ID or name. Returns nil if no matching camera exists.

<a name="DeviceManager.PushDiscoveredCameras"></a>
### func \(\*DeviceManager\) PushDiscoveredCameras

	func (dm *DeviceManager) PushDiscoveredCameras(cameras []DiscoveredCamera) error

PushDiscoveredCameras pushes discovered cameras to the backend so the user can pick them in the UI without waiting for the next discovery poll. Use this when cameras are discovered asynchronously \(e.g. after a cloud login or mDNS event\).

<a name="DeviceStorage"></a>

## type DownloadCleanup

DownloadCleanup controls when the file on disk is deleted. Registry entry always expires at TTL; this only controls the file itself.

- DownloadCleanupNever: file persists; caller manages it.
- DownloadCleanupOnExpiry: deleted at TTL. Can be fetched N times during the window — correct mode for notification images that fan out to multiple devices/recipients.
- DownloadCleanupOnDownload: deleted after first successful download OR on TTL, whichever first. One\-shot mode for things like backup exports.

	type DownloadCleanup string

<a name="DownloadCleanupNever"></a>

	const (
	    DownloadCleanupNever      DownloadCleanup = "never"
	    DownloadCleanupOnExpiry   DownloadCleanup = "on-expiry"
	    DownloadCleanupOnDownload DownloadCleanup = "on-download"
	)

<a name="DownloadManager"></a>

## type DownloadManager

DownloadManager provides token\-based file download registration via RPC.

Allows plugins to register files for HTTP download via a token URL. No JWT authentication is needed — the token itself is the auth. Accessed via api.DownloadManager from within a plugin.

	type DownloadManager struct {
	    // contains filtered or unexported fields
	}

<a name="DownloadManager.CreateDownload"></a>
### func \(\*DownloadManager\) CreateDownload

	func (dm *DownloadManager) CreateDownload(options CreateDownloadOptions) (DownloadToken, error)

CreateDownload registers a file for HTTP download and returns a token\-based URL.

<a name="DownloadManager.CreateStreamDownload"></a>
### func \(\*DownloadManager\) CreateStreamDownload

	func (dm *DownloadManager) CreateStreamDownload(options *CreateStreamDownloadOptions) (DownloadToken, error)

CreateStreamDownload registers a streaming file for progressive HTTP download. The file is tailed during writing; the marker file signals completion.

<a name="DownloadManager.DeleteDownload"></a>
### func \(\*DownloadManager\) DeleteDownload

	func (dm *DownloadManager) DeleteDownload(token string) error

DeleteDownload removes a download token and optionally deletes the underlying file.

<a name="DownloadToken"></a>

## type DownloadToken

DownloadToken is returned after registering a download.

	type DownloadToken struct {
	    // Token is the unique download token (also embedded in URL/PublicURL).
	    Token string `msgpack:"token" json:"token"`
	    // URL is the in-app, same-origin path: "/api/download/<token>". Use it
	    // for callers already authenticated against this server (UI, plugins
	    // going through the proxy).
	    URL string `msgpack:"url" json:"url"`
	    // PublicURL is the externally-reachable, session-less URL the server
	    // publishes for out-of-band fetchers (push-notification image
	    // attachments, FCM / APNs payloads, share recipients). Shape:
	    // "<externalUrl>/api/download/<token>" — the token in the URL is the
	    // auth. Empty string when the server has no external URL configured
	    // (LAN-only deployments); fall back to URL for in-app callers.
	    PublicURL string `msgpack:"publicUrl" json:"publicUrl"`
	    // ExpiresAt is the unix timestamp (ms) when the token expires.
	    ExpiresAt int64 `msgpack:"expiresAt" json:"expiresAt"`
	}

<a name="EventAttribute"></a>

## type NotificationManager

NotificationManager hands out the plugin's outgoing notification API.

Plugins call Publish to ask the host to fan a Notification out to every installed Notifier\-plugin and the in\-app UI. The host applies user settings \(master toggle, per\-source toggle, quiet hours\) and the publishing plugin's declared capabilities; calls from plugins without CapabilityPublishNotifications are silently dropped.

Accessed via api.NotificationManager from within a plugin.

	type NotificationManager struct {
	    // contains filtered or unexported fields
	}

<a name="NotificationManager.Publish"></a>
### func \(\*NotificationManager\) Publish

	func (nm *NotificationManager) Publish(n *Notification) error

Publish sends a notification to the host for fan\-out to every installed Notifier\-plugin and the in\-app UI. Fire\-and\-forget: marshalling/transport errors are returned, but downstream delivery is async and failures there never propagate back here.

The plugin's contract MUST declare CapabilityPublishNotifications; otherwise the host drops the notification.

Example:

	api.NotificationManager.Publish(&sdk.Notification{
	    Title:    "Camera offline",
	    Body:     "Front Door stopped recording",
	    Severity: sdk.SeverityWarn,
	    DeepLink: "/cameras/front-door",
	    Data:     map[string]string{"cameraId": "front-door"},
	})
	

<a name="NotifierDevice"></a>
