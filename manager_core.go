package sdk

import (
	"context"
	"fmt"
	"os"

	rpc "github.com/cameraui/rpc/go"
)

// SensorHistoryEntry is one recorded change of one sensor property.
type SensorHistoryEntry struct {
	SensorID  string `msgpack:"sensorId" json:"sensorId"`
	Property  string `msgpack:"property" json:"property"`
	Value     any    `msgpack:"value" json:"value"`
	Timestamp int64  `msgpack:"timestamp" json:"timestamp"`
}

// AssistantAskImage is one picture of an AssistantAskRequest.
type AssistantAskImage struct {
	Data     []byte `msgpack:"data" json:"data"`
	MimeType string `msgpack:"mimeType" json:"mimeType"`
}

// AssistantAskRequest is one completion request to the assistant model the
// admin assigned to this plugin. TimeoutMs defaults to 45 s and is capped at
// 300 s; pictures are sent only when the assigned model passed the picture test.
type AssistantAskRequest struct {
	Prompt       string              `msgpack:"prompt" json:"prompt"`
	System       string              `msgpack:"system,omitempty" json:"system,omitempty"`
	Images       []AssistantAskImage `msgpack:"images,omitempty" json:"images,omitempty"`
	OutputSchema map[string]any      `msgpack:"outputSchema,omitempty" json:"outputSchema,omitempty"`
	TimeoutMs    int                 `msgpack:"timeoutMs,omitempty" json:"timeoutMs,omitempty"`
}

// AssistantAskUsage counts the tokens one ask consumed.
type AssistantAskUsage struct {
	PromptTokens     int `msgpack:"promptTokens" json:"promptTokens"`
	CompletionTokens int `msgpack:"completionTokens" json:"completionTokens"`
}

// AssistantAskResult is the answer of CoreManager.AssistantAsk: Text (and
// JSON when a schema was given) with OK true, otherwise Reason and Message
// say why the call did not run (not_allowed, unconfigured, timeout, error).
type AssistantAskResult struct {
	OK      bool              `msgpack:"ok" json:"ok"`
	Text    string            `msgpack:"text,omitempty" json:"text,omitempty"`
	JSON    any               `msgpack:"json,omitempty" json:"json,omitempty"`
	Usage   AssistantAskUsage `msgpack:"usage,omitempty" json:"usage"`
	Reason  string            `msgpack:"reason,omitempty" json:"reason,omitempty"`
	Message string            `msgpack:"message,omitempty" json:"message,omitempty"`
}

// AssistantAccess says whether this plugin may use the assistant model and
// what the assigned entry can do. Model is empty when not allowed, Vision is
// nil until the picture probe ran, Language is the answer language of the
// assistant settings (for example "de") and empty when it follows the interface.
type AssistantAccess struct {
	Allowed  bool   `msgpack:"allowed" json:"allowed"`
	Model    string `msgpack:"model,omitempty" json:"model,omitempty"`
	Vision   *bool  `msgpack:"vision" json:"vision"`
	Language string `msgpack:"language,omitempty" json:"language,omitempty"`
}

type assistantAskWire struct {
	AssistantAskRequest
	PluginID string `msgpack:"pluginId" json:"pluginId"`
}

// CoreManagerEvent is the payload emitted by CoreManager.OnEvent.
//
// The host currently publishes one event type, "cloudAccountChanged".
// Subscribe via OnEvent to react to it.
type CoreManagerEvent struct {
	// Type is the event type identifier (e.g. "cloudAccountChanged").
	Type string
	// Data is the event-specific payload. Shape depends on the event type.
	Data any
}

// CoreManager provides system-level operations.
//
// Exposes cross-cutting services like the FFmpeg binary path, server
// addresses, the cloud server id, inter-plugin lookup, and a stream of
// core system events. Accessed via api.CoreManager from within a plugin.
type CoreManager struct {
	client      *rpc.Client
	proxy       *rpc.Proxy
	logger      *Logger
	closeSub    func()
	event       *Subject[CoreManagerEvent]
	connections map[string]*pluginProxy
}

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

// OnEvent returns an Observable for core manager events (e.g. cloud account changes).
func (cm *CoreManager) OnEvent() *Observable[CoreManagerEvent] {
	return cm.event.AsObservable()
}

