package sdk

import (
	"context"
	"maps"
	"math"

	rpc "github.com/cameraui/rpc/go"
)

type sensorProxy struct {
	BaseSensor
	client     *rpc.Client
	logger     *Logger
	sensorType SensorType
	category   SensorCategory
	exposed    bool
	connected  bool
	proxy      *rpc.Proxy
	unsubEvent func()
}

func newSensorProxy(client *rpc.Client, logger *Logger, data *storedSensorData) *sensorProxy {
	category := categoryForSensorType(data.Type)
	s := &sensorProxy{
		BaseSensor: NewBaseSensor(data.Name),
		client:     client,
		logger:     logger,
		sensorType: data.Type,
		category:   category,
		exposed:    data.Exposed,
		connected:  data.Connected,
	}
	s.id = data.ID
	s.nativeID = data.NativeID
	s.pluginID = data.PluginID
	s.assignedCameraIDs = append([]string(nil), data.AssignedCameraIDs...)
	if data.DisplayName != "" {
		s.displayName = data.DisplayName
	}
	if data.Capabilities != nil {
		s.capabilities = append([]string(nil), data.Capabilities...)
	}

	for k, v := range data.Properties {
		s.properties[k] = coercePropertyValue(data.Type, k, v)
	}

	ownerNS := getSensorProviderNamespaces(data.PluginID, data.ID)
	s.proxy = client.CreateProxy(ownerNS.SensorRPC)

	eventNS := getSensorEventNamespaces(data.ID)
	unsub, _ := client.Subscribe(eventNS.SensorSubject, func(payload []byte) {
		var msg sensorEventMessage
		if !decodeMsgpack(logger, payload, &msg, "sensorEventMessage") {
			return
		}

		s.handleSensorEvent(msg)
	})
	s.unsubEvent = unsub

	return s
}

func (s *sensorProxy) GetType() SensorType         { return s.sensorType }
func (s *sensorProxy) GetCategory() SensorCategory { return s.category }
func (s *sensorProxy) ToJSON() sensorJSON          { return s.toBaseJSON(s.sensorType, s.category) }

func (s *sensorProxy) Connected() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.connected
}

func (s *sensorProxy) Exposed() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.exposed
}

// Refresh pulls the current property values from the owning sensor.
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

// UpdateValue forwards the write to the owning sensor via RPC. Read-only sensor
// types no-op on the owning side, so there is no category gate here.
func (s *sensorProxy) UpdateValue(property string, value any) error {
	if s.proxy == nil {
		return nil
	}
	ctx := context.Background()
	_, err := s.proxy.Invoke(ctx, "updateValue", property, value)
	return err
}

// ToStoredData returns the cached sensor state in its persisted shape.
func (s *sensorProxy) ToStoredData() storedSensorData {
	s.mu.RLock()
	defer s.mu.RUnlock()
	props := make(map[string]any, len(s.properties))
	maps.Copy(props, s.properties)
	caps := make([]string, len(s.capabilities))
	copy(caps, s.capabilities)
	ids := make([]string, len(s.assignedCameraIDs))
	copy(ids, s.assignedCameraIDs)
	return storedSensorData{
		ID:                s.id,
		Type:              s.sensorType,
		Name:              s.name,
		DisplayName:       s.displayName,
		NativeID:          s.nativeID,
		PluginID:          s.pluginID,
		AssignedCameraIDs: ids,
		Exposed:           s.exposed,
		Connected:         s.connected,
		Properties:        props,
		Capabilities:      caps,
	}
}

func (s *sensorProxy) setConnected(connected bool) {
	s.mu.Lock()
	if s.connected == connected {
		s.mu.Unlock()
		return
	}
	s.connected = connected
	s.mu.Unlock()
	s.connectedChanged.Next(connected)
}

func (s *sensorProxy) setExposed(exposed bool) {
	s.mu.Lock()
	s.exposed = exposed
	s.mu.Unlock()
}

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

func (s *sensorProxy) cleanupProxy() {
	if s.unsubEvent != nil {
		s.unsubEvent()
		s.unsubEvent = nil
	}
	s.cleanup()
}

// msgpack picks the smallest type that fits, so a JS 1 can arrive as anything
// from int8 to uint64, float32 or float64
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

func isControlCategory(cat SensorCategory) bool {
	return cat == SensorCategoryControl || cat == SensorCategoryTrigger
}

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
