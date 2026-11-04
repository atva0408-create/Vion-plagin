package sdk

import "testing"

func TestSensorHistoryFromWire(t *testing.T) {
	entries := sensorHistoryFromWire([]any{
		map[string]any{"sensorId": "door", "property": "detected", "value": true, "timestamp": float64(1755800000000)},
		map[string]any{"sensorId": "hall", "property": "current", "value": 21.5, "timestamp": int8(7)},
		map[string]any{"sensorId": "hall", "property": "current", "value": nil},
		"not an entry",
	})

	if len(entries) != 3 {
		t.Fatalf("len = %d, want 3", len(entries))
	}
	if entries[0].Value != true || entries[0].Timestamp != 1755800000000 {
		t.Errorf("first = %+v", entries[0])
	}
	if entries[1].Value != 21.5 || entries[1].Timestamp != 7 {
		t.Errorf("second = %+v", entries[1])
	}
	if entries[2].Value != nil || entries[2].Timestamp != 0 {
		t.Errorf("third = %+v", entries[2])
	}
}
