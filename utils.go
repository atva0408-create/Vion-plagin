package sdk

import (
	"fmt"
	"net/url"
	"reflect"
	"strings"

	rpc "github.com/cameraui/rpc/go"
)

// isEqual is a deep equality check for arbitrary values.
//
// Recursively compares primitives, slices, maps, and structs. Map
// comparison ignores key declaration order (only key/value pairs
// matter); slice comparison is order-sensitive.
//
// Typically used for property-change detection on sensors: a property
// update is only emitted when the new value is not deeply equal to the
// previous value, which avoids redundant events for unchanged data.
func isEqual(a, b any) bool {
	return reflect.DeepEqual(a, b)
}

// Bool returns a pointer to the given bool value.
// Use this for optional pointer fields in JsonSchema (e.g., Store: sdk.Bool(true)).
//
//go:fix inline
func Bool(v bool) *bool {
	p := v
	return &p
}

// Int returns a pointer to the given int value.
// Use this for optional pointer fields in JsonSchema (e.g., MinLength: sdk.Int(5)).
func Int(v int) *int {
	p := v
	return &p
}

// Float64 returns a pointer to the given float64 value.
// Use this for optional pointer fields in JsonSchema (e.g., Minimum: sdk.Float64(0.5)).
func Float64(v float64) *float64 {
	p := v
	return &p
}

// decodeMsgpack decodes msgpack data into target and logs any decode errors.
// Returns true on success, false on error. Use this instead of rpc.Decode
// in subscribe callbacks to ensure decode errors are never silently swallowed.
// Uses DecodeMessageInto: subscription payloads arrive as raw wire bytes and
// may be CUIB frames (publisher extracted ≥16KB binaries out-of-band, e.g.
// detection events with thumbnails); plain msgpack passes through unchanged.
// The error includes payload length + leading bytes — a decode failure here
// means a wire/versioning problem (raw chunk leaked past reassembly, stale
// peer, corrupted frame) and the head bytes identify which one.
func decodeMsgpack(logger *Logger, data []byte, target any, context string) bool {
	if err := rpc.DecodeMessageInto(data, target); err != nil {
		head := data
		if len(head) > 16 {
			head = head[:16]
		}
		logger.Error(fmt.Sprintf("msgpack decode error [%s] len=%d head=% x: %v", context, len(data), head, err))
		return false
	}
	return true
}

// BuildTargetUrl constructs a go2rtc-compatible RTSP target URL from a base
// RTSP URL and a set of stream selection options (video/audio tracks, GOP,
// timeout). Returns the URL with all selected query parameters.
func BuildTargetUrl(rtspUrl string, opts *RTSPUrlOptions) (string, error) {
	u, err := url.Parse(rtspUrl)
	if err != nil {
		return "", err
	}
	baseUrl := fmt.Sprintf("%s://%s%s", u.Scheme, u.Host, u.Path)

	if opts == nil {
		opts = &RTSPUrlOptions{
			Video:            true,
			Audio:            []RTSPAudioCodec{},
			AudioSingleTrack: true,
			Timeout:          15,
			GOP:              true,
		}
	}

	timeout := min(max(5, opts.Timeout), 30)
	var params []string

	if opts.Video {
		params = append(params, "video")
	}

	if opts.Audio != nil {
		switch {
		case len(opts.Audio) == 0:
			params = append(params, "audio")
		case opts.AudioSingleTrack:
			codecs := make([]string, len(opts.Audio))
			for i, c := range opts.Audio {
				codecs[i] = string(c)
			}
			params = append(params, "audio="+strings.Join(codecs, ","))
		default:
			for _, codec := range opts.Audio {
				params = append(params, "audio="+string(codec))
			}
		}
	}

	if opts.Backchannel {
		params = append(params, "backchannel=opus,pcma,pcmu")
	}

	if opts.GOP {
		params = append(params, "gop=1")
	} else {
		params = append(params, "gop=0")
	}

	params = append(params, fmt.Sprintf("timeout=%d", timeout))

	return baseUrl + "?" + strings.Join(params, "&"), nil
}

// BuildSnapshotUrl constructs a go2rtc-compatible snapshot URL for the given
// camera/source pair. Optional dimensions, rotation, cache and hardware
// transcode flags are appended as query parameters.
func BuildSnapshotUrl(cameraName, sourceName, snapshotUrl string, opts *SnapshotUrlOptions) (string, error) {
	u, err := url.Parse(snapshotUrl)
	if err != nil {
		return "", err
	}
	baseUrl := fmt.Sprintf("%s://%s%s", u.Scheme, u.Host, u.Path)

	if opts == nil {
		opts = &SnapshotUrlOptions{
			GOP: true,
		}
	}

	var params []string
	source := createSourceName(cameraName, sourceName)
	params = append(params, fmt.Sprintf("src=%s", source))

	if opts.Width > 0 {
		params = append(params, fmt.Sprintf("w=%d", opts.Width))
	}

	if opts.Height > 0 {
		params = append(params, fmt.Sprintf("h=%d", opts.Height))
	}

	if opts.Rotate > 0 {
		params = append(params, fmt.Sprintf("rotate=%d", opts.Rotate))
	}

	if opts.Cache != "" {
		params = append(params, "cache="+opts.Cache)
	}

	if opts.HW != "" {
		params = append(params, "hw="+opts.HW)
	}

	if opts.GOP {
		params = append(params, "gop=1")
	} else {
		params = append(params, "gop=0")
	}

	return baseUrl + "?" + strings.Join(params, "&"), nil
}

func createSourceName(cameraName, sourceName string) string {
	return "cui_" + strings.ToLower(strings.ReplaceAll(cameraName, " ", "_")) + "_" + strings.ToLower(strings.ReplaceAll(sourceName, " ", "_"))
}
