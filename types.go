package sdk

// DownloadCleanup controls when the file on disk is deleted. Registry
// entry always expires at TTL; this only controls the file itself.
//
//   - DownloadCleanupNever: file persists; caller manages it.
//   - DownloadCleanupOnExpiry: deleted at TTL. Can be fetched N times
//     during the window — correct mode for notification images that fan
//     out to multiple devices/recipients.
//   - DownloadCleanupOnDownload: deleted after first successful download
//     OR on TTL, whichever first. One-shot mode for things like backup
//     exports.
type DownloadCleanup string

const (
	DownloadCleanupNever      DownloadCleanup = "never"
	DownloadCleanupOnExpiry   DownloadCleanup = "on-expiry"
	DownloadCleanupOnDownload DownloadCleanup = "on-download"
)

// CreateDownloadOptions specifies how to register an existing file as a
// downloadable artifact.
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

// CreateStreamDownloadOptions specifies how to register a file that is still
// being written and served progressively.
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

// DownloadToken is returned after registering a download.
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

type processLoadMessage struct {
	Cameras []Camera      `msgpack:"cameras" json:"cameras"`
	Plugin  PluginInfo    `msgpack:"plugin" json:"plugin"`
	Storage PluginStorage `msgpack:"storage" json:"storage"`
}

type processResponse struct {
	Type  string `msgpack:"type" json:"type"`
	Error string `msgpack:"error,omitempty" json:"error,omitempty"`
}