// AssistantAsk asks the assistant model for one completion. The admin decides
// under Settings, Assistant which plugins may use the model and which entry
// they get; the key never reaches the plugin.
//
// Example:
//
//	answer, err := api.CoreManager.AssistantAsk(ctx, &sdk.AssistantAskRequest{
//	    System:   "Answer with one word.",
//	    Prompt:   "Is there a person in this picture?",
//	    Images:   []sdk.AssistantAskImage{{Data: jpeg, MimeType: "image/jpeg"}},
//	})
//	if err == nil && answer.OK {
//	    fmt.Println(answer.Text)
//	}
func (cm *CoreManager) AssistantAsk(ctx context.Context, request *AssistantAskRequest) (*AssistantAskResult, error) {
	var result AssistantAskResult
	wire := &assistantAskWire{AssistantAskRequest: *request, PluginID: os.Getenv("PLUGIN_ID")}
	if err := cm.InvokeInto(ctx, &result, "assistantAsk", wire); err != nil {
		return nil, err
	}
	return &result, nil
}

// AssistantAccess reports whether this plugin may use the assistant model and
// what the assigned entry can do. Subscribe to OnEvent for
// "assistantModelChanged" to learn about changes while running.
func (cm *CoreManager) AssistantAccess(ctx context.Context) (*AssistantAccess, error) {
	var access AssistantAccess
	if err := cm.InvokeInto(ctx, &access, "assistantAccess", os.Getenv("PLUGIN_ID")); err != nil {
		return nil, err
	}
	return &access, nil
}

// GetFFmpegPath returns the path to the FFmpeg binary.
func (cm *CoreManager) GetFFmpegPath() (string, error) {
	// remote-hosted: the master's path points at the wrong machine, the worker
	// injects its own bundled ffmpeg at spawn time
	if path := os.Getenv("CAMERAUI_FFMPEG_PATH"); path != "" {
		return path, nil
	}

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

// GetServerAddresses returns the server addresses (IP addresses the server
// is listening on).
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

// GetCloudServerID returns the cloud server identity this server is registered as.
//
// Returns the cloud server_id from the active cloud pairing, or an empty
// string when the server is not connected to the cloud.
func (cm *CoreManager) GetCloudServerID() (string, error) {
	ctx := context.Background()
	result, err := cm.proxy.Invoke(ctx, "getCloudServerId")
	if err != nil {
		return "", fmt.Errorf("getCloudServerId: %w", err)
	}
	if result == nil {
		return "", nil
	}
	id, ok := result.(string)
	if !ok {
		return "", fmt.Errorf("getCloudServerId: unexpected result type %T", result)
	}
	return id, nil
}

// GetPluginsByInterface returns all installed, enabled plugins that implement a
// specific interface. Plugins the admin disabled are excluded. A returned plugin
// may still be starting up or may have crashed, so a call into one can fail.
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
		info := PluginInfo{}
		if err := decodePluginInfo(item, &info); err != nil {
			continue
		}
		plugins = append(plugins, info)
	}

	return plugins, nil
}

// InvokeInto calls a host method by name and decodes the result into out.
//
// It is the escape hatch for host methods that have no typed wrapper here,
// which are the ones camera.ui's own plugins use and nothing else. They carry
// no compatibility promise: names and shapes may change with any server
// release. Pass nil for out to ignore the result.
func (cm *CoreManager) InvokeInto(ctx context.Context, out any, method string, args ...any) error {
	result, err := cm.proxy.Invoke(ctx, method, args...)
	if err != nil {
		return fmt.Errorf("%s: %w", method, err)
	}
	if out == nil || result == nil {
		return nil
	}

	encoded, err := rpc.Encode(result)
	if err != nil {
		return fmt.Errorf("%s: %w", method, err)
	}
	if err := rpc.Decode(encoded, out); err != nil {
		return fmt.Errorf("%s: %w", method, err)
	}

	return nil
}

// ConnectToPlugin connects to a plugin by name and returns a proxy for RPC calls.
// Returns nil if the plugin is not found. Connections are cached.
func (cm *CoreManager) ConnectToPlugin(pluginName string) (*pluginProxy, error) {
	plugin, err := cm.getPlugin(pluginName)
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

func (cm *CoreManager) close() {
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

func (cm *CoreManager) getPlugin(pluginName string) (*PluginInfo, error) {
	ctx := context.Background()
	result, err := cm.proxy.Invoke(ctx, "getPlugin", pluginName)
	if err != nil {
		return nil, fmt.Errorf("getPlugin: %w", err)
	}
	if result == nil {
		return nil, nil
	}

	info := &PluginInfo{}
	if err := decodePluginInfo(result, info); err != nil {
		return nil, fmt.Errorf("getPlugin: %w", err)
	}

	return info, nil
}

type pluginProxy struct {
	proxy *rpc.Proxy
}

// Invoke calls a method on the remote plugin and returns the result.
func (pp *pluginProxy) Invoke(ctx context.Context, method string, args ...any) (any, error) {
	return pp.proxy.Invoke(ctx, method, args...)
}

func decodePluginInfo(v any, out *PluginInfo) error {
	encoded, err := rpc.Encode(v)
	if err != nil {
		return err
	}
	return rpc.Decode(encoded, out)
}
