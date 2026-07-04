package sdk

import (
	"encoding/json"
	"reflect"
	"sync"
)

var configBucket = []byte("config")

// DeviceStorage is the schema-driven configuration store for a plugin,
// camera, or sensor. Each plugin and each device gets its own scoped
// instance, keyed by Prefix.
//
// Define the fields the UI should render via DefineSchemas (typically
// once at startup), then read/write values via GetValue / SetValue.
// Values whose schema has Store=true are persisted to disk; the rest
// live only in memory for the lifetime of the process. Submit-button
// schemas drive transactional flows via SubmitValue.
//
// It implements the storage protocol expected by the server via RPC.
//
// Example:
//
//	storage.DefineSchemas([]JsonSchema{
//	    {Type: JsonSchemaTypeString, Key: "username", Title: "Username", Description: "Account username", Store: Bool(true)},
//	    {Type: JsonSchemaTypeString, Key: "password", Title: "Password", Description: "Account password", Format: StringFormatPassword, Store: Bool(true)},
//	})
//
//	threshold := storage.GetValue("motionThreshold", 50)
//	storage.SetValue("motionThreshold", 75)
type DeviceStorage struct {
	mu          sync.RWMutex
	persistence configPersistence
	prefix      string // "plugin", "camera.{id}", "sensor.{id}"
	Schemas     []JsonSchema
	Values      map[string]any
	logger      *Logger
}

// newDeviceStorage creates a new DeviceStorage instance.
func newDeviceStorage(persistence configPersistence, prefix string, logger *Logger) *DeviceStorage {
	ds := &DeviceStorage{
		persistence: persistence,
		prefix:      prefix,
		logger:      logger,
		Values:      make(map[string]any),
	}
	ds.load()
	return ds
}

func (ds *DeviceStorage) load() {
	if values := ds.persistence.load(ds.prefix); values != nil {
		ds.Values = values
	}
}

func (ds *DeviceStorage) save() {
	ds.persistence.save(ds.prefix, ds.Values)
}

// GetValue retrieves a configuration value.
// If the schema for this key has an OnGet callback, it is called and its return value is used.
// Falls back to stored value, then schema default, then provided default.
func (ds *DeviceStorage) GetValue(key string, defaultValue ...any) any {
	ds.mu.RLock()
	schema := ds.findSchemaByKey(key)

	// OnGet takes priority (computed values)
	if schema != nil && schema.OnGet != nil {
		onGet := schema.OnGet
		ds.mu.RUnlock()
		return onGet()
	}

	val, ok := ds.Values[key]
	ds.mu.RUnlock()

	if ok {
		return val
	}

	// Schema default
	if schema != nil && schema.DefaultValue != nil {
		return schema.DefaultValue
	}

	if len(defaultValue) > 0 {
		return defaultValue[0]
	}
	return nil
}

// SetValue sets a configuration value and persists it.
// Only processes if a schema exists for the key (consistent with Node/Python SDK).
// Calls OnSet(oldValue, newValue) after the value is stored.
func (ds *DeviceStorage) SetValue(key string, value any) {
	ds.mu.Lock()

	schema := ds.findSchemaByKey(key)
	if schema == nil {
		ds.mu.Unlock()
		return
	}

	oldValue := ds.Values[key]

	if value == nil {
		delete(ds.Values, key)
	} else {
		ds.Values[key] = value
	}

	// Only persist if schema has Store=true
	if schema.Store != nil && *schema.Store {
		ds.save()
	}

	onSet := schema.OnSet
	ds.mu.Unlock()

	// Call OnSet outside lock — callback may use other storage methods
	if onSet != nil {
		onSet(oldValue, value)
	}
}

// SubmitValue handles submit button clicks. Finds the schema by key,
// calls OnClick if present, and returns the response (with optional toast).
// This is the Go equivalent of the Node/Python submitValue method.
func (ds *DeviceStorage) SubmitValue(key string, value any) map[string]any {
	ds.mu.RLock()
	schema := ds.findSchemaByKey(key)
	if schema == nil || schema.Type != JsonSchemaTypeSubmit || schema.OnClick == nil {
		ds.mu.RUnlock()
		return nil
	}
	onClick := schema.OnClick
	ds.mu.RUnlock()

	resp := onClick(value)
	if resp == nil {
		return nil
	}

	result := make(map[string]any)
	if resp.Toast != nil {
		result["toast"] = map[string]any{
			"type":    resp.Toast.Type,
			"message": resp.Toast.Message,
		}
	}
	if resp.Schema != nil {
		schemas := make([]map[string]any, 0, len(resp.Schema))
		for i := range resp.Schema {
			schemas = append(schemas, resp.Schema[i].ToMap())
		}
		result["schema"] = schemas
	}
	return result
}

