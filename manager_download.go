package sdk

import (
	"context"
	"fmt"

	rpc "github.com/cameraui/rpc/go"
)

// DownloadManager provides token-based file download registration via RPC.
//
// Allows plugins to register files for HTTP download via a token URL.
// No JWT authentication is needed — the token itself is the auth.
// Useful for exporting recordings, sharing snapshots, or attaching
// images to outbound notifications. Accessed via api.DownloadManager
// from within a plugin.
type DownloadManager struct {
	proxy *rpc.Proxy
}

// newDownloadManager creates a new DownloadManager.
func newDownloadManager(client *rpc.Client) *DownloadManager {
	ns := getDownloadManagerNamespaces()
	return &DownloadManager{
		proxy: client.CreateProxy(ns.DownloadManagerRPC),
	}
}

// CreateDownload registers a file for HTTP download and returns a
// token-based URL. The download is valid until the TTL expires; control
// when the underlying file is removed from disk via options.Cleanup.
func (dm *DownloadManager) CreateDownload(options CreateDownloadOptions) (DownloadToken, error) {
	ctx := context.Background()
	result, err := dm.proxy.Invoke(ctx, "createDownload", options)
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
// download. The file is tailed during writing; the marker file
// (options.MarkerPath) signals when writing is complete and the
// response can be closed. Useful for serving recordings while they are
// still being exported.
func (dm *DownloadManager) CreateStreamDownload(options *CreateStreamDownloadOptions) (DownloadToken, error) {
	ctx := context.Background()
	result, err := dm.proxy.Invoke(ctx, "createStreamDownload", options)
	if err != nil {
		return DownloadToken{}, fmt.Errorf("createStreamDownload: %w", err)
	}

	m, ok := result.(map[string]any)
	if !ok {
		return DownloadToken{}, fmt.Errorf("createStreamDownload: unexpected result type %T", result)
	}

	return decodeDownloadToken(m), nil
}

// decodeDownloadToken pulls the typed fields out of the msgpack-decoded
// response map. Numeric `expiresAt` may arrive as int64, float64, or uint64
// depending on the encoder path, so we coerce.
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

// DeleteDownload removes a download token from the registry and
// optionally deletes the underlying file (depending on the cleanup mode
// used at creation time). Subsequent requests using the token return
// 404.
func (dm *DownloadManager) DeleteDownload(token string) error {
	ctx := context.Background()
	_, err := dm.proxy.Invoke(ctx, "deleteDownload", token)
	if err != nil {
		return fmt.Errorf("deleteDownload: %w", err)
	}
	return nil
}
