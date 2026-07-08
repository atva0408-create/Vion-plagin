package sdk

import (
	"context"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"sync"
	"time"

	rpc "github.com/cameraui/rpc/go"
)

// configPersistence is the plugin's local store file, or — for remote-hosted
// plugins — the master's config store via RPC so config survives re-homing.
type configPersistence interface {
	load(loc storeLocation) map[string]any
	save(loc storeLocation, values map[string]any) func() error
}

// coalescingWriter serializes flushes and collapses saves that arrive while
// one is in flight into a single trailing flush of the newest snapshot.
// Snapshots are whole-document states of the same source, so the newest one
// contains every earlier caller's write; each caller blocks until the flush
// containing its snapshot completes and receives that flush's error. A burst
// of N saves costs at most 2 flushes.
type coalescingWriter struct {
	flush func(snapshot any) error
	log   *Logger

	mu       sync.Mutex
	inFlight bool
	pending  *pendingFlush
}

type pendingFlush struct {
	snapshot any
	err      error
	done     chan struct{}
}

func (p *pendingFlush) wait() error {
	// err is written before close(done); the channel close orders the read.
	<-p.done
	return p.err
}

func newCoalescingWriter(flush func(snapshot any) error, log *Logger) *coalescingWriter {
	return &coalescingWriter{flush: flush, log: log}
}

// enqueue registers a snapshot for the next flush (latest wins) without
// blocking. Callers may hold the lock guarding their snapshot across the
// call: flush order is enqueue order, so enqueueing under that lock makes it
// impossible for an older snapshot to overtake a newer one.
func (w *coalescingWriter) enqueue(snapshot any) *pendingFlush {
	w.mu.Lock()
	defer w.mu.Unlock()

	if w.pending == nil {
		w.pending = &pendingFlush{done: make(chan struct{})}
	}
	w.pending.snapshot = snapshot
	p := w.pending
	if !w.inFlight {
		w.inFlight = true
		go w.run()
	}
	return p
}

func (w *coalescingWriter) write(snapshot any) error {
	return w.enqueue(snapshot).wait()
}

// run drains pending flushes until none is left, then exits; enqueue starts
// a new drainer when needed.
func (w *coalescingWriter) run() {
	for {
		w.mu.Lock()
		p := w.pending
		w.pending = nil
		if p == nil {
			w.inFlight = false
			w.mu.Unlock()
			return
		}
		w.mu.Unlock()

		p.err = w.runFlush(p.snapshot)
		close(p.done)
	}
}

// runFlush converts a panicking flush into an error: waiters block on the
// flush outcome, so a panic must never skip delivering one.
func (w *coalescingWriter) runFlush(snapshot any) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("store: flush panicked: %v", r)
		}
	}()
	return w.flush(snapshot)
}

// filePersistence keeps the canonical store document in memory and persists
// it to the plugin's store file through a coalescing writer. The document and
// every value map inside it are owned deep copies — callers never hold a
// reference into it.
type filePersistence struct {
	path   string
	logger *Logger
	writer *coalescingWriter

	mu  sync.Mutex
	doc map[string]any
}

func newFilePersistence(path, pluginID string, logger *Logger) (*filePersistence, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}

	removeOrphanedStoreTmpFiles(path)

	doc, found, err := readStoreFile(path, logger)
	if err != nil {
		return nil, err
	}
	if !found {
		doc = map[string]any{}
	}

	doc, changed := remapLegacyGoLayout(doc, pluginID, logger)
	// A fresh store persists its (possibly empty) envelope immediately so the
	// server's legacy-env probe stops running on every boot.
	if !found || changed {
		if err := writeStoreFile(path, doc, logger); err != nil {
			return nil, err
		}
	}
	backupStoreFile(path, logger)

	fp := &filePersistence{path: path, logger: logger, doc: doc}
	fp.writer = newCoalescingWriter(func(snapshot any) error {
		return writeStoreBytes(path, snapshot.([]byte), logger)
	}, logger)

	return fp, nil
}

func (fp *filePersistence) load(loc storeLocation) map[string]any {
	fp.mu.Lock()
	defer fp.mu.Unlock()

	values := readLocation(fp.doc, loc)
	if values == nil {
		return nil
	}
	copied, _ := deepCopyValue(values).(map[string]any)
	return copied
}