// HasValue checks if a configuration value exists.
func (ds *DeviceStorage) HasValue(key string) bool {
	ds.mu.RLock()
	defer ds.mu.RUnlock()
	_, ok := ds.Values[key]
	return ok
}

// GetConfig returns the full schema configuration.
func (ds *DeviceStorage) GetConfig() map[string]any {
	ds.mu.RLock()
	defer ds.mu.RUnlock()

	// Build schema config without callbacks (for RPC serialization)
	schemas := make([]map[string]any, 0, len(ds.Schemas))
	for i := range ds.Schemas {
		schemas = append(schemas, ds.Schemas[i].ToMap())
	}

	return map[string]any{
		"schema": schemas,
		"config": ds.Values,
	}
}

// SetConfig merges new configuration values into the existing config.
// Triggers OnSet callbacks for any keys whose values actually changed (deep compare).
// Consistent with Node/Python SDK behavior.
func (ds *DeviceStorage) SetConfig(newConfig map[string]any) {
	ds.mu.Lock()

	// Collect OnSet callbacks for changed keys
	type pendingCallback struct {
		onSet    func(any, any) any
		oldValue any
		newValue any
	}
	var pending []pendingCallback

	// Merge: only update keys present in newConfig (not a full replace)
	for key, newVal := range newConfig {
		oldVal := ds.Values[key]

		if newVal == nil {
			delete(ds.Values, key)
		} else {
			ds.Values[key] = newVal
		}

		if !deepEqualLoose(oldVal, newVal) {
			schema := ds.findSchemaByKey(key)
			if schema != nil && schema.OnSet != nil {
				pending = append(pending, pendingCallback{
					onSet:    schema.OnSet,
					oldValue: oldVal,
					newValue: newVal,
				})
			}
		}
	}

	ds.save()
	ds.mu.Unlock()

	// Fire OnSet callbacks outside lock
	for _, cb := range pending {
		cb.onSet(cb.oldValue, cb.newValue)
	}
}

// DefineSchemas sets the schemas for this storage.
func (ds *DeviceStorage) DefineSchemas(schemas []JsonSchema) {
	ds.mu.Lock()
	defer ds.mu.Unlock()
	ds.Schemas = schemas

	for key, val := range ds.Values {
		if _, isMap := val.(map[string]any); isMap && ds.findSchemaByKey(key) != nil {
			delete(ds.Values, key)
		}
	}

	// Apply default values for schemas that have them
	for i := range schemas {
		if schemas[i].DefaultValue != nil && !ds.hasValueLocked(schemas[i].Key) {
			ds.Values[schemas[i].Key] = schemas[i].DefaultValue
		}
	}
	ds.save()
}

// AddSchema adds a new schema field.
func (ds *DeviceStorage) AddSchema(schema *JsonSchema) {
	ds.mu.Lock()
	defer ds.mu.Unlock()

	// Check if schema with this key already exists
	for i := range ds.Schemas {
		if ds.Schemas[i].Key == schema.Key {
			ds.Schemas[i] = *schema
			return
		}
	}
	ds.Schemas = append(ds.Schemas, *schema)

	if schema.DefaultValue != nil && !ds.hasValueLocked(schema.Key) {
		ds.Values[schema.Key] = schema.DefaultValue
	}
	ds.save()
}

// ChangeSchema replaces the schema for an existing key. The passed key always
// wins (newSchema.Key is overwritten with key). It is a no-op when no schema
// with that key is currently registered — use AddSchema to add a new field.
// Persists when the changed schema is storable.
//
// Unlike the Node/Python SDKs (which merge a partial schema into the existing
// one), the Go SDK takes a full JsonSchema and replaces the entry.
func (ds *DeviceStorage) ChangeSchema(key string, newSchema *JsonSchema) {
	ds.mu.Lock()
	defer ds.mu.Unlock()

	newSchema.Key = key
	for i := range ds.Schemas {
		if ds.Schemas[i].Key == key {
			ds.Schemas[i] = *newSchema
			if newSchema.Store != nil && *newSchema.Store &&
				newSchema.Type != JsonSchemaTypeButton && newSchema.Type != JsonSchemaTypeSubmit {
				ds.save()
			}
			return
		}
	}
}

