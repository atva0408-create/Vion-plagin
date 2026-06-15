package sdk

import (
	"context"
	"fmt"

	rpc "github.com/cameraui/rpc/go"
)

// CameraDeviceSource is a camera source (one of the camera's video inputs)
// with snapshot, probe and URL-generation capabilities.
type CameraDeviceSource struct {
	input  CameraInput
	device *CameraDevice
}

// ID returns the unique source ID.
func (s *CameraDeviceSource) ID() string {
	return s.input.ID
}

// Name returns the source display name.
func (s *CameraDeviceSource) Name() string {
	return s.input.Name
}

// Role returns the resolution role of this source.
func (s *CameraDeviceSource) Role() CameraRole {
	return s.input.Role
}

// SourceURL returns the default RTSP URL for this source.
func (s *CameraDeviceSource) SourceURL() string {
	return s.input.Urls.RTSP.Default
}

// Urls returns the generated stream URLs for this source.
func (s *CameraDeviceSource) Urls() StreamUrls {
	return s.input.Urls
}

// UseForSnapshot returns whether this source is used for snapshots.
func (s *CameraDeviceSource) UseForSnapshot() bool {
	return s.input.UseForSnapshot
}

// HotMode returns whether hot mode (always-on connection) is enabled.
func (s *CameraDeviceSource) HotMode() bool {
	return s.input.HotMode
}

// Preload returns whether the stream is preloaded on startup.
func (s *CameraDeviceSource) Preload() bool {
	return s.input.Preload
}

// Prebuffer returns whether stream prebuffering is enabled.
func (s *CameraDeviceSource) Prebuffer() bool {
	return s.input.Prebuffer
}

// Snapshot returns a JPEG snapshot for this source.
// If forceNew is true, the snapshot cache is bypassed.
func (s *CameraDeviceSource) Snapshot(forceNew bool) ([]byte, error) {
	return s.device.getSnapshot(s.input.ID, forceNew)
}

// ProbeStream probes this source for codec and track information.
func (s *CameraDeviceSource) ProbeStream() (*ProbeStream, error) {
	ctx := context.Background()
	result, err := s.device.controllerProxy.Invoke(ctx, "probeStream", s.input.ID)
	if err != nil {
		return nil, fmt.Errorf("probeStream: %w", err)
	}

	if result == nil {
		return nil, nil
	}

	encoded, err := rpc.Encode(result)
	if err != nil {
		return nil, err
	}

	var probe ProbeStream
	if err := rpc.Decode(encoded, &probe); err != nil {
		return nil, err
	}
	return &probe, nil
}

// GetStreamStatus returns the current stream connection status
// (e.g. "connected", "connecting", "error", "idle").
func (s *CameraDeviceSource) GetStreamStatus() (string, error) {
	ctx := context.Background()
	result, err := s.device.controllerProxy.Invoke(ctx, "getStreamStatus", s.input.ID)
	if err != nil {
		return "", err
	}
	if status, ok := result.(string); ok {
		return status, nil
	}
	return "idle", nil
}

// GenerateRTSPUrl generates an RTSP URL for this source with the given options.
func (s *CameraDeviceSource) GenerateRTSPUrl(options *RTSPUrlOptions) (string, error) {
	return BuildTargetUrl(s.Urls().RTSP.Base, options)
}

// GenerateSnapshotUrl generates a snapshot URL for this source with the given options.
func (s *CameraDeviceSource) GenerateSnapshotUrl(options *SnapshotUrlOptions) (string, error) {
	return BuildSnapshotUrl(s.device.Name(), s.Name(), s.Urls().Snapshot.JPEG, options)
}
