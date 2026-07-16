package sdk

import (
	"strconv"
	"strings"
	"testing"
)

// -90 is a legal go2rtc rotation (alias of 270, both transpose=2), so the
// guard must gate on "not zero" rather than "positive".
func TestBuildSnapshotUrlRotate(t *testing.T) {
	for _, rotate := range []int{-90, 90, 180, 270} {
		got, err := BuildSnapshotUrl("Front Door", "main", "http://host:1984/api/frame.jpeg", &SnapshotUrlOptions{Rotate: rotate})
		if err != nil {
			t.Fatal(err)
		}
		want := "rotate=" + strconv.Itoa(rotate)
		if !strings.Contains(got, want) {
			t.Fatalf("rotate=%d: expected %q in %q", rotate, want, got)
		}
	}
}

func TestBuildSnapshotUrlOmitsZeroRotate(t *testing.T) {
	got, err := BuildSnapshotUrl("Front Door", "main", "http://host:1984/api/frame.jpeg", &SnapshotUrlOptions{Rotate: 0})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(got, "rotate=") {
		t.Fatalf("rotate=0 is a no-op and must not be emitted: %q", got)
	}
}
