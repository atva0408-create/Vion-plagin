package sdk

import (
	"fmt"

	rpc "github.com/cameraui/rpc/go"
)

// notificationPublishEnvelope is the wire shape the host expects on the
// notifications.publish subject. Carries the publishing plugin's identity
// alongside the user-facing notification so the host can run capability +
// per-source-toggle checks before fan-out.
type notificationPublishEnvelope struct {
	PluginID     string        `msgpack:"pluginId" json:"pluginId"`
	PluginName   string        `msgpack:"pluginName" json:"pluginName"`
	Notification *Notification `msgpack:"notification" json:"notification"`
}

// NotificationManager hands out the plugin's outgoing notification API.
//
// Plugins call Publish to ask the host to fan a Notification out to every
// installed Notifier-plugin and the in-app
// UI. The host applies user settings (master toggle, per-source toggle,
// quiet hours) and the publishing plugin's declared capabilities; calls
// from plugins without CapabilityPublishNotifications are silently dropped.
//
// Accessed via api.NotificationManager from within a plugin.
type NotificationManager struct {
	client     *rpc.Client
	pluginInfo PluginInfo
	logger     *Logger
}

// newNotificationManager builds a NotificationManager bound to the running
// plugin's identity. Called once by the SDK runtime in run.go.
func newNotificationManager(client *rpc.Client, pluginInfo *PluginInfo, logger *Logger) *NotificationManager {
	return &NotificationManager{
		client:     client,
		pluginInfo: *pluginInfo,
		logger:     logger,
	}
}

// Publish sends a notification to the host for fan-out to every installed
// Notifier-plugin and the in-app UI. Fire-and-forget: errors marshalling
// the payload or transmitting on NATS are returned, but the host's downstream
// processing (recipient resolve, notifier delivery) is async and failures
// there never propagate back here.
//
// The plugin's contract MUST declare CapabilityPublishNotifications;
// otherwise the host drops the notification and logs an error.
//
// Example:
//
//	api.NotificationManager.Publish(&sdk.Notification{
//	    Title:    "Camera offline",
//	    Body:     "Front Door stopped recording",
//	    Severity: sdk.SeverityWarn,
//	    DeepLink: "/cameras/front-door",
//	    Data:     map[string]string{"cameraId": "front-door"},
//	})
func (nm *NotificationManager) Publish(n *Notification) error {
	if n == nil {
		return fmt.Errorf("notification is nil")
	}
	if n.Title == "" {
		return fmt.Errorf("notification.title is required")
	}

	envelope := &notificationPublishEnvelope{
		PluginID:     nm.pluginInfo.ID,
		PluginName:   nm.pluginInfo.Name,
		Notification: n,
	}

	ns := getNotificationManagerNamespaces()
	if err := nm.client.Publish(ns.NotificationsPublishSubject, envelope); err != nil {
		return fmt.Errorf("publish notification: %w", err)
	}
	return nil
}
