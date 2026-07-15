package sdk

import (
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func testLogger() *Logger {
	return newLogger(&loggerOptions{Prefix: "test"})
}

func TestEnvelopeRoundTrip(t *testing.T) {
	payload := map[string]any{
		"plugin": map[string]any{
			"name":    "cam",
			"count":   int64(3),
			"ratio":   1.5,
			"enabled": true,
			"list":    []any{"a", int64(1)},
		},
	}

	buf, err := encodeEnvelope(payload)
	if err != nil {
		t.Fatal(err)
	}
	if string(buf[:4]) != "CUI1" {
		t.Fatalf("bad magic: %q", buf[:4])
	}

	decoded, err := decodeEnvelope(buf)
	if err != nil {
		t.Fatal(err)
	}
	plugin, ok := decoded["plugin"].(map[string]any)
	if !ok {
		t.Fatalf("plugin section is %T", decoded["plugin"])
	}
	if plugin["name"] != "cam" || plugin["enabled"] != true {
		t.Errorf("round-trip mismatch: %v", plugin)
	}
	if !deepEqualLoose(plugin["count"], 3) || !deepEqualLoose(plugin["ratio"], 1.5) {
		t.Errorf("numeric round-trip mismatch: %v", plugin)
	}
}

func TestEnvelopeEmptyDoc(t *testing.T) {
	buf, err := encodeEnvelope(map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if len(buf) != 9 {
		t.Fatalf("empty envelope is %d bytes, want 9", len(buf))
	}
	if _, err := decodeEnvelope(buf); err != nil {
		t.Fatal(err)
	}
}

func TestDecodeEnvelopeRejectsCorruption(t *testing.T) {
	buf, err := encodeEnvelope(map[string]any{"plugin": map[string]any{"a": int64(1)}})
	if err != nil {
		t.Fatal(err)
	}

	badMagic := append([]byte("XXXX"), buf[4:]...)
	if _, err := decodeEnvelope(badMagic); err == nil {
		t.Error("bad magic accepted")
	}

	badCRC := append([]byte(nil), buf...)
	badCRC[len(badCRC)-1] ^= 0xff
	if _, err := decodeEnvelope(badCRC); err == nil {
		t.Error("bad CRC accepted")
	}

	var corrupt *storeCorruptError
	_, err = decodeEnvelope(badCRC)
	if !errors.As(err, &corrupt) {
		t.Errorf("corruption error has type %T", err)
	}
}

func TestReadStoreFileMissing(t *testing.T) {
	payload, found, err := readStoreFile(filepath.Join(t.TempDir(), "store.cui"), testLogger())
	if err != nil || found || payload != nil {
		t.Fatalf("missing file: payload=%v found=%v err=%v", payload, found, err)
	}
}

func TestReadStoreFileBackupFallback(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "store.cui")
	log := testLogger()

	good := map[string]any{"plugin": map[string]any{"token": "keep-me"}}
	if err := writeStoreFile(path, good, log); err != nil {
		t.Fatal(err)
	}
	backupStoreFile(path, log)
	if err := os.WriteFile(path, []byte("garbage"), 0o644); err != nil {
		t.Fatal(err)
	}

	payload, found, err := readStoreFile(path, log)
	if err != nil || !found {
		t.Fatalf("backup fallback failed: found=%v err=%v", found, err)
	}
	if payload["plugin"].(map[string]any)["token"] != "keep-me" {
		t.Errorf("backup payload mismatch: %v", payload)
	}
}

func TestReadStoreFileCorruptWithoutBackupFails(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "store.cui")
	if err := os.WriteFile(path, []byte("garbage"), 0o644); err != nil {
		t.Fatal(err)
	}

	// A corrupt store must fail the open, never read as empty.
	_, _, err := readStoreFile(path, testLogger())
	if err == nil {
		t.Fatal("corrupt store opened as empty")
	}
}

