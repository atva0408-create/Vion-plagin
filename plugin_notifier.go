package sdk

// Severity classifies how urgent a Notification is. Notifiers map this to
// platform-specific delivery characteristics; the host bypasses
// user-configured Quiet Hours for SeverityCritical.
type Severity string

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

// NotifierDevice represents a single push-target managed by a notifier
// plugin (one phone, one chat, one mailbox, ...). Devices are owned by the
// plugin that registered them; the NotificationManager queries plugins for
// their device list rather than maintaining a shared registry.
type NotifierDevice struct {
	ID          string         `msgpack:"id" json:"id"`
	OwnerUserID string         `msgpack:"ownerUserId" json:"ownerUserId"`
	Name        string         `msgpack:"name" json:"name"`
	Active      bool           `msgpack:"active" json:"active"`
	Metadata    map[string]any `msgpack:"metadata,omitempty" json:"metadata,omitempty"`
}

// Notification is the payload published via api.NotificationManager.Publish
// or routed by the host. Plugins fill the user-visible fields; the host
// stamps the message id, timestamp and source identifier on receive —
// plugins do not set those.
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
	// Tag is a collapse-key for dedup at both manager and notifier level
	// (e.g. "motion:cam-1" — multiple events with the same tag inside the
	// throttle window collapse into one notification on the device).
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

// TestNotificationResponse is the result of a
// NotifierInterface.TestNotification call: whether the test notification was
// delivered and, when known, to how many devices.
type TestNotificationResponse struct {
	// Delivered is true when the notifier accepted and dispatched the test
	// notification.
	Delivered bool `msgpack:"delivered" json:"delivered"`
	// DeviceCount is the number of devices the test notification was
	// delivered to.
	DeviceCount int `msgpack:"deviceCount,omitempty" json:"deviceCount,omitempty"`
	// Message is a human-readable status or error detail.
	Message string `msgpack:"message,omitempty" json:"message,omitempty"`
}

// NotifierInterface is implemented by plugins that deliver notifications.
// The NotificationManager invokes these methods over RPC. Plugins own their
// device storage — the manager never persists devices itself.
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
	// TestNotification sends a test notification to the given devices and
	// returns the delivery result. deviceIDs optionally restricts delivery to
	// a subset.
	TestNotification(notification *Notification, deviceIDs []string) (*TestNotificationResponse, error)
	// NotificationSettings returns the JSON schema used to render the
	// notifier's settings form in the UI. Return nil for no schema.
	NotificationSettings() ([]JsonSchema, error)
}