func (fp *filePersistence) save(loc storeLocation, values map[string]any) func() error {
	fp.mu.Lock()
	if len(values) == 0 {
		// An empty value map reads the same as "never set"; deleting keeps
		// never-populated sections out of the file.
		deleteLocation(fp.doc, loc)
	} else {
		copied, _ := deepCopyValue(values).(map[string]any)
		writeLocation(fp.doc, loc, copied)
	}
	// Encoding under the lock is safe (the doc is solely owned, nothing else
	// reads it) and yields a consistent snapshot without copying the document.
	data, err := encodeEnvelope(fp.doc)
	if err != nil {
		fp.mu.Unlock()
		fp.logger.Error(fmt.Sprintf("store: encode for %s failed: %v", fp.path, err))
		return func() error { return err }
	}
	// Enqueue before unlocking so flush order matches doc-install order: a
	// newer document can never be overwritten by an older encoded snapshot.
	p := fp.writer.enqueue(data)
	fp.mu.Unlock()
	return p.wait
}

const remoteStoreTimeout = 10 * time.Second

// remotePersistence persists through the master's config store. Reads come
// from an in-process cache of the canonical document — this child is the only
// writer, so it never goes stale. Writes update the cache and block until the
// master acknowledges the put.
type remotePersistence struct {
	proxy  *rpc.Proxy
	logger *Logger
	writer *coalescingWriter

	mu    sync.Mutex
	cache map[string]any
}

func newRemotePersistence(client *rpc.Client, pluginID string, logger *Logger) (*remotePersistence, error) {
	ns := getPluginNamespaces(pluginID)
	rp := &remotePersistence{
		proxy:  client.CreateProxy(ns.PluginConfigStoreRPC),
		logger: logger,
		cache:  map[string]any{},
	}
	rp.writer = newCoalescingWriter(rp.flushSnapshot, logger)

	ctx, cancel := context.WithTimeout(context.Background(), remoteStoreTimeout)
	defer cancel()

	result, err := rp.proxy.Invoke(ctx, "get")
	if err != nil {
		return nil, err
	}
	if doc, ok := normalizeStoreValue(result).(map[string]any); ok {
		rp.cache = doc
	}

	doc, changed := remapLegacyGoLayout(rp.cache, pluginID, logger)
	rp.cache = doc
	if changed {
		if err := rp.flushSnapshot(snapshotStoreDoc(doc)); err != nil {
			return nil, err
		}
	}

	return rp, nil
}

func (rp *remotePersistence) load(loc storeLocation) map[string]any {
	rp.mu.Lock()
	defer rp.mu.Unlock()

	values := readLocation(rp.cache, loc)
	if values == nil {
		return nil
	}
	copied, _ := deepCopyValue(values).(map[string]any)
	return copied
}

func (rp *remotePersistence) save(loc storeLocation, values map[string]any) func() error {
	rp.mu.Lock()
	if len(values) == 0 {
		deleteLocation(rp.cache, loc)
	} else {
		copied, _ := deepCopyValue(values).(map[string]any)
		writeLocation(rp.cache, loc, copied)
	}
	snapshot := snapshotStoreDoc(rp.cache)
	// Enqueue before unlocking so flush order matches cache-install order.
	p := rp.writer.enqueue(snapshot)
	rp.mu.Unlock()
	return p.wait
}

func (rp *remotePersistence) flushSnapshot(snapshot any) error {
	ctx, cancel := context.WithTimeout(context.Background(), remoteStoreTimeout)
	defer cancel()

	if _, err := rp.proxy.Invoke(ctx, "put", snapshot); err != nil {
		rp.logger.Error(fmt.Sprintf("store: remote put failed: %v", err))
		return err
	}
	return nil
}

// snapshotStoreDoc copies the document's container levels so the wire encoder
// never reads a map a concurrent save may mutate. Leaf value maps are shared
// on purpose: they are owned deep copies that later saves replace wholesale,
// never mutate in place.
func snapshotStoreDoc(doc map[string]any) map[string]any {
	out := maps.Clone(doc)
	if cameras, ok := doc["cameras"].(map[string]any); ok {
		out["cameras"] = maps.Clone(cameras)
	}
	if sensors, ok := doc["sensors"].(map[string]any); ok {
		byCamera := make(map[string]any, len(sensors))
		for cameraID, v := range sensors {
			byType, ok := v.(map[string]any)
			if !ok {
				byCamera[cameraID] = v
				continue
			}
			typeCopy := make(map[string]any, len(byType))
			for sensorType, v2 := range byType {
				if byName, ok := v2.(map[string]any); ok {
					typeCopy[sensorType] = maps.Clone(byName)
				} else {
					typeCopy[sensorType] = v2
				}
			}
			byCamera[cameraID] = typeCopy
		}
		out["sensors"] = byCamera
	}
	return out
}

func deepCopyValue(v any) any {
	switch val := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(val))
		for k, item := range val {
			out[k] = deepCopyValue(item)
		}
		return out
	case []any:
		out := make([]any, len(val))
		for i, item := range val {
			out[i] = deepCopyValue(item)
		}
		return out
	case []byte:
		out := make([]byte, len(val))
		copy(out, val)
		return out
	default:
		return val
	}
}
