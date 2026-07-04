package sdk

import (
	"sync"
	"testing"
)

func TestDeepCopyValueIsIndependent(t *testing.T) {
	original := map[string]any{
		"nested": map[string]any{"a": 1},
		"list":   []any{map[string]any{"b": 2}},
	}

	copied, ok := deepCopyValue(original).(map[string]any)
	if !ok {
		t.Fatalf("expected map[string]any, got %T", deepCopyValue(original))
	}

	original["nested"].(map[string]any)["a"] = 99
	original["list"].([]any)[0].(map[string]any)["b"] = 99
	original["added"] = true

	if got := copied["nested"].(map[string]any)["a"]; got != 1 {
		t.Errorf("nested map is shared: copied a=%v, want 1", got)
	}
	if got := copied["list"].([]any)[0].(map[string]any)["b"]; got != 2 {
		t.Errorf("nested slice element is shared: copied b=%v, want 2", got)
	}
	if _, exists := copied["added"]; exists {
		t.Error("top-level mutation leaked into the copy")
	}
}

// Reproduces the reported crash at the data-structure level: the async config
// encoder walks the persisted snapshot while the plugin keeps mutating its own
// config map. With a proper deep copy the two share nothing, so `-race` stays
// clean; a shallow copy would flag "concurrent map iteration and map write".
func TestDeepCopyValueRaceIsolation(t *testing.T) {
	source := map[string]any{"cfg": map[string]any{"x": 0, "nested": map[string]any{"y": 0}}}
	copied := deepCopyValue(source)

	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		for i := range 5000 {
			source["cfg"].(map[string]any)["x"] = i
			source["cfg"].(map[string]any)["nested"].(map[string]any)["y"] = i
		}
	}()

	go func() {
		defer wg.Done()
		for range 5000 {
			traverseAny(copied)
		}
	}()

	wg.Wait()
}

func traverseAny(v any) {
	switch val := v.(type) {
	case map[string]any:
		for _, item := range val {
			traverseAny(item)
		}
	case []any:
		for _, item := range val {
			traverseAny(item)
		}
	}
}
