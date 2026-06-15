package sdk

import (
	"context"
	"maps"
	"math"

	rpc "github.com/cameraui/rpc/go"
)

// sensorProxy is a read-only proxy for consuming sensors from other plugins.
type sensorProxy struct {
	BaseSensor
	client     *rpc.Client
	logger     *Logger
	sensorType SensorType
	category   SensorCategory
	proxy      *rpc.Proxy
	unsubEvent func()
}

// newSensorProxy creates a new sensor proxy for consuming sensors from other plugins.
func newSensorProxy(client *rpc.Client, logger *Logger, cameraID, sensorID, sensorName string, sensorType SensorType, category SensorCategory, initialProps map[string]any) *sensorProxy {
	s := &sensorProxy{
		BaseSensor: NewBaseSensor(sensorName),
		client:     client,
		logger:     logger,
		sensorType: sensorType,
		category:   category,
	}
	s.id = sensorID
	s.cameraID = cameraID

	// Set initial properties (coerce msgpack-deserialized values to correct Go types)
	for k, v := range initialProps {
		s.properties[k] = coercePropertyValue(sensorType, k, v)
	}

	// Subscribe to per-sensor events (property:changed, capabilities:changed, displayName:changed)
	eventNS := getSensorEventNamespaces(cameraID, sensorID)
	unsub, _ := client.Subscribe(eventNS.SensorSubject, func(data []byte) {
		var msg sensorEventMessage
		if !decodeMsgpack(logger, data, &msg, "sensorEventMessage") {
			return
		}

		s.handleSensorEvent(msg)
	})
	s.unsubEvent = unsub

	return s
}

// handleSensorEvent processes per-sensor events from the server.
func (s *sensorProxy) handleSensorEvent(msg sensorEventMessage) {
	switch msg.Type {
	case "property:changed":
		property, _ := msg.Data["property"].(string)
		if property != "" {
			value := coercePropertyValue(s.sensorType, property, msg.Data["value"])
			timestamp, _ := toInt64(msg.Data["timestamp"])
			s.setPropertyWithTimestamp(property, value, timestamp)
		}
	case "sensor:capabilities:changed":
		if rawCaps, ok := msg.Data["capabilities"]; ok && rawCaps != nil {
			caps := toStringSlice(rawCaps)
			if caps != nil {
				s.SetCapabilities(caps)
			}
		}
	case "sensor:displayName:changed":
		if name, ok := msg.Data["displayName"].(string); ok && name != "" {
			s.SetDisplayName(name)
		}
	}
}

// toInt64 converts any Go numeric type to int64. Used for msgpack-decoded
// values where the concrete numeric width depends on the source encoder
// (msgpack picks the smallest type that fits — JS `1` may arrive as int8,
// int16, int32, int64, uint8, uint16, uint32, uint64, float32 or float64).
// Returns (0, false) if `v` is not a numeric type or overflows int64.
func toInt64(v any) (int64, bool) {
	switch n := v.(type) {
	case int:
		return int64(n), true
	case int8:
		return int64(n), true
	case int16:
		return int64(n), true
	case int32:
		return int64(n), true
	case int64:
		return n, true
	case uint:
		if uint64(n) > math.MaxInt64 {
			return 0, false
		}
		return int64(n), true
	case uint8:
		return int64(n), true
	case uint16:
		return int64(n), true
	case uint32:
		return int64(n), true
	case uint64:
		if n > math.MaxInt64 {
			return 0, false
		}
		return int64(n), true
	case float32:
		if math.IsNaN(float64(n)) || math.IsInf(float64(n), 0) {
			return 0, false
		}
		return int64(n), true
	case float64:
		if math.IsNaN(n) || math.IsInf(n, 0) {
			return 0, false
		}
		return int64(n), true
	default:
		return 0, false
	}
}

// toStringSlice converts a []any to []string.
func toStringSlice(v any) []string {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	result := make([]string, 0, len(arr))
	for _, item := range arr {
		if s, ok := item.(string); ok {
			result = append(result, s)
		}
	}
	return result
}

func (s *sensorProxy) GetType() SensorType         { return s.sensorType }
func (s *sensorProxy) GetCategory() SensorCategory { return s.category }
func (s *sensorProxy) ToJSON() sensorJSON          { return s.toBaseJSON(s.sensorType, s.category) }

// Refresh fetches the current property values from the remote sensor.
func (s *sensorProxy) Refresh() error {
	if s.proxy == nil {
		return nil
	}
	ctx := context.Background()
	result, err := s.proxy.Invoke(ctx, "getValues")
	if err != nil {
		return err
	}

	if props, ok := result.(map[string]any); ok {
		s.mu.Lock()
		for k, v := range props {
			s.properties[k] = coercePropertyValue(s.sensorType, k, v)
		}
		s.mu.Unlock()
	}
	return nil
}

// UpdateValue forwards a generic property write to the owning plugin's sensor
// provider via RPC. The owning sensor's `UpdateValue` dispatches to the
// appropriate semantic method (`SetOn`, `SetTargetState`, ...) so plugin-side
// hardware-action overrides are honored end-to-end.
//
// For non-control sensors this is a no-op (writes have no effect on the source).
func (s *sensorProxy) UpdateValue(property string, value any) error {
	if s.proxy == nil || !isControlCategory(s.category) {
		return nil
	}
	ctx := context.Background()
	_, err := s.proxy.Invoke(ctx, "updateValue", property, value)
	return err
}

func isControlCategory(cat SensorCategory) bool {
	return cat == SensorCategoryControl || cat == SensorCategoryTrigger
}

// ToStoredData converts the proxy back to a storedSensorData representation.
func (s *sensorProxy) ToStoredData() storedSensorData {
	s.mu.RLock()
	defer s.mu.RUnlock()
	props := make(map[string]any, len(s.properties))
	maps.Copy(props, s.properties)
	caps := make([]string, len(s.capabilities))
	copy(caps, s.capabilities)
	return storedSensorData{
		ID:           s.id,
		Type:         s.sensorType,
		Name:         s.name,
		DisplayName:  s.displayName,
		PluginID:     s.pluginID,
		Properties:   props,
		Capabilities: caps,
	}
}

// cleanupProxy unsubscribes from sensor events.
func (s *sensorProxy) cleanupProxy() {
	if s.unsubEvent != nil {
		s.unsubEvent()
		s.unsubEvent = nil
	}
	s.cleanup()
}

// categoryForSensorType derives the SensorCategory from a SensorType.
func categoryForSensorType(st SensorType) SensorCategory {
	switch st {
	case SensorTypeLight, SensorTypeSiren, SensorTypeSwitch, SensorTypePTZ, SensorTypeSecuritySystem:
		return SensorCategoryControl
	case SensorTypeDoorbell:
		return SensorCategoryTrigger
	case SensorTypeBattery:
		return SensorCategoryInfo
	default:
		return SensorCategorySensor
	}
}
