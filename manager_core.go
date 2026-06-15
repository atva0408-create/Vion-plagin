package sdk

import (
	"context"
	"fmt"

	rpc "github.com/cameraui/rpc/go"
)

// CoreManagerEvent is the payload emitted by CoreManager.OnEvent.
//
// Emitted when a core system event occurs (e.g. cloud account changes,
// remote-server availability, plugin lifecycle changes). Subscribe via
// OnEvent to react to system-level state changes.
type CoreManagerEvent struct {
	// Type is the event type identifier (e.g. "cloudAccountChanged").
	Type string
	// Data is the event-specific payload. Shape depends on the event type.
	Data any
}

// pluginProxy provides RPC access to a remote plugin's methods.
//
// Returned by CoreManager.ConnectToPlugin. Use Invoke to call any
// public method exposed by the target plugin.
type pluginProxy struct {
	proxy *rpc.Proxy
}

// Invoke calls a method on the remote plugin and returns the result.
func (pp *pluginProxy) Invoke(ctx context.Context, method string, args ...any) (any, error) {
	return pp.proxy.Invoke(ctx, method, args...)
}

// CoreManager provides system-level functionality via RPC.
//
// Exposes cross-cutting services like the FFmpeg binary path, server
// addresses, HMAC signing for cloud requests, inter-plugin lookup, and
// a stream of core system events. Accessed via api.CoreManager from
// within a plugin.
type CoreManager struct {
	client      *rpc.Client
	proxy       *rpc.Proxy
	logger      *Logger
	closeSub    func() // unsubscribes from core events
	event       *Subject[CoreManagerEvent]
	connections map[string]*pluginProxy // cached plugin connections
}

// newCoreManager creates a new CoreManager.
func newCoreManager(client *rpc.Client, logger *Logger) *CoreManager {
	ns := getCoreManagerNamespaces()
	return &CoreManager{
		client:      client,
		proxy:       client.CreateProxy(ns.CoreManagerRPC),
		logger:      logger,
		event:       NewSubject[CoreManagerEvent](),
		connections: make(map[string]*pluginProxy),
	}
}

// init initializes the core manager and subscribes to core events.
func (cm *CoreManager) init() error {
	ns := getCoreManagerNamespaces()
	unsub, err := cm.client.Subscribe(ns.CoreManagerSubject, func(data []byte) {
		var msg map[string]any
		if !decodeMsgpack(cm.logger, data, &msg, "CoreManagerEvent") {
			return
		}
		cm.handleCoreEvent(msg)
	})
	if err != nil {
		return fmt.Errorf("failed to subscribe to core events: %w", err)
	}
	cm.closeSub = unsub
	return nil
}

// Close unsubscribes from core events and completes the event subject.
func (cm *CoreManager) Close() {
	if cm.closeSub != nil {
		cm.closeSub()
		cm.closeSub = nil
	}
	if cm.event != nil {
		cm.event.Complete()
	}
}

func (cm *CoreManager) handleCoreEvent(msg map[string]any) {
	eventType, _ := msg["type"].(string)
	if eventType == "" {
		return
	}
	cm.event.Next(CoreManagerEvent{Type: eventType, Data: msg["data"]})
}

// OnEvent returns an Observable for core manager events (e.g. cloud account changes).
func (cm *CoreManager) OnEvent() *Observable[CoreManagerEvent] {
	return cm.event.AsObservable()
}

// GetFFmpegPath returns the path to the FFmpeg binary.
func (cm *CoreManager) GetFFmpegPath() (string, error) {
	ctx := context.Background()
	result, err := cm.proxy.Invoke(ctx, "getFFmpegPath")
	if err != nil {
		return "", fmt.Errorf("getFFmpegPath: %w", err)
	}
	path, ok := result.(string)
	if !ok {
		return "", fmt.Errorf("getFFmpegPath: unexpected result type %T", result)
	}
	return path, nil
}

// GetServerAddresses returns the server addresses.
func (cm *CoreManager) GetServerAddresses() ([]string, error) {
	ctx := context.Background()
	result, err := cm.proxy.Invoke(ctx, "getServerAddresses")
	if err != nil {
		return nil, fmt.Errorf("getServerAddresses: %w", err)
	}

	switch v := result.(type) {
	case []any:
		addresses := make([]string, 0, len(v))
		for _, item := range v {
			if s, ok := item.(string); ok {
				addresses = append(addresses, s)
			}
		}
		return addresses, nil
	case []string:
		return v, nil
	default:
		return nil, fmt.Errorf("getServerAddresses: unexpected result type %T", result)
	}
}

// GetPlugin returns info about a plugin by name, or nil if not found.
func (cm *CoreManager) GetPlugin(pluginName string) (*PluginInfo, error) {
	ctx := context.Background()
	result, err := cm.proxy.Invoke(ctx, "getPlugin", pluginName)
	if err != nil {
		return nil, fmt.Errorf("getPlugin: %w", err)
	}
	if result == nil {
		return nil, nil
	}

	m, ok := result.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("getPlugin: unexpected result type %T", result)
	}

	info := &PluginInfo{}
	if v, ok := m["id"].(string); ok {
		info.ID = v
	}
	if v, ok := m["name"].(string); ok {
		info.Name = v
	}

	return info, nil
}

// GetPluginsByInterface returns all active plugins that implement a specific interface.
func (cm *CoreManager) GetPluginsByInterface(interfaceName PluginInterface) ([]PluginInfo, error) {
	ctx := context.Background()
	result, err := cm.proxy.Invoke(ctx, "getPluginsByInterface", string(interfaceName))
	if err != nil {
		return nil, fmt.Errorf("getPluginsByInterface: %w", err)
	}
	if result == nil {
		return nil, nil
	}

	arr, ok := result.([]any)
	if !ok {
		return nil, fmt.Errorf("getPluginsByInterface: unexpected result type %T", result)
	}

	var plugins []PluginInfo
	for _, item := range arr {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		info := PluginInfo{}
		if v, ok := m["id"].(string); ok {
			info.ID = v
		}
		if v, ok := m["name"].(string); ok {
			info.Name = v
		}
		plugins = append(plugins, info)
	}

	return plugins, nil
}

// ConnectToPlugin connects to a plugin by name and returns a proxy for RPC calls.
// Returns nil if the plugin is not found. Connections are cached.
func (cm *CoreManager) ConnectToPlugin(pluginName string) (*pluginProxy, error) {
	plugin, err := cm.GetPlugin(pluginName)
	if err != nil {
		return nil, err
	}
	if plugin == nil {
		return nil, nil
	}

	ns := getPluginNamespaces(plugin.ID)
	if existing, ok := cm.connections[ns.PluginChildRPC]; ok {
		return existing, nil
	}

	pp := &pluginProxy{
		proxy: cm.client.CreateProxy(ns.PluginChildRPC),
	}
	cm.connections[ns.PluginChildRPC] = pp
	return pp, nil
}
