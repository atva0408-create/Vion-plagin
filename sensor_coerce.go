package sdk

import (
	"math"

	rpc "github.com/cameraui/rpc/go"
)

type coerceFunc func(raw any) any

var propertyTypeRegistry = map[SensorType]map[string]coerceFunc{
	SensorTypeMotion: {
		"detected":      coerceBool,
		"detections":    coerceSlice[Detection],
		"blocked":       coerceBool,
		"lastTriggered": coerceInt64,
	},
	SensorTypeObject: {
		"detected":   coerceBool,
		"detections": coerceSlice[TrackedDetection],
		"labels":     coerceStringSlice,
	},
	SensorTypeFace: {
		"detected":   coerceBool,
		"detections": coerceSlice[FaceDetection],
	},
	SensorTypeLicensePlate: {
		"detected":   coerceBool,
		"detections": coerceSlice[LicensePlateDetection],
	},
	SensorTypeClassifier: {
		"detected":   coerceBool,
		"detections": coerceSlice[ClassifierDetection],
		"labels":     coerceStringSlice,
	},
	SensorTypeAudio: {
		"detected":      coerceBool,
		"detections":    coerceSlice[Detection],
		"decibels":      coerceFloat64,
		"lastTriggered": coerceInt64,
	},
	SensorTypeContact: {
		"detected": coerceBool,
	},
	SensorTypeBattery: {
		"level":    coerceInt,
		"charging": coerceString,
		"low":      coerceBool,
	},
	SensorTypeLight: {
		"on":         coerceBool,
		"brightness": coerceInt,
	},
	SensorTypeSwitch: {
		"on": coerceBool,
	},
	SensorTypeSiren: {
		"active": coerceBool,
		"volume": coerceInt,
	},
	SensorTypePTZ: {
		"position":     coerceViaRoundTrip[PTZPosition],
		"moving":       coerceBool,
		"presets":      coerceStringSlice,
		"velocity":     coerceViaRoundTrip[PTZDirection],
		"targetPreset": coerceString,
	},
	SensorTypeSecuritySystem: {
		"currentState": coerceInt,
		"targetState":  coerceInt,
	},
	SensorTypeDoorbell: {
		"ring": coerceBool,
	},
}

func coercePropertyValue(sensorType SensorType, property string, raw any) any {
	if raw == nil {
		return nil
	}
	props, ok := propertyTypeRegistry[sensorType]
	if !ok {
		return raw
	}
	fn, ok := props[property]
	if !ok {
		return raw
	}
	return fn(raw)
}

func coerceBool(raw any) any {
	if v, ok := raw.(bool); ok {
		return v
	}
	return raw
}

func coerceInt(raw any) any {
	switch n := raw.(type) {
	case int:
		return n
	case int64:
		if n > math.MaxInt32 || n < math.MinInt32 {
			return raw
		}
		return int(n)
	case float64:
		if math.IsNaN(n) || math.IsInf(n, 0) {
			return raw
		}
		return int(n)
	case uint64:
		if n > math.MaxInt32 {
			return raw
		}
		return int(n)
	default:
		return raw
	}
}

func coerceInt64(raw any) any {
	switch n := raw.(type) {
	case int64:
		return n
	case int:
		return int64(n)
	case float64:
		if math.IsNaN(n) || math.IsInf(n, 0) {
			return raw
		}
		return int64(n)
	case uint64:
		if n > math.MaxInt64 {
			return raw
		}
		return int64(n)
	default:
		return raw
	}
}

func coerceFloat64(raw any) any {
	switch n := raw.(type) {
	case float64:
		return n
	case int64:
		return float64(n)
	case int:
		return float64(n)
	case uint64:
		return float64(n)
	default:
		return raw
	}
}

func coerceString(raw any) any {
	if v, ok := raw.(string); ok {
		return v
	}
	return raw
}

func coerceStringSlice(raw any) any {
	if v, ok := raw.([]string); ok {
		return v
	}
	arr, ok := raw.([]any)
	if !ok {
		return raw
	}
	result := make([]string, 0, len(arr))
	for _, item := range arr {
		if s, ok := item.(string); ok {
			result = append(result, s)
		}
	}
	return result
}

func coerceViaRoundTrip[T any](raw any) any {
	if _, ok := raw.(T); ok {
		return raw
	}
	if _, ok := raw.(map[string]any); !ok {
		return raw
	}
	encoded, err := rpc.Encode(raw)
	if err != nil {
		return raw
	}
	var typed T
	if err := rpc.Decode(encoded, &typed); err != nil {
		return raw
	}
	return typed
}

func coerceSlice[T any](raw any) any {
	if _, ok := raw.([]T); ok {
		return raw
	}
	if _, ok := raw.([]any); !ok {
		return raw
	}
	encoded, err := rpc.Encode(raw)
	if err != nil {
		return raw
	}
	var typed []T
	if err := rpc.Decode(encoded, &typed); err != nil {
		return raw
	}
	return typed
}
