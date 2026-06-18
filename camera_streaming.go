package sdk

// Go2RtcWSSource contains WebSocket streaming URLs from the stream provider.
type Go2RtcWSSource struct {
	// WebRTC is the WebRTC signaling endpoint.
	WebRTC string `msgpack:"webrtc,omitempty" json:"webrtc,omitempty"`
	// MSE is the MSE streaming endpoint.
	MSE string `msgpack:"mse,omitempty" json:"mse,omitempty"`
}

// Go2RtcRTSPSource contains RTSP streaming URLs from the stream provider.
type Go2RtcRTSPSource struct {
	// Base is the base RTSP URL.
	Base string `msgpack:"base,omitempty" json:"base,omitempty"`
	// Default is the default stream (video + audio).
	Default string `msgpack:"default,omitempty" json:"default,omitempty"`
	// Muted is the video-only stream.
	Muted string `msgpack:"muted,omitempty" json:"muted,omitempty"`
	// AudioOnly is the audio-only stream (no video).
	AudioOnly string `msgpack:"audioOnly,omitempty" json:"audioOnly,omitempty"`
	// AAC is the stream URL with AAC audio.
	AAC string `msgpack:"aac,omitempty" json:"aac,omitempty"`
	// Opus is the stream URL with Opus audio.
	Opus string `msgpack:"opus,omitempty" json:"opus,omitempty"`
	// PCMA is the stream URL with PCMA audio.
	PCMA string `msgpack:"pcma,omitempty" json:"pcma,omitempty"`
	// ONVIF is the ONVIF URL.
	ONVIF string `msgpack:"onvif,omitempty" json:"onvif,omitempty"`
	// Prebuffered is the prebuffered stream URL.
	Prebuffered string `msgpack:"prebuffered,omitempty" json:"prebuffered,omitempty"`
	// NoGop is the stream URL with GOP cache disabled.
	NoGop string `msgpack:"noGop,omitempty" json:"noGop,omitempty"`
}

// Go2RtcSnapshotSource contains snapshot/image URLs from the stream provider.
type Go2RtcSnapshotSource struct {
	// MP4 is the MP4 single-frame video URL.
	MP4 string `msgpack:"mp4,omitempty" json:"mp4,omitempty"`
	// JPEG is the JPEG snapshot URL.
	JPEG string `msgpack:"jpeg,omitempty" json:"jpeg,omitempty"`
	// MJPEG is the MJPEG stream URL.
	MJPEG string `msgpack:"mjpeg,omitempty" json:"mjpeg,omitempty"`
}

// StreamUrls is the collection of all streaming URLs for a camera source.
type StreamUrls struct {
	// WS are the WebSocket streaming URLs.
	WS Go2RtcWSSource `msgpack:"ws,omitempty" json:"ws"`
	// RTSP are the RTSP streaming URLs.
	RTSP Go2RtcRTSPSource `msgpack:"rtsp,omitempty" json:"rtsp"`
	// Snapshot are the snapshot/image URLs.
	Snapshot Go2RtcSnapshotSource `msgpack:"snapshot,omitempty" json:"snapshot"`
}

// RTSPUrlOptions is options for generating RTSP URLs.
type RTSPUrlOptions struct {
	// Video toggles inclusion of the video track.
	Video bool `msgpack:"video,omitempty" json:"video"`
	// Audio is the list of audio codecs to include.
	Audio []RTSPAudioCodec `msgpack:"audio,omitempty" json:"audio"`
	// GOP requests a keyframe at start.
	GOP bool `msgpack:"gop,omitempty" json:"gop"`
	// Prebuffer requests the prebuffered stream.
	Prebuffer bool `msgpack:"prebuffer,omitempty" json:"prebuffer"`
	// AudioSingleTrack combines audio tracks into a single track.
	AudioSingleTrack bool `msgpack:"audioSingleTrack,omitempty" json:"audioSingleTrack"`
	// Backchannel enables backchannel (two-way audio).
	Backchannel bool `msgpack:"backchannel,omitempty" json:"backchannel"`
	// Timeout is the connection timeout in seconds.
	Timeout int `msgpack:"timeout,omitempty" json:"timeout"`
}