func TestRemapLegacyGoLayout(t *testing.T) {
	log := testLogger()
	legacy := map[string]any{
		"my-plugin.plugin":          map[string]any{"a": int64(1)},
		"my-plugin.camera.cam-1":    map[string]any{"b": int64(2)},
		"my-plugin.sensor.cam-1.s1": map[string]any{"c": int64(3)},
	}

	doc, changed := remapLegacyGoLayout(legacy, "my-plugin", log)
	if !changed {
		t.Fatal("legacy layout not detected")
	}
	if doc["plugin"].(map[string]any)["a"] != int64(1) {
		t.Errorf("plugin remap failed: %v", doc)
	}
	cameras := doc["cameras"].(map[string]any)
	if cameras["cam-1"].(map[string]any)["b"] != int64(2) {
		t.Errorf("camera remap failed: %v", doc)
	}
	if _, exists := doc["sensors"]; exists {
		t.Error("legacy sensor keys must be dropped")
	}

	again, changedAgain := remapLegacyGoLayout(doc, "my-plugin", log)
	if changedAgain {
		t.Error("remap is not idempotent")
	}
	if fmt.Sprint(again) != fmt.Sprint(doc) {
		t.Error("idempotent remap altered the document")
	}
}

func TestLocationReadWriteDelete(t *testing.T) {
	doc := map[string]any{}
	sensorLoc := storeLocation{kind: storeLocationSensor, cameraID: "cam", sensorType: "motion", sensorName: "front"}

	writeLocation(doc, storeLocation{kind: storeLocationPlugin}, map[string]any{"p": int64(1)})
	writeLocation(doc, storeLocation{kind: storeLocationCamera, cameraID: "cam"}, map[string]any{"c": int64(2)})
	writeLocation(doc, sensorLoc, map[string]any{"s": int64(3)})

	if readLocation(doc, sensorLoc)["s"] != int64(3) {
		t.Errorf("sensor read failed: %v", doc)
	}
	if readLocation(doc, storeLocation{kind: storeLocationCamera, cameraID: "other"}) != nil {
		t.Error("unknown camera should read nil")
	}

	deleteLocation(doc, sensorLoc)
	if _, exists := doc["sensors"]; exists {
		t.Errorf("empty sensors section not pruned: %v", doc)
	}
	deleteLocation(doc, storeLocation{kind: storeLocationCamera, cameraID: "cam"})
	if _, exists := doc["cameras"]; exists {
		t.Errorf("empty cameras section not pruned: %v", doc)
	}
	deleteLocation(doc, storeLocation{kind: storeLocationPlugin})
	if len(doc) != 0 {
		t.Errorf("document not empty after deletes: %v", doc)
	}
}

func TestCoalescingWriterCollapsesBurst(t *testing.T) {
	var flushes atomic.Int32
	release := make(chan struct{})
	first := make(chan struct{})
	var firstOnce sync.Once

	w := newCoalescingWriter(func(snapshot any) error {
		flushes.Add(1)
		firstOnce.Do(func() { close(first) })
		<-release
		return nil
	}, testLogger())

	var wg sync.WaitGroup
	wg.Go(func() {
		_ = w.write(1)
	})
	<-first

	const burst = 25
	for i := range burst {
		wg.Go(func() {
			if err := w.write(i); err != nil {
				t.Errorf("burst write error: %v", err)
			}
		})
	}

	// Give the burst time to register as pending before releasing the flush.
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()

	if got := flushes.Load(); got != 2 {
		t.Errorf("burst of %d writes cost %d flushes, want 2", burst+1, got)
	}
}

func TestCoalescingWriterPropagatesErrors(t *testing.T) {
	flushErr := errors.New("disk full")
	w := newCoalescingWriter(func(any) error { return flushErr }, testLogger())
	if err := w.write(1); !errors.Is(err, flushErr) {
		t.Errorf("got %v, want %v", err, flushErr)
	}
}

