package sdk

import "maps"

type storeLocationKind string

const (
	storeLocationPlugin storeLocationKind = "plugin"
	storeLocationCamera storeLocationKind = "camera"
	storeLocationSensor storeLocationKind = "sensor"
)

const storeLayoutVersionKey = "__v"

// v2: sensors keyed by persistent sensor id, old camera-keyed trees are unmappable
const storeLayoutVersion = 2

// every component is a literal map key, never parsed or split, so ids may
// contain any characters
type storeLocation struct {
	kind     storeLocationKind
	cameraID string
	sensorID string
}

func readLocation(doc map[string]any, loc storeLocation) map[string]any {
	switch loc.kind {
	case storeLocationPlugin:
		m, _ := doc["plugin"].(map[string]any)
		return m
	case storeLocationCamera:
		cameras, _ := doc["cameras"].(map[string]any)
		m, _ := cameras[loc.cameraID].(map[string]any)
		return m
	case storeLocationSensor:
		sensors, _ := doc["sensors"].(map[string]any)
		m, _ := sensors[loc.sensorID].(map[string]any)
		return m
	}
	return nil
}

func writeLocation(doc map[string]any, loc storeLocation, values map[string]any) {
	switch loc.kind {
	case storeLocationPlugin:
		doc["plugin"] = values
	case storeLocationCamera:
		ensureChildMap(doc, "cameras")[loc.cameraID] = values
	case storeLocationSensor:
		ensureChildMap(doc, "sensors")[loc.sensorID] = values
	}
}

func deleteLocation(doc map[string]any, loc storeLocation) {
	switch loc.kind {
	case storeLocationPlugin:
		delete(doc, "plugin")
	case storeLocationCamera:
		if cameras, ok := doc["cameras"].(map[string]any); ok {
			delete(cameras, loc.cameraID)
			pruneIfEmpty(doc, "cameras")
		}
	case storeLocationSensor:
		if sensors, ok := doc["sensors"].(map[string]any); ok {
			delete(sensors, loc.sensorID)
			pruneIfEmpty(doc, "sensors")
		}
	}
}

func ensureChildMap(parent map[string]any, key string) map[string]any {
	if m, ok := parent[key].(map[string]any); ok {
		return m
	}
	m := map[string]any{}
	parent[key] = m
	return m
}

func pruneIfEmpty(parent map[string]any, key string) {
	if m, ok := parent[key].(map[string]any); ok && len(m) == 0 {
		delete(parent, key)
	}
}

// upgradeStoreLayout stamps the current layout version. Idempotent: a
// document already on the current version comes back unchanged.
func upgradeStoreLayout(doc map[string]any) (map[string]any, bool) {
	if v, _ := toInt64(doc[storeLayoutVersionKey]); v == storeLayoutVersion {
		return doc, false
	}

	out := make(map[string]any, len(doc)+1)
	maps.Copy(out, doc)
	// v2: camera-keyed sensor storage cannot be mapped to persistent sensor ids
	delete(out, "sensors")
	out[storeLayoutVersionKey] = storeLayoutVersion
	return out, true
}
