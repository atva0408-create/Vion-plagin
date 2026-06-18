package sdk

import (
	"testing"

	rpc "github.com/cameraui/rpc/go"
)

func keysOf(m map[string]any) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	return ks
}

func TestCameraEmbeddedRoundTrip(t *testing.T) {
	cam := Camera{
		BaseCamera: BaseCamera{ID: "cam1", Name: "Front", Room: "Hall"},
		Sources:    []CameraInput{{ID: "src1", Name: "main"}},
	}
	enc, err := rpc.Encode(cam)
	if err != nil {
		t.Fatal(err)
	}

	var m map[string]any
	if err := rpc.Decode(enc, &m); err != nil {
		t.Fatal(err)
	}
	if _, ok := m["BaseCamera"]; ok {
		t.Fatalf("embedded BaseCamera was NOT inlined; wire keys=%v", keysOf(m))
	}
	for _, k := range []string{"_id", "name", "sources"} {
		if _, ok := m[k]; !ok {
			t.Fatalf("expected flat key %q; wire keys=%v", k, keysOf(m))
		}
	}

	var back Camera
	if err := rpc.Decode(enc, &back); err != nil {
		t.Fatal(err)
	}
	if back.ID != "cam1" || back.Name != "Front" || back.Room != "Hall" || len(back.Sources) != 1 {
		t.Fatalf("round-trip mismatch: %+v", back)
	}
}

func TestCameraConfigEmbeddedRoundTrip(t *testing.T) {
	cfg := CameraConfig{
		BaseCameraConfig: BaseCameraConfig{Name: "New Cam", NativeID: "n1"},
		Sources:          []CameraConfigInputSettings{{Name: "main", Role: CameraRoleHighRes}},
	}
	enc, err := rpc.Encode(cfg)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := rpc.Decode(enc, &m); err != nil {
		t.Fatal(err)
	}
	if _, ok := m["BaseCameraConfig"]; ok {
		t.Fatalf("embedded BaseCameraConfig was NOT inlined; keys=%v", keysOf(m))
	}
	if _, ok := m["name"]; !ok {
		t.Fatalf("expected flat name key; keys=%v", keysOf(m))
	}
}

func TestProbeStreamNestedProperties(t *testing.T) {
	ps := ProbeStream{
		SDP: "v=0",
		Audio: []AudioStreamInfo{{
			Codec:       AudioCodecOpus,
			FFmpegCodec: AudioFFmpegCodecLibopus,
			Properties: AudioCodecProperties{
				SampleRate:  48000,
				Channels:    2,
				PayloadType: 111,
				FmtpInfo:    &FMTPInfo{Payload: 111, Config: "minptime=10"},
			},
			Direction: StreamDirectionSendRecv,
		}},
	}
	enc, err := rpc.Encode(ps)
	if err != nil {
		t.Fatal(err)
	}
	var back ProbeStream
	if err := rpc.Decode(enc, &back); err != nil {
		t.Fatal(err)
	}
	if len(back.Audio) != 1 {
		t.Fatalf("expected 1 audio track, got %d", len(back.Audio))
	}
	a := back.Audio[0]
	if a.Properties.SampleRate != 48000 || a.Properties.Channels != 2 || a.Properties.PayloadType != 111 {
		t.Fatalf("audio properties mismatch: %+v", a.Properties)
	}
	if a.Properties.FmtpInfo == nil || a.Properties.FmtpInfo.Config != "minptime=10" {
		t.Fatalf("fmtpInfo mismatch: %+v", a.Properties.FmtpInfo)
	}
}
