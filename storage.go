package sdk

import (
	"encoding/json"
	"fmt"
	"maps"
	"math"
	"reflect"
	"sync"

	rpc "github.com/cameraui/rpc/go"
)

// DeviceStorage is the schema-driven configuration store for a plugin,
// camera, or sensor. Define the fields the UI renders via DefineSchemas,
// then read/write values via GetValue / SetValue. Each plugin and camera
// can have its own storage instance.
//
// Example:
//
//	storage.DefineSchemas([]JsonSchema{
//	    {Type: JsonSchemaTypeString, Key: "username", Title: "Username", Description: "Account username", Store: Bool(true)},
//	    {Type: JsonSchemaTypeString, Key: "password", Title: "Password", Description: "Account password", Format: StringFormatPassword, Store: Bool(true)},
//	})
//
//	threshold := storage.GetValue("motionThreshold", 50)
//	if err := storage.SetValue("motionThreshold", 75); err != nil {
//	    log.Error("persist failed:", err)
//	}
type DeviceStorage struct {
	mu sync.RWMutex
	// persistMu orders whole-document snapshots: held from taking the values
	// snapshot until the persistence layer has enqueued it, so a snapshot
	// taken earlier can never be enqueued after — and thus overwrite — a
	// newer one. Never held while waiting for the flush itself.
	persistMu   sync.Mutex
	persistence configPersistence
	location    storeLocation
	Schemas     []JsonSchema
	Values      map[string]any
	logger      *Logger

	// dirty forces the next write to persist even when the value compares
	// unchanged: set while the last persist failed (the on-disk state needs
	// repair) and when a schema change flips a key's storable-ness (the
	// current value's presence on disk no longer matches its schema).
	dirty bool
	// persistSeq guards dirty: only the persist holding the newest snapshot
	// may clear it.
	persistSeq uint64

	closeHandler rpc.CleanupFunc
}

func newDeviceStorage(persistence configPersistence, location storeLocation, logger *Logger) *DeviceStorage {
	ds := &DeviceStorage{
		persistence: persistence,
		location:    location,
		logger:      logger,
		Values:      make(map[string]any),
	}
	if values := persistence.load(location); values != nil {
		ds.Values = values
	}
	return ds
}

// persistedValues collects the keys that belong in the store. Caller must hold ds.mu.
func (ds *DeviceStorage) persistedValues() map[string]any {
	out := make(map[string]any, len(ds.Values))
	for key, val := range ds.Values {
		schema := ds.findSchemaByKey(key)
		if schema == nil || schemaStorable(schema) {
			out[key] = val
		}
	}
	return out
}

func schemaStorable(schema *JsonSchema) bool {
	return schema.Store != nil && *schema.Store &&
		schema.Type != JsonSchemaTypeButton && schema.Type != JsonSchemaTypeSubmit
}

func generateConfigFromSchemas(schemas []JsonSchema) map[string]any {
	config := make(map[string]any, len(schemas))
	for i := range schemas {
		s := &schemas[i]
		if s.Type == JsonSchemaTypeButton || s.Type == JsonSchemaTypeSubmit {
			continue
		}
		config[s.Key] = generateDefaultValue(s)
	}
	return config
}

func generateDefaultValue(s *JsonSchema) any {
	if s.DefaultValue != nil {
		return s.DefaultValue
	}
	switch s.Type {
	case JsonSchemaTypeString:
		if len(s.Enum) > 0 {
			if s.Multiple {
				return []any{}
			}
			if s.Required {
				return s.Enum[0]
			}
		}
		return ""
	case JsonSchemaTypeNumber:
		return 0
	case JsonSchemaTypeBoolean:
		return false
	case JsonSchemaTypeArray:
		return []any{}
	default:
		return nil
	}
}