// RemoveSchema removes a schema field by key.
func (ds *DeviceStorage) RemoveSchema(key string) {
	ds.mu.Lock()
	defer ds.mu.Unlock()

	for i := range ds.Schemas {
		if ds.Schemas[i].Key == key {
			ds.Schemas = append(ds.Schemas[:i], ds.Schemas[i+1:]...)
			return
		}
	}
}

// GetSchema returns a schema by key.
func (ds *DeviceStorage) GetSchema(key string) *JsonSchema {
	ds.mu.RLock()
	defer ds.mu.RUnlock()

	for i := range ds.Schemas {
		if ds.Schemas[i].Key == key {
			return &ds.Schemas[i]
		}
	}
	return nil
}

// HasSchema checks if a schema exists.
func (ds *DeviceStorage) HasSchema(key string) bool {
	return ds.GetSchema(key) != nil
}

func (ds *DeviceStorage) hasValueLocked(key string) bool {
	_, ok := ds.Values[key]
	return ok
}

// findSchemaByKey looks up a schema by key. Caller must hold ds.mu (read or write).
func (ds *DeviceStorage) findSchemaByKey(key string) *JsonSchema {
	for i := range ds.Schemas {
		if ds.Schemas[i].Key == key {
			return &ds.Schemas[i]
		}
	}
	return nil
}

// SetInternalValue sets a system-internal value (e.g. _displayName) without requiring a schema and persists it.
func (ds *DeviceStorage) SetInternalValue(key string, value any) {
	ds.mu.Lock()
	ds.Values[key] = value
	ds.save()
	ds.mu.Unlock()
}

// Save persists all changes to storage.
func (ds *DeviceStorage) Save() {
	ds.mu.Lock()
	defer ds.mu.Unlock()
	ds.save()
}

// deepEqualLoose compares two values with recursive numeric type normalization.
// Values from different serialization paths (JSON → float64, msgpack → int64/uint64,
// Go defaults → int) may have different types for the same logical value.
// This function normalizes all numeric types to float64 before comparing,
// and recurses into maps and slices for nested structures.
func deepEqualLoose(a, b any) bool {
	// Both nil
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}

	// Numeric comparison
	na, aIsNum := toFloat64(a)
	nb, bIsNum := toFloat64(b)
	if aIsNum && bIsNum {
		return na == nb
	}
	if aIsNum != bIsNum {
		return false // one is numeric, the other isn't
	}

	// Map comparison (recurse into values)
	aMap, aIsMap := toMapAny(a)
	bMap, bIsMap := toMapAny(b)
	if aIsMap && bIsMap {
		if len(aMap) != len(bMap) {
			return false
		}
		for k, av := range aMap {
			bv, ok := bMap[k]
			if !ok || !deepEqualLoose(av, bv) {
				return false
			}
		}
		return true
	}

	// Slice comparison (recurse into elements)
	aSlice, aIsSlice := toSliceAny(a)
	bSlice, bIsSlice := toSliceAny(b)
	if aIsSlice && bIsSlice {
		if len(aSlice) != len(bSlice) {
			return false
		}
		for i := range aSlice {
			if !deepEqualLoose(aSlice[i], bSlice[i]) {
				return false
			}
		}
		return true
	}

	// Fallback for strings, bools, and other types
	return reflect.DeepEqual(a, b)
}

// toMapAny converts a value to map[string]any if possible.
func toMapAny(v any) (map[string]any, bool) {
	if m, ok := v.(map[string]any); ok {
		return m, true
	}
	return nil, false
}

// toSliceAny converts a value to []any if possible.
func toSliceAny(v any) ([]any, bool) {
	if s, ok := v.([]any); ok {
		return s, true
	}
	return nil, false
}

// toFloat64 attempts to convert a value to float64.
func toFloat64(v any) (float64, bool) {
	switch n := v.(type) {
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
	case float32:
		return float64(n), true
	case float64:
		return n, true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	default:
		return 0, false
	}
}
