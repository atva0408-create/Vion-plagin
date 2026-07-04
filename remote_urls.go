package sdk

import (
	"os"
	"regexp"
	"strings"
)

var localhostPattern = regexp.MustCompile(`127\.0\.0\.1|localhost`)

// rewriteURLForRemote makes a single URL reachable from a worker: swaps the
// master's 127.0.0.1/localhost for its LAN address and injects the go2rtc RTSP
// credentials (remote connections are authenticated; local ones are not).
func rewriteURLForRemote(url, master, user, password string) string {
	rewritten := localhostPattern.ReplaceAllString(url, master)

	if user != "" && strings.HasPrefix(rewritten, "rtsp://") {
		hostPart := strings.SplitN(strings.TrimPrefix(rewritten, "rtsp://"), "/", 2)[0]
		if !strings.Contains(hostPart, "@") {
			rewritten = strings.Replace(rewritten, "rtsp://", "rtsp://"+user+":"+password+"@", 1)
		}
	}

	return rewritten
}

// rewriteStreamUrlsForRemote rewrites every URL in a source's StreamUrls in
// place when this plugin is hosted on a remote worker. No-op locally.
func rewriteStreamUrlsForRemote(urls *StreamUrls) {
	master := os.Getenv("CAMERAUI_MASTER_ADDRESS")
	if os.Getenv("PLUGIN_REMOTE_MODE") == "" || master == "" {
		return
	}

	user := os.Getenv("CAMERAUI_RTSP_USERNAME")
	password := os.Getenv("CAMERAUI_RTSP_PASSWORD")

	rw := func(s string) string { return rewriteURLForRemote(s, master, user, password) }

	urls.RTSP.Base = rw(urls.RTSP.Base)
	urls.RTSP.Default = rw(urls.RTSP.Default)
	urls.RTSP.Muted = rw(urls.RTSP.Muted)
	urls.RTSP.AudioOnly = rw(urls.RTSP.AudioOnly)
	urls.RTSP.AAC = rw(urls.RTSP.AAC)
	urls.RTSP.Opus = rw(urls.RTSP.Opus)
	urls.RTSP.PCMA = rw(urls.RTSP.PCMA)
	urls.RTSP.ONVIF = rw(urls.RTSP.ONVIF)
	urls.RTSP.NoGop = rw(urls.RTSP.NoGop)
	urls.Snapshot.MP4 = rw(urls.Snapshot.MP4)
	urls.Snapshot.JPEG = rw(urls.Snapshot.JPEG)
	urls.Snapshot.MJPEG = rw(urls.Snapshot.MJPEG)
	urls.WS.MSE = rw(urls.WS.MSE)
	urls.WS.WebRTC = rw(urls.WS.WebRTC)
}
