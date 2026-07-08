package sdk

import (
	"context"
	"fmt"
	"os"

	rpc "github.com/cameraui/rpc/go"
)

// Internal wire wrappers: RemotePluginID is stamped by the SDK when the plugin
// runs remote-hosted, so the master streams the file via the file-serve RPC.
// It is NOT part of the public options structs (plugin authors never set it).
type createDownloadWire struct {
	CreateDownloadOptions
	RemotePluginID string `msgpack:"remotePluginId,omitempty" json:"remotePluginId,omitempty"`
}

type createStreamDownloadWire struct {
	CreateStreamDownloadOptions
	RemotePluginID string `msgpack:"remotePluginId,omitempty" json:"remotePluginId,omitempty"`
}

func remotePluginID() string {
	if os.Getenv("PLUGIN_REMOTE_MODE") == "" {
		return ""
	}
	return os.Getenv("PLUGIN_ID")
}

// DownloadManager provides token-based file download registration via RPC.
//
// Allows plugins to register files for HTTP download via a token URL.
// No JWT authentication is needed — the token itself is the auth.
// Accessed via api.DownloadManager from within a plugin.
type DownloadManager struct {
	proxy *rpc.Proxy
}

func newDownloadManager(client *rpc.Client) *DownloadManager {
	ns := getDownloadManagerNamespaces()
	return &DownloadManager{
		proxy: client.CreateProxy(ns.DownloadManagerRPC),
	}
}

// CreateDownload registers a file for HTTP download and returns a
// token-based URL.
func (dm *DownloadManager) CreateDownload(options CreateDownloadOptions) (DownloadToken, error) {
	payload := createDownloadWire{CreateDownloadOptions: options, RemotePluginID: remotePluginID()}

	ctx := context.Background()
	result, err := dm.proxy.Invoke(ctx, "createDownload", payload)
	if err != nil {
		return DownloadToken{}, fmt.Errorf("createDownload: %w", err)
	}

	m, ok := result.(map[string]any)
	if !ok {
		return DownloadToken{}, fmt.Errorf("createDownload: unexpected result type %T", result)
	}

	return decodeDownloadToken(m), nil
}

// CreateStreamDownload registers a streaming file for progressive HTTP
// download. The file is tailed during writing; the marker file signals
// completion.
func (dm *DownloadManager) CreateStreamDownload(options *CreateStreamDownloadOptions) (DownloadToken, error) {
	payload := createStreamDownloadWire{CreateStreamDownloadOptions: *options, RemotePluginID: remotePluginID()}

	ctx := context.Background()
	result, err := dm.proxy.Invoke(ctx, "createStreamDownload", &payload)
	if err != nil {
		return DownloadToken{}, fmt.Errorf("createStreamDownload: %w", err)
	}

	m, ok := result.(map[string]any)
	if !ok {
		return DownloadToken{}, fmt.Errorf("createStreamDownload: unexpected result type %T", result)
	}

	return decodeDownloadToken(m), nil
}

// decodeDownloadToken pulls the typed fields out of the response map.
// expiresAt may arrive as int64, float64, or uint64 depending on the encoder
// path, so it is coerced.
func decodeDownloadToken(m map[string]any) DownloadToken {
	token, _ := m["token"].(string)
	url, _ := m["url"].(string)
	publicURL, _ := m["publicUrl"].(string)
	expiresAtRaw, _ := m["expiresAt"].(int64)
	if expiresAtRaw == 0 {
		if f, ok := m["expiresAt"].(float64); ok {
			expiresAtRaw = int64(f)
		}
		if u, ok := m["expiresAt"].(uint64); ok {
			expiresAtRaw = int64(u)
		}
	}
	return DownloadToken{
		Token:     token,
		URL:       url,
		PublicURL: publicURL,
		ExpiresAt: expiresAtRaw,
	}
}

// DeleteDownload removes a download token and optionally deletes the
// underlying file.
func (dm *DownloadManager) DeleteDownload(token string) error {
	ctx := context.Background()
	_, err := dm.proxy.Invoke(ctx, "deleteDownload", token)
	if err != nil {
		return fmt.Errorf("deleteDownload: %w", err)
	}
	return nil
}