func TestCoalescingWriterPanicDoesNotStrandWaiters(t *testing.T) {
	release := make(chan struct{})
	first := make(chan struct{})
	var firstOnce sync.Once
	var calls atomic.Int32

	w := newCoalescingWriter(func(any) error {
		if calls.Add(1) > 1 {
			panic("flush exploded")
		}
		firstOnce.Do(func() { close(first) })
		<-release
		return nil
	}, testLogger())

	go func() { _ = w.write(1) }()
	<-first

	done := make(chan error, 1)
	go func() { done <- w.write(2) }()
	time.Sleep(20 * time.Millisecond)
	close(release)

	select {
	case err := <-done:
		if err == nil {
			t.Error("panicking flush returned nil error to waiter")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("waiter stranded after flush panic")
	}

	// The writer must still be usable after a panic.
	if err := w.write(3); err == nil {
		t.Error("subsequent write should surface the panicking flush error")
	}
}

func TestFilePersistenceRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "store.cui")
	log := testLogger()

	fp, err := newFilePersistence(path, "my-plugin", log)
	if err != nil {
		t.Fatal(err)
	}

	camLoc := storeLocation{kind: storeLocationCamera, cameraID: "cam-1"}
	if err := fp.save(camLoc, map[string]any{"host": "10.0.0.2"})(); err != nil {
		t.Fatal(err)
	}

	reopened, err := newFilePersistence(path, "my-plugin", log)
	if err != nil {
		t.Fatal(err)
	}
	values := reopened.load(camLoc)
	if values["host"] != "10.0.0.2" {
		t.Errorf("reopened store lost data: %v", values)
	}

	// Saving an empty map removes the section from the document entirely.
	if err := reopened.save(camLoc, map[string]any{})(); err != nil {
		t.Fatal(err)
	}
	final, err := newFilePersistence(path, "my-plugin", log)
	if err != nil {
		t.Fatal(err)
	}
	if final.load(camLoc) != nil {
		t.Error("emptied location still present after reopen")
	}
}

func TestFilePersistenceMigratesLegacyLayout(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "store.cui")
	log := testLogger()

	legacy := map[string]any{"my-plugin.plugin": map[string]any{"token": "abc"}}
	if err := writeStoreFile(path, legacy, log); err != nil {
		t.Fatal(err)
	}

	fp, err := newFilePersistence(path, "my-plugin", log)
	if err != nil {
		t.Fatal(err)
	}
	if fp.load(storeLocation{kind: storeLocationPlugin})["token"] != "abc" {
		t.Error("legacy plugin values not remapped")
	}

	// The migration is written back immediately: the raw file is canonical.
	payload, found, err := readStoreFile(path, log)
	if err != nil || !found {
		t.Fatal(err)
	}
	if _, hasLegacy := payload["my-plugin.plugin"]; hasLegacy {
		t.Errorf("legacy key survived migration write-back: %v", payload)
	}
	if payload["plugin"].(map[string]any)["token"] != "abc" {
		t.Errorf("canonical key missing after migration: %v", payload)
	}
}

func TestValidateStoreValue(t *testing.T) {
	valid := []any{
		nil, "text", true, 42, int64(1) << 52, -42, 3.14, []any{"a", 1},
		map[string]any{"nested": map[string]any{"x": 1.5}}, []string{"typed"},
	}
	for _, v := range valid {
		if err := validateStoreValue("k", v); err != nil {
			t.Errorf("valid value %v rejected: %v", v, err)
		}
	}

	invalid := []any{
		math.NaN(), math.Inf(1), math.Inf(-1),
		int64(1) << 53, uint64(1) << 53, -(int64(1) << 53),
		float64(1 << 54),
		[]byte("binary"),
		time.Now(),
		map[int]any{1: "x"},
		map[string]any{"nested": math.NaN()},
		[]any{[]byte("nested binary")},
	}
	for _, v := range invalid {
		if err := validateStoreValue("k", v); err == nil {
			t.Errorf("invalid value %v (%T) accepted", v, v)
		}
	}
}

// memPersistence records saves for DeviceStorage tests.
type memPersistence struct {
	mu    sync.Mutex
	doc   map[string]any
	saves int
	err   error
}

func newMemPersistence() *memPersistence {
	return &memPersistence{doc: map[string]any{}}
}

func (mp *memPersistence) load(loc storeLocation) map[string]any {
	mp.mu.Lock()
	defer mp.mu.Unlock()
	values := readLocation(mp.doc, loc)
	if values == nil {
		return nil
	}
	copied, _ := deepCopyValue(values).(map[string]any)
	return copied
}

func (mp *memPersistence) save(loc storeLocation, values map[string]any) func() error {
	mp.mu.Lock()
	defer mp.mu.Unlock()
	if mp.err != nil {
		err := mp.err
		return func() error { return err }
	}
	mp.saves++
	if len(values) == 0 {
		deleteLocation(mp.doc, loc)
	} else {
		copied, _ := deepCopyValue(values).(map[string]any)
		writeLocation(mp.doc, loc, copied)
	}
	return func() error { return nil }
}