func mergeValues(dst, src map[string]any) map[string]any {
	out := make(map[string]any, len(dst)+len(src))
	maps.Copy(out, dst)
	for k, sv := range src {
		if dv, ok := out[k]; ok {
			if dm, dOk := dv.(map[string]any); dOk {
				if sm, sOk := sv.(map[string]any); sOk {
					out[k] = mergeValues(dm, sm)
					continue
				}
			}
		}
		out[k] = sv
	}
	return out
}

func mergeValue(old, incoming any) any {
	oldMap, oOk := old.(map[string]any)
	newMap, nOk := incoming.(map[string]any)
	if oOk && nOk {
		return mergeValues(oldMap, newMap)
	}
	return incoming
}

// persist writes the current persistable state and blocks until it is
// durable. It must not be called with ds.mu or ds.persistMu held: the wait
// blocks on disk or on the master's acknowledgement, and holding a lock
// across that would stall every access for the duration of a flush.
func (ds *DeviceStorage) persist() error {
	ds.persistMu.Lock()
	ds.mu.Lock()
	values := ds.persistedValues()
	ds.persistSeq++
	seq := ds.persistSeq
	ds.mu.Unlock()
	wait := ds.persistence.save(ds.location, values)
	ds.persistMu.Unlock()

	err := wait()

	ds.mu.Lock()
	// A newer snapshot supersedes this one: leave dirty to its persist.
	if seq == ds.persistSeq {
		ds.dirty = err != nil
	}
	ds.mu.Unlock()
	return err
}

// RPCMethods restricts the storage's RPC surface to the config API. Exported
// lifecycle methods (Save, DefineSchemas) stay callable in-process for plugin
// authors but are not reachable over the wire.
func (ds *DeviceStorage) RPCMethods() []string {
	return []string{
		"getValue", "setValue", "submitValue", "setInternalValue", "hasValue",
		"getConfig", "setConfig", "addSchema", "removeSchema", "changeSchema",
		"getSchema", "hasSchema", "destroy",
	}
}

// GetValue retrieves a configuration value. Resolves in order: the schema's
// OnGet callback (if any), the stored value, the schema default, then the
// provided default.
func (ds *DeviceStorage) GetValue(key string, defaultValue ...any) any {
	ds.mu.RLock()
	schema := ds.findSchemaByKey(key)

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

	if schema != nil && schema.DefaultValue != nil {
		return schema.DefaultValue
	}

	if len(defaultValue) > 0 {
		return defaultValue[0]
	}
	return nil
}

// SetValue sets a configuration value. A nil value deletes the key. Only
// processes if a schema exists for the key. When the schema has Store=true
// the call blocks until the write is durable and returns its error; values
// outside the storable domain are rejected and the previous value kept.
// OnSet(newValue, oldValue) fires detached after the persist.
func (ds *DeviceStorage) SetValue(key string, value any) error {
	if err := validateStoreValue(key, value); err != nil {
		return err
	}

	ds.mu.Lock()
	schema := ds.findSchemaByKey(key)
	if schema == nil {
		ds.mu.Unlock()
		return nil
	}

	oldValue, existed := ds.Values[key]
	if value == nil {
		delete(ds.Values, key)
	} else {
		// Store an owned copy: a caller may mutate the value it passed in and
		// re-set it, and the next compare needs the previous state, not an alias.
		ds.Values[key] = deepCopyValue(value)
	}

	var unchanged bool
	if value == nil {
		unchanged = !existed
	} else {
		unchanged = existed && deepEqualLoose(oldValue, value)
	}

	shouldPersist := schemaStorable(schema) && (!unchanged || ds.dirty)
	onSet := schema.OnSet
	ds.mu.Unlock()

	var err error
	if shouldPersist {
		err = ds.persist()
	}

	// Detached: the callback may call back into this storage.
	if onSet != nil {
		go onSet(value, oldValue)
	}
	return err
}

// SubmitValue handles a submit-type field click, invoking OnClick and
// returning its optional toast/schema response.
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

