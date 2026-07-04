package sdk

import (
	"context"
	"encoding/json"
	"maps"
	"sync"
	"time"

	rpc "github.com/cameraui/rpc/go"
	bolt "go.etcd.io/bbolt"
)

// configPersistence abstracts where DeviceStorage values live: a local bbolt
// file, or — for remote-hosted plugins — the master's config store via RPC so
// config survives re-homing between master and workers.
type configPersistence interface {
	load(prefix string) map[string]any
	save(prefix string, values map[string]any)
}

type boltPersistence struct {
	db *bolt.DB
}

func (bp *boltPersistence) load(prefix string) map[string]any {
	var values map[string]any
	_ = bp.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(configBucket)
		if b == nil {
			return nil
		}
		data := b.Get([]byte(prefix))
		if data == nil {
			return nil
		}
		return json.Unmarshal(data, &values)
	})
	return values
}

func (bp *boltPersistence) save(prefix string, values map[string]any) {
	_ = bp.db.Update(func(tx *bolt.Tx) error {
		b, err := tx.CreateBucketIfNotExists(configBucket)
		if err != nil {
			return err
		}
		data, err := json.Marshal(values)
		if err != nil {
			return err
		}
		return b.Put([]byte(prefix), data)
	})
}

// remotePersistence persists through the master's config store. Reads come
// from an in-process cache — this child is the only writer, so it never goes
// stale. Writes update the cache synchronously and persist asynchronously.
type remotePersistence struct {
	mu     sync.Mutex
	proxy  *rpc.Proxy
	logger *Logger
	cache  map[string]any
}

func newRemotePersistence(client *rpc.Client, pluginID string, logger *Logger) (*remotePersistence, error) {
	ns := getPluginNamespaces(pluginID)
	rp := &remotePersistence{
		proxy:  client.CreateProxy(ns.PluginConfigStoreRPC),
		logger: logger,
		cache:  map[string]any{},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	result, err := rp.proxy.Invoke(ctx, "get")
	if err != nil {
		return nil, err
	}

	if config, ok := result.(map[string]any); ok {
		rp.cache = config
	}

	return rp, nil
}

func (rp *remotePersistence) load(prefix string) map[string]any {
	rp.mu.Lock()
	defer rp.mu.Unlock()

	if values, ok := rp.cache[prefix].(map[string]any); ok {
		if copied, ok := deepCopyValue(values).(map[string]any); ok {
			return copied
		}
	}
	return nil
}

func (rp *remotePersistence) save(prefix string, values map[string]any) {
	rp.mu.Lock()
	rp.cache[prefix] = deepCopyValue(values)
	snapshot := make(map[string]any, len(rp.cache))
	maps.Copy(snapshot, rp.cache)
	rp.mu.Unlock()

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		if _, err := rp.proxy.Invoke(ctx, "put", snapshot); err != nil {
			rp.logger.Error("Failed to persist config to master:", err)
		}
	}()
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
