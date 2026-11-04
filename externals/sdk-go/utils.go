package sdk

import (
	"fmt"
	"net/url"
	"reflect"
	"strings"

	rpc "github.com/cameraui/rpc/go"
)

// Bool returns a pointer to v, for the optional pointer fields of JsonSchema
// (e.g. Store: sdk.Bool(true)).
//
//go:fix inline
func Bool(v bool) *bool {
	p := v
	return &p
}

// Int returns a pointer to v, for the optional pointer fields of JsonSchema
// (e.g. MinLength: sdk.Int(5)).
func Int(v int) *int {
	p := v
	return &p
}

// Float64 returns a pointer to v, for the optional pointer fields of JsonSchema
// (e.g. Minimum: sdk.Float64(0.5)).
func Float64(v float64) *float64 {
	p := v
	return &p
}

// BuildTargetUrl constructs a go2rtc-compatible RTSP target URL from a base
// RTSP URL and a set of stream selection options (video/audio tracks, GOP,
// timeout). Timeout is clamped to 5..30 seconds.
//
// Example:
//
//	url, err := sdk.BuildTargetUrl(base, &sdk.RTSPUrlOptions{Video: true, GOP: true, Timeout: 15})
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
//
// Example:
//
//	url, err := sdk.BuildSnapshotUrl("Front Door", "main", base, &sdk.SnapshotUrlOptions{Width: 640})
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

	if opts.Rotate != 0 {
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

// msgpack round-trips a number into a different width than the plugin wrote, so
// numbers compare by value; ignoreOrder compares any list as a multiset
func isEqual(a, b any, ignoreOrder bool) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}

	if an, aok := asNumber(a); aok {
		bn, bok := asNumber(b)
		return bok && an == bn
	}

	va, vb := reflect.ValueOf(a), reflect.ValueOf(b)

	switch va.Kind() {
	case reflect.Slice, reflect.Array:
		if vb.Kind() != reflect.Slice && vb.Kind() != reflect.Array {
			return false
		}
		if va.Len() != vb.Len() {
			return false
		}
		if !ignoreOrder {
			for i := range va.Len() {
				if !isEqual(va.Index(i).Interface(), vb.Index(i).Interface(), ignoreOrder) {
					return false
				}
			}
			return true
		}
		used := make([]bool, vb.Len())
		for i := range va.Len() {
			matched := false
			for j := range vb.Len() {
				if used[j] || !isEqual(va.Index(i).Interface(), vb.Index(j).Interface(), ignoreOrder) {
					continue
				}
				used[j], matched = true, true
				break
			}
			if !matched {
				return false
			}
		}
		return true

	case reflect.Map:
		if vb.Kind() != reflect.Map || va.Len() != vb.Len() {
			return false
		}
		for _, k := range va.MapKeys() {
			other := vb.MapIndex(k)
			if !other.IsValid() || !isEqual(va.MapIndex(k).Interface(), other.Interface(), ignoreOrder) {
				return false
			}
		}
		return true
	}

	return reflect.DeepEqual(a, b)
}

func asNumber(v any) (float64, bool) {
	switch n := v.(type) {
	case int:
		return float64(n), true
	case int8:
		return float64(n), true
	case int16:
		return float64(n), true
	case int32:
		return float64(n), true
	case int64:
		return float64(n), true
	case uint:
		return float64(n), true
	case uint8:
		return float64(n), true
	case uint16:
		return float64(n), true
	case uint32:
		return float64(n), true
	case uint64:
		return float64(n), true
	case float32:
		return float64(n), true
	case float64:
		return n, true
	}
	return 0, false
}

// use this instead of rpc.Decode in subscribe callbacks: it logs instead of
// swallowing, and subscription payloads may be CUIB frames, not plain msgpack
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

func createSourceName(cameraName, sourceName string) string {
	return "cui_" + strings.ToLower(strings.ReplaceAll(cameraName, " ", "_")) + "_" + strings.ToLower(strings.ReplaceAll(sourceName, " ", "_"))
}