// GetConfig returns the full schema configuration (schema definitions and
// current values).
func (ds *DeviceStorage) GetConfig() map[string]any {
	ds.mu.RLock()
	schemas := ds.Schemas
	ds.mu.RUnlock()

	ds.resolveOnGet(schemas)

	ds.mu.RLock()
	defer ds.mu.RUnlock()

	out := make([]map[string]any, 0, len(ds.Schemas))
	for i := range ds.Schemas {
		out = append(out, ds.Schemas[i].ToMap())
	}

	return map[string]any{
		"schema": out,
		"config": ds.Values,
	}
}

// SetConfig merges new configuration values into the existing config and
// blocks until the merged state is durable. Values outside the storable
// domain reject the whole call before anything is applied. OnSet callbacks
// for keys whose values actually changed (deep compare) fire detached after
// the persist.
func (ds *DeviceStorage) SetConfig(newConfig map[string]any) error {
	for key, value := range newConfig {
		if err := validateStoreValue(key, value); err != nil {
			return err
		}
	}

	type pendingCallback struct {
		onSet    func(newValue, oldValue any) any
		oldValue any
		newValue any
	}
	var pending []pendingCallback

	ds.mu.Lock()

	for key, newVal := range newConfig {
		oldVal := ds.Values[key]
		merged := mergeValue(oldVal, newVal)
		ds.Values[key] = deepCopyValue(merged)

		if !deepEqualLoose(oldVal, merged) {
			schema := ds.findSchemaByKey(key)
			if schema != nil && schema.Type != JsonSchemaTypeSubmit && schema.OnSet != nil {
				pending = append(pending, pendingCallback{
					onSet:    schema.OnSet,
					oldValue: oldVal,
					newValue: merged,
				})
			}
		}
	}

	ds.mu.Unlock()

	err := ds.persist()

	if len(pending) > 0 {
		// Detached: callbacks may call back into this storage.
		go func() {
			for _, cb := range pending {
				cb.onSet(cb.newValue, cb.oldValue)
			}
		}()
	}
	return err
}

// DefineSchemas sets all schemas for this storage. Schema defaults fill any
// key the store does not carry; existing stored values win.
func (ds *DeviceStorage) DefineSchemas(schemas []JsonSchema) {
	ds.mu.Lock()
	ds.Schemas = schemas
	ds.Values = mergeValues(generateConfigFromSchemas(schemas), ds.Values)
	ds.mu.Unlock()
}

// AddSchema adds a new schema field. Returns an error if a schema with that
// key already exists — use ChangeSchema to modify an existing field.
func (ds *DeviceStorage) AddSchema(schema *JsonSchema) error {
	ds.mu.Lock()

	for i := range ds.Schemas {
		if ds.Schemas[i].Key == schema.Key {
			ds.mu.Unlock()
			return fmt.Errorf("schema with key %s already exists", schema.Key)
		}
	}
	ds.Schemas = append(ds.Schemas, *schema)

	oldValue := ds.Values[schema.Key]
	if schema.DefaultValue != nil && !ds.hasValueLocked(schema.Key) {
		ds.Values[schema.Key] = schema.DefaultValue
	}
	ds.mu.Unlock()

	ds.resolveOnGet([]JsonSchema{*schema})

	ds.mu.RLock()
	newValue := ds.Values[schema.Key]
	ds.mu.RUnlock()

	if !schemaStorable(schema) || deepEqualLoose(oldValue, newValue) {
		return nil
	}

	return ds.persist()
}

// ChangeSchema replaces an existing key's schema with a full JsonSchema;
// individual fields are not merged. The passed key always wins. It is a no-op
// when no schema with that key is registered — use AddSchema to add a new field.
func (ds *DeviceStorage) ChangeSchema(key string, newSchema *JsonSchema) error {
	ds.mu.Lock()
	newSchema.Key = key
	found := false
	for i := range ds.Schemas {
		if ds.Schemas[i].Key == key {
			if schemaStorable(&ds.Schemas[i]) != schemaStorable(newSchema) {
				ds.dirty = true
				// Bump the sequence so an in-flight persist whose snapshot
				// predates the flip cannot clear the flag.
				ds.persistSeq++
			}
			ds.Schemas[i] = *newSchema
			found = true
			break
		}
	}
	oldValue := ds.Values[key]
	ds.mu.Unlock()

	if !found {
		return nil
	}

	ds.resolveOnGet([]JsonSchema{*newSchema})

	ds.mu.RLock()
	newValue := ds.Values[key]
	ds.mu.RUnlock()

	if !schemaStorable(newSchema) || deepEqualLoose(oldValue, newValue) {
		return nil
	}

	return ds.persist()
}