func (mp *memPersistence) persisted(loc storeLocation) map[string]any {
	mp.mu.Lock()
	defer mp.mu.Unlock()
	return readLocation(mp.doc, loc)
}

func TestDeviceStoragePersistRule(t *testing.T) {
	mp := newMemPersistence()
	loc := storeLocation{kind: storeLocationPlugin}
	ds := newDeviceStorage(mp, loc, testLogger())

	ds.DefineSchemas([]JsonSchema{
		{Type: JsonSchemaTypeString, Key: "stored", Store: Bool(true)},
		{Type: JsonSchemaTypeString, Key: "memoryOnly"},
		{Type: JsonSchemaTypeString, Key: "storeFalse", Store: Bool(false)},
	})

	if err := ds.SetValue("stored", "on-disk"); err != nil {
		t.Fatal(err)
	}
	if err := ds.SetValue("memoryOnly", "ram"); err != nil {
		t.Fatal(err)
	}
	if err := ds.SetValue("storeFalse", "ram-too"); err != nil {
		t.Fatal(err)
	}
	if err := ds.SetInternalValue("_internal", "always"); err != nil {
		t.Fatal(err)
	}

	got := mp.persisted(loc)
	if got["stored"] != "on-disk" || got["_internal"] != "always" {
		t.Errorf("persisted map missing expected keys: %v", got)
	}
	if _, exists := got["memoryOnly"]; exists {
		t.Errorf("schema without Store=true was persisted: %v", got)
	}
	if _, exists := got["storeFalse"]; exists {
		t.Errorf("Store=false key was persisted: %v", got)
	}

	// nil deletes the key everywhere.
	if err := ds.SetValue("stored", nil); err != nil {
		t.Fatal(err)
	}
	if ds.HasValue("stored") {
		t.Error("nil did not delete the in-memory value")
	}
	if _, exists := mp.persisted(loc)["stored"]; exists {
		t.Error("nil did not delete the persisted value")
	}
}

func TestDeviceStorageRejectsInvalidValues(t *testing.T) {
	mp := newMemPersistence()
	ds := newDeviceStorage(mp, storeLocation{kind: storeLocationPlugin}, testLogger())
	ds.DefineSchemas([]JsonSchema{{Type: JsonSchemaTypeNumber, Key: "num", Store: Bool(true)}})

	if err := ds.SetValue("num", 1.0); err != nil {
		t.Fatal(err)
	}
	if err := ds.SetValue("num", math.NaN()); err == nil {
		t.Fatal("NaN accepted")
	}
	if got := ds.GetValue("num"); got != 1.0 {
		t.Errorf("rejected write clobbered the previous value: %v", got)
	}
	if err := ds.SetConfig(map[string]any{"num": math.Inf(1)}); err == nil {
		t.Fatal("Infinity accepted via SetConfig")
	}
	if err := ds.SetInternalValue("_blob", []byte{1}); err == nil {
		t.Fatal("binary accepted via SetInternalValue")
	}
}

func TestDeviceStoragePropagatesSaveErrors(t *testing.T) {
	mp := newMemPersistence()
	ds := newDeviceStorage(mp, storeLocation{kind: storeLocationPlugin}, testLogger())
	ds.DefineSchemas([]JsonSchema{{Type: JsonSchemaTypeString, Key: "k", Store: Bool(true)}})

	mp.mu.Lock()
	mp.err = errors.New("store unavailable")
	mp.mu.Unlock()

	if err := ds.SetValue("k", "v"); err == nil {
		t.Error("SetValue swallowed the save error")
	}
	if err := ds.Save(); err == nil {
		t.Error("Save swallowed the save error")
	}
	if err := ds.SetConfig(map[string]any{"k": "v2"}); err == nil {
		t.Error("SetConfig swallowed the save error")
	}
	if err := ds.SetInternalValue("_x", 1); err == nil {
		t.Error("SetInternalValue swallowed the save error")
	}
}