// SnapshotUrlOptions is options for generating snapshot URLs.
type SnapshotUrlOptions struct {
	// Width is the output width in pixels.
	Width int `msgpack:"width,omitempty" json:"width"`
	// Height is the output height in pixels.
	Height int `msgpack:"height,omitempty" json:"height"`
	// Rotate is the rotation in degrees.
	Rotate int `msgpack:"rotate,omitempty" json:"rotate"`
	// Cache is the cache key/strategy.
	Cache string `msgpack:"cache,omitempty" json:"cache"`
	// HW is the hardware acceleration backend.
	HW string `msgpack:"hw,omitempty" json:"hw"`
	// GOP requests a keyframe at start.
	GOP bool `msgpack:"gop,omitempty" json:"gop"`
	// Prebuffer requests the prebuffered stream.
	Prebuffer bool `msgpack:"prebuffer,omitempty" json:"prebuffer"`
}

// ProbeConfig selects which tracks a stream probe inspects and returns.
type ProbeConfig struct {
	// Video includes video track info.
	Video *bool `msgpack:"video,omitempty" json:"video,omitempty"`
	// Audio includes audio track info — a bool, the string "all", or a
	// []ProbeAudioCodec listing specific codecs.
	Audio any `msgpack:"audio,omitempty" json:"audio,omitempty"`
	// Microphone includes microphone/backchannel info.
	Microphone *bool `msgpack:"microphone,omitempty" json:"microphone,omitempty"`
}

// FMTPInfo holds format parameters (fmtp) from SDP.
type FMTPInfo struct {
	// Payload is the RTP payload type number.
	Payload int `msgpack:"payload" json:"payload"`
	// Config is the codec-specific configuration string.
	Config string `msgpack:"config" json:"config"`
}

// AudioCodecProperties holds audio codec properties from a stream probe.
type AudioCodecProperties struct {
	// SampleRate is the audio sample rate in Hz.
	SampleRate int `msgpack:"sampleRate" json:"sampleRate"`
	// Channels is the number of audio channels.
	Channels int `msgpack:"channels" json:"channels"`
	// PayloadType is the RTP payload type number.
	PayloadType int `msgpack:"payloadType" json:"payloadType"`
	// FmtpInfo holds optional format parameters.
	FmtpInfo *FMTPInfo `msgpack:"fmtpInfo,omitempty" json:"fmtpInfo,omitempty"`
}

// VideoCodecProperties holds video codec properties from a stream probe.
type VideoCodecProperties struct {
	// ClockRate is the video clock rate.
	ClockRate int `msgpack:"clockRate" json:"clockRate"`
	// PayloadType is the RTP payload type number.
	PayloadType int `msgpack:"payloadType" json:"payloadType"`
	// FmtpInfo holds optional format parameters.
	FmtpInfo *FMTPInfo `msgpack:"fmtpInfo,omitempty" json:"fmtpInfo,omitempty"`
}

// ProbeStream is the result of a stream probe — SDP plus track information.
type ProbeStream struct {
	// SDP is the raw SDP string.
	SDP string `msgpack:"sdp,omitempty" json:"sdp,omitempty"`
	// Audio are the available audio tracks.
	Audio []AudioStreamInfo `msgpack:"audio,omitempty" json:"audio,omitempty"`
	// Video are the available video tracks.
	Video []VideoStreamInfo `msgpack:"video,omitempty" json:"video,omitempty"`
}

// VideoStreamInfo is video stream information from a probe.
type VideoStreamInfo struct {
	// Codec is the video codec.
	Codec VideoCodec `msgpack:"codec" json:"codec"`
	// FFmpegCodec is the FFmpeg codec name.
	FFmpegCodec VideoFFmpegCodec `msgpack:"ffmpegCodec" json:"ffmpegCodec"`
	// Properties are the codec properties.
	Properties VideoCodecProperties `msgpack:"properties" json:"properties"`
	// Direction is the stream direction.
	Direction StreamDirection `msgpack:"direction" json:"direction"`
}

// AudioStreamInfo is audio stream information from a probe.
type AudioStreamInfo struct {
	// Codec is the audio codec.
	Codec AudioCodec `msgpack:"codec" json:"codec"`
	// FFmpegCodec is the FFmpeg codec name.
	FFmpegCodec AudioFFmpegCodec `msgpack:"ffmpegCodec" json:"ffmpegCodec"`
	// Properties are the codec properties.
	Properties AudioCodecProperties `msgpack:"properties" json:"properties"`
	// Direction is the stream direction.
	Direction StreamDirection `msgpack:"direction" json:"direction"`
}