// RemoveSchema removes a schema field by key, deleting its stored value along
// with it.
func (ds *DeviceStorage) RemoveSchema(key string) error {
	removedStorable := false
	hadValue := false

	ds.mu.Lock()
	for i := range ds.Schemas {
		if ds.Schemas[i].Key == key {
			removedStorable = schemaStorable(&ds.Schemas[i])
			ds.Schemas = append(ds.Schemas[:i], ds.Schemas[i+1:]...)
			_, hadValue = ds.Values[key]
			delete(ds.Values, key)
			break
		}
	}
	ds.mu.Unlock()

	if !removedStorable || !hadValue {
		return nil
	}

	return ds.persist()
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

// SetInternalValue sets a system-internal value (e.g. _displayName) without
// requiring a schema, blocking until it is persisted. A nil value deletes the
// key; values outside the storable domain are rejected.
func (ds *DeviceStorage) SetInternalValue(key string, value any) error {
	if err := validateStoreValue(key, value); err != nil {
		return err
	}

	ds.mu.Lock()
	oldValue, existed := ds.Values[key]
	if value == nil {
		delete(ds.Values, key)
	} else {
		// Owned copy, same reasoning as SetValue.
		ds.Values[key] = deepCopyValue(value)
	}

	var unchanged bool
	if value == nil {
		unchanged = !existed
	} else {
		unchanged = existed && deepEqualLoose(oldValue, value)
	}
	skip := unchanged && !ds.dirty
	ds.mu.Unlock()

	// An unchanged value is already durable — skip the whole-document write.
	if skip {
		return nil
	}

	return ds.persist()
}

// Save persists the storable configuration state, returning once the write
// is durable (file synced or master acknowledged).
func (ds *DeviceStorage) Save() error {
	return ds.persist()
}

// close flushes a final snapshot and unregisters the storage's RPC handler.
func (ds *DeviceStorage) close() {
	if err := ds.Save(); err != nil {
		ds.logger.Error("store: close save failed:", err)
	}
	ds.unregister()
}

// Destroy clears this storage's values and deletes its location from the store,
// blocking until the deletion is durable.
func (ds *DeviceStorage) Destroy() error {
	ds.mu.Lock()
	ds.Values = make(map[string]any)
	ds.mu.Unlock()
	return ds.persist()
}

// unregister removes this storage's RPC handler without flushing.
func (ds *DeviceStorage) unregister() {
	if ds.closeHandler != nil {
		_ = ds.closeHandler()
		ds.closeHandler = nil
	}
}

// resolveOnGet runs each schema's OnGet and bakes the result into Values.
// onGet may read back into this storage, so it runs without ds.mu held.
func (ds *DeviceStorage) resolveOnGet(schemas []JsonSchema) {
	for i := range schemas {
		s := &schemas[i]
		if s.OnGet == nil || s.Type == JsonSchemaTypeButton || s.Type == JsonSchemaTypeSubmit {
			continue
		}
		val := s.OnGet()
		if val == nil {
			continue
		}
		ds.mu.Lock()
		ds.Values[s.Key] = val
		ds.mu.Unlock()
	}
}

const maxSafeStoreInt = 1<<53 - 1

// maxStoreValueDepth bounds recursion so a circular reference fails with a
// clear error instead of a stack overflow.
const maxStoreValueDepth = 64

func validateStoreValue(key string, value any) error {
	return walkStoreValue(value, key, 0)
}

func walkStoreValue(v any, path string, depth int) error {
	if depth > maxStoreValueDepth {
		return fmt.Errorf("store: value at '%s' exceeds %d nesting levels — circular reference?", path, maxStoreValueDepth)
	}
	switch val := v.(type) {
	case nil, string, bool, int8, int16, int32, uint8, uint16, uint32:
		return nil
	case float32:
		return checkStoreFloat(float64(val), path)
	case float64:
		return checkStoreFloat(val, path)
	case int:
		return checkStoreInt(int64(val), path)
	case int64:
		return checkStoreInt(val, path)
	case uint:
		return checkStoreUint(uint64(val), path)
	case uint64:
		return checkStoreUint(val, path)
	case json.Number:
		f, err := val.Float64()
		if err != nil {
			return fmt.Errorf("store: value at '%s' is not a storable number: %v", path, err)
		}
		return checkStoreFloat(f, path)
	case []byte:
		return fmt.Errorf("store: value at '%s' is binary — large artifacts belong in files under the plugin storage dir", path)
	case []any:
		for i, item := range val {
			if err := walkStoreValue(item, fmt.Sprintf("%s[%d]", path, i), depth+1); err != nil {
				return err
			}
		}
		return nil
	case map[string]any:
		for k, item := range val {
			if err := walkStoreValue(item, path+"."+k, depth+1); err != nil {
				return err
			}
		}
		return nil
	}

	rv := reflect.ValueOf(v)
	switch rv.Kind() {
	case reflect.Slice, reflect.Array:
		for i := range rv.Len() {
			if err := walkStoreValue(rv.Index(i).Interface(), fmt.Sprintf("%s[%d]", path, i), depth+1); err != nil {
				return err
			}
		}
		return nil
	case reflect.Map:
		if rv.Type().Key().Kind() != reflect.String {
			return fmt.Errorf("store: value at '%s' is a %T — map keys must be strings", path, v)
		}
		iter := rv.MapRange()
		for iter.Next() {
			if err := walkStoreValue(iter.Value().Interface(), path+"."+iter.Key().String(), depth+1); err != nil {
				return err
			}
		}
		return nil
	default:
		return fmt.Errorf("store: value at '%s' is a %T — only strings, bools, float64-domain numbers, arrays and string-keyed maps are storable", path, v)
	}
}

func checkStoreFloat(f float64, path string) error {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return fmt.Errorf("store: value at '%s' is %v — NaN/Infinity are not storable", path, f)
	}
	if f == math.Trunc(f) && math.Abs(f) > maxSafeStoreInt {
		return fmt.Errorf("store: value at '%s' exceeds the float64-safe integer range (±2^53)", path)
	}
	return nil
}

