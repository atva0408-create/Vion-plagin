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

func TestIsEqualIgnoresSliceOrder(t *testing.T) {
	a := []Detection{{Label: "people", Confidence: 1}, {Label: "vehicle", Confidence: 1}}
	b := []Detection{{Label: "vehicle", Confidence: 1}, {Label: "people", Confidence: 1}}

	if !isEqual(a, b, true) {
		t.Fatal("reordered detections must compare equal when order is ignored")
	}
	if isEqual(a, b, false) {
		t.Fatal("reordered detections must differ when order matters")
	}

	c := []Detection{{Label: "people", Confidence: 1}, {Label: "people", Confidence: 1}}
	if isEqual(a, c, true) {
		t.Fatal("multiset match must not pair one element twice")
	}
}

func TestIsEqualNormalizesNumericWidths(t *testing.T) {
	// the host echo arrives in a different width than the plugin wrote, the guard must still match
	cases := [][2]any{
		{int(1), int64(1)},
		{float64(1), int(1)},
		{uint8(7), int32(7)},
		{float32(0.5), float64(0.5)},
	}
	for _, c := range cases {
		if !isEqual(c[0], c[1], false) {
			t.Fatalf("%T(%v) and %T(%v) must compare equal", c[0], c[0], c[1], c[1])
		}
	}
	if isEqual(1, "1", false) {
		t.Fatal("a number must not equal its string form")
	}
	if isEqual(true, 1, false) {
		t.Fatal("bool must not be treated as numeric")
	}
}

func TestIsEqualNestedMapsAndSlices(t *testing.T) {
	a := map[string]any{"labels": []string{"a", "b"}, "n": int(3)}
	b := map[string]any{"labels": []string{"b", "a"}, "n": int64(3)}

	if !isEqual(a, b, true) {
		t.Fatal("nested slice order must be ignored inside maps")
	}
	if isEqual(a, b, false) {
		t.Fatal("nested slice order must matter when order is respected")
	}
	if isEqual(a, map[string]any{"labels": []string{"a", "b"}}, true) {
		t.Fatal("maps of different size must differ")
	}
}
