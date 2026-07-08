package sdk

import (
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"sync"
	"testing"
	"time"
)

// Driven by the cross-language conformance suite in
// camera.ui/tests/plugin-store via env vars; skipped in normal `go test`.
func TestStoreConformanceCLI(t *testing.T) {
	cmd := os.Getenv("CUI_STORE_CLI")
	if cmd == "" {
		t.Skip("conformance CLI disabled")
	}

	file := os.Getenv("CUI_STORE_FILE")
	log := newLogger(&loggerOptions{Prefix: "conformance"})

	switch cmd {
	case "write":
		if err := writeStoreFile(file, loadConformanceCorpus(t), log); err != nil {
			t.Fatalf("GO-WRITE FAILED: %v", err)
		}
		fmt.Println("GO-WRITE OK")
	case "verify":
		got, ok, err := readStoreFile(file, log)
		if err != nil || !ok {
			t.Fatalf("GO-VERIFY READ FAILED: ok=%v err=%v", ok, err)
		}
		if !conformanceEqual(loadConformanceCorpus(t), got) {
			data, _ := json.Marshal(got)
			t.Fatalf("GO-VERIFY MISMATCH: %.400s", string(data))
		}
		fmt.Println("GO-VERIFY OK")
	case "edit":
		// Mutations mirrored in gen-corpus.mjs --final (Go section).
		doc, ok, err := readStoreFile(file, log)
		if err != nil || !ok {
			t.Fatalf("GO-EDIT READ FAILED: ok=%v err=%v", ok, err)
		}
		cam := doc["cameras"].(map[string]any)["cam-1"].(map[string]any)
		cam["nested"].(map[string]any)["deeply"].(map[string]any)["nested"].(map[string]any)["via"].(map[string]any)["objectPath"] = "go-edited"
		plugin := doc["plugin"].(map[string]any)
		plugin["oauth.cloud_account.state"] = `{"refresh_token":"ROTATED-BY-GO","expires_at":1783270000}`
		plugin["goAdded"] = map[string]any{"by": "go", "n": 1.5}
		delete(plugin, "eufyHome")
		if err := writeStoreFile(file, doc, log); err != nil {
			t.Fatalf("GO-EDIT WRITE FAILED: %v", err)
		}
		fmt.Println("GO-EDIT OK")
	case "kill-write":
		corpus := loadConformanceCorpus(t)
		plugin := corpus["plugin"].(map[string]any)
		for counter := 1; ; counter++ {
			plugin["killCounter"] = counter
			if err := writeStoreFile(file, corpus, log); err != nil {
				t.Fatalf("GO-KILL-WRITE FAILED: %v", err)
			}
		}
	case "read-counter":
		doc, ok, err := readStoreFile(file, log)
		if err != nil || !ok {
			t.Fatalf("GO-READ-COUNTER FAILED: ok=%v err=%v", ok, err)
		}
		counter := doc["plugin"].(map[string]any)["killCounter"]
		fmt.Printf("GO-READ-COUNTER %v\n", counter)
	case "open-verify":
		// Exercises the production open path: read, legacy layout remap and
		// write-back. CUI_STORE_PLUGIN_ID scopes the remap.
		fp, err := newFilePersistence(file, os.Getenv("CUI_STORE_PLUGIN_ID"), log)
		if err != nil {
			t.Fatalf("GO-OPEN-VERIFY FAILED: %v", err)
		}
		fp.mu.Lock()
		got := fp.doc
		fp.mu.Unlock()
		if !conformanceEqual(loadConformanceCorpus(t), got) {
			data, _ := json.Marshal(got)
			t.Fatalf("GO-OPEN-VERIFY MISMATCH: %.400s", string(data))
		}
		fmt.Println("GO-OPEN-VERIFY OK")
	case "bench":
		corpus := loadConformanceCorpus(t)
		small, _ := deepCopyValue(corpus).(map[string]any)
		delete(small["cameras"].(map[string]any)["cam-1"].(map[string]any), "string_image_1mb")

		benchRun(t, "GO  save 5KB   CUI1", 200, func() {
			if err := writeStoreFile(file+"-small", small, log); err != nil {
				t.Fatal(err)
			}
		})
		benchRun(t, "GO  save 1MB   CUI1", 40, func() {
			if err := writeStoreFile(file+"-large", corpus, log); err != nil {
				t.Fatal(err)
			}
		})
		benchRun(t, "GO  boot load  CUI1 (read+decode+crc)", 100, func() {
			if _, _, err := readStoreFile(file+"-large", log); err != nil {
				t.Fatal(err)
			}
		})

		fp, err := newFilePersistence(file+"-burst", "bench", log)
		if err != nil {
			t.Fatal(err)
		}
		values, _ := small["plugin"].(map[string]any)
		loc := storeLocation{kind: storeLocationPlugin}
		benchRun(t, "GO  burst      CUI1 100 concurrent saves", 20, func() {
			var wg sync.WaitGroup
			for range 100 {
				wg.Go(func() {
					if err := fp.save(loc, values)(); err != nil {
						t.Error(err)
					}
				})
			}
			wg.Wait()
		})
	default:
		t.Fatalf("unknown conformance command: %s", cmd)
	}
}

func benchRun(t *testing.T, name string, iters int, fn func()) {
	t.Helper()
	for range 5 {
		fn()
	}
	samples := make([]time.Duration, 0, iters)
	for range iters {
		start := time.Now()
		fn()
		samples = append(samples, time.Since(start))
	}
	slices.Sort(samples)
	p50 := samples[len(samples)/2]
	p99 := samples[min(len(samples)-1, len(samples)*99/100)]
	fmt.Printf("%-46s p50 %.2fms  p99 %.2fms  (n=%d)\n", name, float64(p50.Microseconds())/1000, float64(p99.Microseconds())/1000, iters)
}

func loadConformanceCorpus(t *testing.T) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(os.Getenv("CUI_STORE_CORPUS"))
	if err != nil {
		t.Fatalf("corpus read failed: %v", err)
	}
	var corpus map[string]any
	if err := json.Unmarshal(raw, &corpus); err != nil {
		t.Fatalf("corpus parse failed: %v", err)
	}
	return corpus
}

// Numbers compare by float64 value: the JSON corpus decodes to float64 while
// the store decodes integers as int64/uint64.
func conformanceEqual(a, b any) bool {
	if af, aok := toConformanceFloat(a); aok {
		bf, bok := toConformanceFloat(b)
		return bok && af == bf
	}

	switch av := a.(type) {
	case nil:
		return b == nil
	case string:
		bv, ok := b.(string)
		return ok && av == bv
	case bool:
		bv, ok := b.(bool)
		return ok && av == bv
	case []any:
		bv, ok := b.([]any)
		if !ok || len(av) != len(bv) {
			return false
		}
		for i := range av {
			if !conformanceEqual(av[i], bv[i]) {
				return false
			}
		}
		return true
	case map[string]any:
		bv, ok := b.(map[string]any)
		if !ok || len(av) != len(bv) {
			return false
		}
		for k, v := range av {
			bvv, exists := bv[k]
			if !exists || !conformanceEqual(v, bvv) {
				return false
			}
		}
		return true
	}
	return false
}

func toConformanceFloat(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
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
	}
	return 0, false
}
