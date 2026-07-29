package sdk

import (
	"fmt"
	"strings"
)

type storeLocationKind string

const (
	storeLocationPlugin storeLocationKind = "plugin"
	storeLocationCamera storeLocationKind = "camera"
	storeLocationSensor storeLocationKind = "sensor"
)

var canonicalStoreSections = []string{"plugin", "cameras", "sensors"}

// storeLocation addresses one value map inside a plugin's store document:
// the plugin section, one camera, or one sensor. Every component is a literal
// map key — never parsed or split, so ids may contain any characters.
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

const storeLayoutVersionKey = "__v"

// v2: sensors keyed by persistent sensor id, old camera-keyed trees are unmappable
const storeLayoutVersion = 2

func isCanonicalStoreSection(key string) bool {
	return key == "plugin" || key == "cameras" || key == "sensors"
}

// remapLegacyGoLayout rewrites the pre-CUI1 Go key shapes ("<pluginID>.plugin",
// "<pluginID>.camera.<id>", "<pluginID>.sensor.<camId>.<sensorId>") into the
// canonical plugin/cameras/sensors layout. Idempotent: a document that already
// contains only canonical sections is returned unchanged (changed == false).
func remapLegacyGoLayout(doc map[string]any, pluginID string, log *Logger) (map[string]any, bool) {
	pluginKey := pluginID + ".plugin"
	cameraPrefix := pluginID + ".camera."
	sensorPrefix := pluginID + ".sensor."

	out := make(map[string]any, len(doc))
	for _, section := range canonicalStoreSections {
		if v, ok := doc[section]; ok {
			out[section] = v
		}
	}
	if v, ok := doc[storeLayoutVersionKey]; ok {
		out[storeLayoutVersionKey] = v
	}

	changed := false
	for key, values := range doc {
		switch {
		case isCanonicalStoreSection(key) || key == storeLayoutVersionKey:
		case key == pluginKey:
			// In a mixed legacy+canonical document the canonical section is
			// the newer write — the legacy duplicate is stale and must never win.
			if _, exists := out["plugin"]; exists {
				log.Warn(fmt.Sprintf("store: legacy key '%s' dropped — canonical 'plugin' already present", key))
			} else {
				out["plugin"] = values
			}
			changed = true
		case strings.HasPrefix(key, cameraPrefix):
			cameraID := key[len(cameraPrefix):]
			if cameras, ok := out["cameras"].(map[string]any); ok {
				if _, exists := cameras[cameraID]; exists {
					log.Warn(fmt.Sprintf("store: legacy key '%s' dropped — canonical 'cameras.%s' already present", key, cameraID))
					changed = true
					continue
				}
			}
			ensureChildMap(out, "cameras")[cameraID] = values
			changed = true
		case strings.HasPrefix(key, sensorPrefix):
			// The legacy Go sensor shape was never populated in production.
			log.Warn(fmt.Sprintf("store: dropping legacy sensor key '%s'", key))
			changed = true
		default:
			// Unknown shape: keep verbatim rather than guess and lose data.
			log.Warn(fmt.Sprintf("store: unrecognized store key '%s' kept as-is", key))
			out[key] = values
		}
	}

	if v, _ := toInt64(out[storeLayoutVersionKey]); v != storeLayoutVersion {
		// camera-keyed sensor storage cannot be mapped to persistent sensor ids
		delete(out, "sensors")
		out[storeLayoutVersionKey] = storeLayoutVersion
		changed = true
	}

	if !changed {
		return doc, false
	}
	return out, true
}