func checkStoreInt(n int64, path string) error {
	if n > maxSafeStoreInt || n < -maxSafeStoreInt {
		return fmt.Errorf("store: value at '%s' exceeds the float64-safe integer range (±2^53)", path)
	}
	return nil
}

func checkStoreUint(n uint64, path string) error {
	if n > maxSafeStoreInt {
		return fmt.Errorf("store: value at '%s' exceeds the float64-safe integer range (±2^53)", path)
	}
	return nil
}

// deepEqualLoose compares two values, normalizing numeric types before
// comparing (values from different serialization paths — JSON float64,
// msgpack int64/uint64, Go int — may type the same logical value differently)
// and recursing into maps and slices.
func deepEqualLoose(a, b any) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}

	na, aIsNum := toFloat64(a)
	nb, bIsNum := toFloat64(b)
	if aIsNum && bIsNum {
		return na == nb
	}
	if aIsNum != bIsNum {
		return false
	}

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

	return reflect.DeepEqual(a, b)
}

func toMapAny(v any) (map[string]any, bool) {
	if m, ok := v.(map[string]any); ok {
		return m, true
	}
	return nil, false
}

func toSliceAny(v any) ([]any, bool) {
	if s, ok := v.([]any); ok {
		return s, true
	}
	return nil, false
}

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
