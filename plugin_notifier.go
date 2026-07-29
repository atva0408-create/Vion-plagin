package sdk

// Severity classifies how urgent a Notification is. Notifiers map this to
// platform-specific delivery characteristics; the host bypasses
// user-configured Quiet Hours for SeverityCritical.
type Severity string

const (
	// SeverityInfo is a standard notification, default delivery (sound +
	// banner).
	SeverityInfo Severity = "info"
	// SeverityWarn signals heightened attention; notifiers may use a
	// different sound or colour.
	SeverityWarn Severity = "warn"
	// SeverityError signals a failure or action-required notification.
	SeverityError Severity = "error"
	// SeverityCritical requests highest-priority delivery on supporting
	// notifiers; bypasses Quiet Hours.
	SeverityCritical Severity = "critical"
)

// NotifierDevice represents a single push-target managed by a notifier
// plugin (one phone, one chat, one mailbox, ...). Devices are owned by the
// plugin that registered them; the NotificationManager queries plugins for
// their device list rather than maintaining a shared registry.
type NotifierDevice struct {
	// ID is the plugin-assigned device id, unique within the notifier.
	ID string `msgpack:"id" json:"id"`
	// OwnerUserID is the user the device belongs to.
	OwnerUserID string `msgpack:"ownerUserId" json:"ownerUserId"`
	// Name is the display name shown in the UI.
	Name string `msgpack:"name" json:"name"`
	// Active is false while the user has muted this device; the manager
	// skips it.
	Active bool `msgpack:"active" json:"active"`
	// Metadata carries plugin-specific extras (push tokens, chat ids,
	// platform hints).
	Metadata map[string]any `msgpack:"metadata,omitempty" json:"metadata,omitempty"`
}

// Notification is the payload published via api.NotificationManager.Publish
// or routed by the host. Plugins fill the user-visible fields; the host
// stamps the message id, timestamp and source identifier on receive.
type Notification struct {
	// Title is the headline shown by every notifier.
	Title string `msgpack:"title" json:"title"`
	// Subtitle is an optional second bold line, honoured natively on iOS;
	// other notifiers may fold it into the body.
	Subtitle string `msgpack:"subtitle,omitempty" json:"subtitle,omitempty"`
	// Body is the optional secondary text.
	Body string `msgpack:"body,omitempty" json:"body,omitempty"`
	// Severity drives DND / Critical-Alerts behaviour and Quiet-Hours
	// bypass. Defaults to SeverityInfo if empty.
	Severity Severity `msgpack:"severity,omitempty" json:"severity,omitempty"`
	// Tag is a collapse-key (e.g. "motion:cam-1"). The host replaces an older
	// entry with the same tag in the in-app list. Delivery is not throttled:
	// every publish is sent. Notifiers may map it to a platform collapse-id.
	Tag string `msgpack:"tag,omitempty" json:"tag,omitempty"`
	// Thumbnail is an optional inline JPEG attached to the notification.
	Thumbnail []byte `msgpack:"thumbnail,omitempty" json:"thumbnail,omitempty"`
	// ImageURL is a publicly-fetchable URL to a rich image (e.g. a detection
	// snapshot). Preferred over inline Thumbnail bytes when a URL is
	// available; empty renders text-only.
	ImageURL string `msgpack:"imageUrl,omitempty" json:"imageUrl,omitempty"`
	// DeepLink is a router-relative path for mobile / web tap-handlers (e.g.
	// "/cameras/cam-1"). No host, no scheme.
	DeepLink string `msgpack:"deepLink,omitempty" json:"deepLink,omitempty"`
	// Data carries plugin-specific context (cameraId, eventId, plugin-defined
	// keys), string values only.
	Data map[string]string `msgpack:"data,omitempty" json:"data,omitempty"`
	// AdminOnly restricts delivery to users with the master or admin role.
	// Use it for operational alerts (camera offline, disk full, plugin
	// failures) so they don't reach guests the instance is merely shared
	// with. Defaults to false.
	AdminOnly bool `msgpack:"adminOnly,omitempty" json:"adminOnly,omitempty"`
}

// NotifierInterface is implemented by plugins that deliver notifications.
// The NotificationManager invokes these methods over RPC. Plugins own their
// device storage, the manager never persists devices itself.
type NotifierInterface interface {
	// GetDevices returns the devices this notifier knows for the given users,
	// each carrying its OwnerUserID. Returns nil when the notifier is
	// unavailable (e.g. invalid license). Called often, keep it cheap.
	GetDevices(ownerUserIDs []string) ([]NotifierDevice, error)
	// GetDevice fetches a single device by id. Returns nil if not found.
	GetDevice(deviceID string) (*NotifierDevice, error)
	// SendNotification delivers a notification to the given devices in one
	// call. Errors are logged, a failing notifier never aborts the fan-out.
	SendNotification(deviceIDs []string, n *Notification) error
	// RegisterDevice creates a new device. The input is plugin-specific JSON
	// the manager forwards opaquely.
	RegisterDevice(ownerUserID string, input map[string]any) (*NotifierDevice, error)
	// RevokeDevice deletes a device permanently. Called when the user revokes
	// it through their notifier-specific UI.
	RevokeDevice(deviceID string) error
	// UpdateDevice mutates name / active on an existing device. Returns nil
	// if the id isn't ours so the manager can probe the next plugin.
	UpdateDevice(deviceID string, patch map[string]any) (*NotifierDevice, error)
	// NotificationSettings returns the JSON schema used to render the
	// notifier's settings form in the UI, or nil for no schema.
	NotificationSettings() ([]JsonSchema, error)
}