// RPC msgpack decodes numbers to the narrowest fitting type; the write path
// must normalize like the load path or type switches on GetValue results miss.
func TestDeviceStorageNormalizesRPCNumericTypes(t *testing.T) {
	mp := newMemPersistence()
	ds := newDeviceStorage(mp, storeLocation{kind: storeLocationPlugin}, testLogger())
	ds.DefineSchemas([]JsonSchema{
		{Type: JsonSchemaTypeNumber, Key: "a", Store: Bool(true)},
		{Type: JsonSchemaTypeNumber, Key: "b", Store: Bool(true)},
		{Type: JsonSchemaTypeNumber, Key: "c", Store: Bool(true)},
	})

	if err := ds.SetValue("a", int8(50)); err != nil {
		t.Fatal(err)
	}
	if got := ds.GetValue("a"); got != int64(50) {
		t.Errorf("SetValue(int8) stored %T(%v), want int64(50)", got, got)
	}

	if err := ds.SetConfig(map[string]any{"b": uint64(30), "c": float32(1.5)}); err != nil {
		t.Fatal(err)
	}
	if got := ds.GetValue("b"); got != int64(30) {
		t.Errorf("SetConfig(uint64) stored %T(%v), want int64(30)", got, got)
	}
	if got := ds.GetValue("c"); got != float64(float32(1.5)) {
		t.Errorf("SetConfig(float32) stored %T(%v), want float64", got, got)
	}

	if err := ds.SetInternalValue("_d", uint16(7)); err != nil {
		t.Fatal(err)
	}
	if got := ds.GetValue("_d"); got != int64(7) {
		t.Errorf("SetInternalValue(uint16) stored %T(%v), want int64(7)", got, got)
	}
}

// watchdog fails the test if fn does not return within the deadline —
// the concurrency tests must fail on deadlock instead of hanging.
func watchdog(t *testing.T, timeout time.Duration, fn func()) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		defer close(done)
		fn()
	}()
	select {
	case <-done:
	case <-time.After(timeout):
		t.Fatal("deadlock: operation did not complete within the watchdog deadline")
	}
}

func TestDeviceStorageConcurrentStress(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "store.cui")
	fp, err := newFilePersistence(path, "my-plugin", testLogger())
	if err != nil {
		t.Fatal(err)
	}
	loc := storeLocation{kind: storeLocationPlugin}
	ds := newDeviceStorage(fp, loc, testLogger())

	const goroutines, iters = 8, 100
	schemas := make([]JsonSchema, 0, 2+goroutines)
	schemas = append(schemas,
		JsonSchema{Type: JsonSchemaTypeNumber, Key: "counter", Store: Bool(true)},
		JsonSchema{Type: JsonSchemaTypeString, Key: "label", Store: Bool(true)},
	)
	for g := range goroutines {
		schemas = append(schemas, JsonSchema{Type: JsonSchemaTypeNumber, Key: fmt.Sprintf("own-%d", g), Store: Bool(true)})
	}
	ds.DefineSchemas(schemas)

	watchdog(t, 60*time.Second, func() {
		var wg sync.WaitGroup
		for g := range goroutines {
			wg.Go(func() {
				key := fmt.Sprintf("own-%d", g)
				for i := range iters {
					switch (g + i) % 4 {
					case 0:
						if err := ds.SetValue("counter", i); err != nil {
							t.Errorf("SetValue: %v", err)
						}
					case 1:
						_ = ds.GetValue("counter")
						_ = ds.GetValue("label", "fallback")
					case 2:
						if err := ds.Save(); err != nil {
							t.Errorf("Save: %v", err)
						}
					case 3:
						if err := ds.SetConfig(map[string]any{"label": fmt.Sprintf("g%d-%d", g, i)}); err != nil {
							t.Errorf("SetConfig: %v", err)
						}
					}
					if err := ds.SetValue(key, i); err != nil {
						t.Errorf("SetValue(%s): %v", key, err)
					}
				}
			})
		}
		wg.Wait()
	})

	// Every acknowledged write must be durable: reload the file from disk and
	// check that no goroutine's last acknowledged value was overwritten by a
	// staler concurrent whole-document snapshot.
	reloaded, err := newFilePersistence(path, "my-plugin", testLogger())
	if err != nil {
		t.Fatal(err)
	}
	values := reloaded.load(loc)
	for g := range goroutines {
		key := fmt.Sprintf("own-%d", g)
		if !deepEqualLoose(values[key], iters-1) {
			t.Errorf("%s on disk is %v, want %d", key, values[key], iters-1)
		}
	}
}

func TestDeviceStorageMutateInPlacePersists(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "store.cui")
	fp, err := newFilePersistence(path, "my-plugin", testLogger())
	if err != nil {
		t.Fatal(err)
	}
	loc := storeLocation{kind: storeLocationPlugin}
	ds := newDeviceStorage(fp, loc, testLogger())
	ds.DefineSchemas([]JsonSchema{{Type: JsonSchemaTypeArray, Key: "obj", Store: Bool(true)}})

	// Reload from disk between probes: a later whole-document persist would
	// mask an earlier write that was wrongly skipped as "unchanged".
	reload := func(key string) any {
		t.Helper()
		reloaded, err := newFilePersistence(path, "my-plugin", testLogger())
		if err != nil {
			t.Fatal(err)
		}
		return reloaded.load(loc)[key]
	}

	obj := map[string]any{"list": []any{"a"}, "n": 1}
	if err := ds.SetValue("obj", obj); err != nil {
		t.Fatal(err)
	}
	// The caller mutates its own reference and re-sets it; the write must not
	// be skipped as "unchanged".
	obj["n"] = 2
	obj["list"] = append(obj["list"].([]any), "b")
	if err := ds.SetValue("obj", obj); err != nil {
		t.Fatal(err)
	}
	if got := reload("obj"); !deepEqualLoose(got, map[string]any{"list": []any{"a", "b"}, "n": 2}) {
		t.Errorf("mutated object not persisted: %v", got)
	}

	arr := []any{"x"}
	if err := ds.SetInternalValue("_arr", arr); err != nil {
		t.Fatal(err)
	}
	arr[0] = "y"
	if err := ds.SetInternalValue("_arr", arr); err != nil {
		t.Fatal(err)
	}
	if got := reload("_arr"); !deepEqualLoose(got, []any{"y"}) {
		t.Errorf("mutated array not persisted: %v", got)
	}
}

func TestDeviceStorageChangeSchemaStoreFlip(t *testing.T) {
	mp := newMemPersistence()
	loc := storeLocation{kind: storeLocationPlugin}
	ds := newDeviceStorage(mp, loc, testLogger())
	ds.DefineSchemas([]JsonSchema{{Type: JsonSchemaTypeString, Key: "k", Store: Bool(false)}})

	if err := ds.SetValue("k", "v"); err != nil {
		t.Fatal(err)
	}
	if _, exists := mp.persisted(loc)["k"]; exists {
		t.Fatal("Store=false key was persisted")
	}

	if err := ds.ChangeSchema("k", &JsonSchema{Type: JsonSchemaTypeString, Key: "k", Store: Bool(true)}); err != nil {
		t.Fatal(err)
	}

	// The value compares unchanged, but the flipped store flag must make it
	// durable with the next write.
	if err := ds.SetValue("k", "v"); err != nil {
		t.Fatal(err)
	}
	if mp.persisted(loc)["k"] != "v" {
		t.Error("store flag flip did not persist the unchanged value")
	}
}

// OnSet callbacks may call back into the same storage; combined with the
// awaited save path this must not deadlock.
func TestDeviceStorageNestedCallsFromOnSet(t *testing.T) {
	mp := newMemPersistence()
	ds := newDeviceStorage(mp, storeLocation{kind: storeLocationPlugin}, testLogger())

	nested := make(chan error, 1)
	ds.DefineSchemas([]JsonSchema{
		{Type: JsonSchemaTypeString, Key: "outer", Store: Bool(true), OnSet: func(oldVal, newVal any) any {
			if err := ds.SetValue("inner", "from-callback"); err != nil {
				nested <- err
				return nil
			}
			nested <- ds.Save()
			return nil
		}},
		{Type: JsonSchemaTypeString, Key: "inner", Store: Bool(true)},
	})

	watchdog(t, 10*time.Second, func() {
		if err := ds.SetConfig(map[string]any{"outer": "trigger"}); err != nil {
			t.Fatalf("SetConfig: %v", err)
		}
		if err := <-nested; err != nil {
			t.Fatalf("nested storage calls from OnSet failed: %v", err)
		}
	})

	if mp.persisted(storeLocation{kind: storeLocationPlugin})["inner"] != "from-callback" {
		t.Error("nested SetValue was not persisted")
	}
}
