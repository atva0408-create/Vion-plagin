package sdk

import (
	"errors"
	"fmt"
	"slices"
)

// validSensorTypes is the closed set of SensorType values the host accepts
// in PluginContract.Provides / Consumes.
var validSensorTypes = []SensorType{
	SensorTypeMotion, SensorTypeObject, SensorTypeAudio,
	SensorTypeFace, SensorTypeLicensePlate, SensorTypeClassifier,
	SensorTypeContact, SensorTypeTemperature, SensorTypeHumidity, SensorTypeOccupancy,
	SensorTypeSmoke, SensorTypeLeak,
	SensorTypeLight, SensorTypeSiren, SensorTypeSwitch, SensorTypeLock, SensorTypeGarage,
	SensorTypePTZ, SensorTypeSecuritySystem, SensorTypeDoorbell, SensorTypeBattery,
}

// validRoles is the closed set of PluginRole values the host accepts in
// PluginContract.Role.
var validRoles = []PluginRole{
	PluginRoleHub, PluginRoleSensorProvider,
	PluginRoleCameraController, PluginRoleCameraAndSensorProvider,
}

// validInterfaces is the closed set of PluginInterface values the host
// accepts in PluginContract.Interfaces.
var validInterfaces = []PluginInterface{
	PluginInterfaceMotionDetection, PluginInterfaceObjectDetection,
	PluginInterfaceAudioDetection, PluginInterfaceFaceDetection,
	PluginInterfaceLicensePlateDetection, PluginInterfaceClassifierDetection,
	PluginInterfaceClipDetection,
	PluginInterfaceDiscoveryProvider,
	PluginInterfaceNotifier,
	PluginInterfaceNVR,
	PluginInterfaceOAuthCapable, PluginInterfaceOAuthDeviceFlow,
	PluginInterfaceOAuthAuthCodeFlow, PluginInterfaceOAuthClientCredentials,
}

// validCapabilities is the closed set of PluginCapability values the host
// accepts in PluginContract.Capabilities.
var validCapabilities = []PluginCapability{
	CapabilityPublishNotifications,
}

// GetContractValidationErrors checks the structural validity of a contract
// (required fields present, enum values inside the accepted sets) and
// returns one human-readable error per problem found. Returns an empty
// slice when the contract is valid.
//
// Example:
//
//	errs := GetContractValidationErrors(rawManifest)
//	if len(errs) > 0 {
//	    return fmt.Errorf("invalid contract: %s", strings.Join(errs, "; "))
//	}
func GetContractValidationErrors(c *PluginContract) []string {
	var errors []string

	// Check name
	if c.Name == "" {
		errors = append(errors, `field "name" cannot be empty`)
	}

	// Check role
	if !containsRole(validRoles, c.Role) {
		errors = append(errors, fmt.Sprintf(`invalid role %q, valid roles: %v`, c.Role, validRoles))
	}

	// Check provides
	for _, st := range c.Provides {
		if !containsSensorType(validSensorTypes, st) {
			errors = append(errors, fmt.Sprintf(`invalid sensor type in "provides": %q`, st))
		}
	}

	// Check consumes
	for _, st := range c.Consumes {
		if !containsSensorType(validSensorTypes, st) {
			errors = append(errors, fmt.Sprintf(`invalid sensor type in "consumes": %q`, st))
		}
	}

	// Check interfaces
	for _, iface := range c.Interfaces {
		if !containsInterface(validInterfaces, iface) {
			errors = append(errors, fmt.Sprintf(`invalid interface in "interfaces": %q`, iface))
		}
	}

	// Check capabilities
	for _, cap := range c.Capabilities {
		if !containsCapability(validCapabilities, cap) {
			errors = append(errors, fmt.Sprintf(`invalid capability in "capabilities": %q`, cap))
		}
	}

	return errors
}

// ValidateContractConsistency enforces role-specific consistency rules on top
// of the structural check (e.g. SensorProvider plugins must declare at least
// one provided sensor; Hub plugins cannot expose sensors). Returns a non-nil
// error on the first violation.
//
// Example:
//
//	if err := ValidateContractConsistency(contract, "my-plugin"); err != nil {
//	    return err
//	}
func ValidateContractConsistency(c *PluginContract, pluginName string) error {
	prefix := ""
	if pluginName != "" {
		prefix = "Plugin \"" + pluginName + "\": "
	}
	switch c.Role {
	case PluginRoleHub:
		if len(c.Provides) > 0 {
			return errors.New(prefix + "Hub plugins cannot provide sensors.")
		}
	case PluginRoleSensorProvider:
		if len(c.Provides) == 0 {
			return errors.New(prefix + "SensorProvider plugins must provide at least one sensor type.")
		}
	case PluginRoleCameraAndSensorProvider:
		if len(c.Provides) == 0 {
			return errors.New(prefix + "CameraAndSensorProvider plugins must provide at least one sensor type.")
		}
	}
	return nil
}

// IsHub reports whether the plugin's role is Hub (vendor cloud integration
// that manages its own cameras end-to-end).
//
// Example:
//
//	if IsHub(contract) {
//	    skipLocalDiscovery()
//	}
func IsHub(c *PluginContract) bool {
	return c.Role == PluginRoleHub
}

// CanCreateCameras reports whether the plugin can create cameras (role is
// CameraController or CameraAndSensorProvider). Used to gate camera-creating
// operations such as DiscoveryProvider adoption.
//
// Example:
//
//	if CanCreateCameras(contract) {
//	    enableAdoption()
//	}
func CanCreateCameras(c *PluginContract) bool {
	return c.Role == PluginRoleCameraController || c.Role == PluginRoleCameraAndSensorProvider
}

// CanProvideSensorsToAnyCameras reports whether the plugin is allowed to add
// sensors to cameras owned by other plugins (true for SensorProvider and
// CameraAndSensorProvider). Hub and pure CameraController plugins only see
// their own cameras.
//
// Example:
//
//	if CanProvideSensorsToAnyCameras(contract) {
//	    listAllCameras()
//	}
func CanProvideSensorsToAnyCameras(c *PluginContract) bool {
	return c.Role == PluginRoleSensorProvider || c.Role == PluginRoleCameraAndSensorProvider
}

// HasInterface reports whether the plugin implements the given capability
// (i.e. iface is listed in the contract's Interfaces).
//
// Example:
//
//	if HasInterface(contract, PluginInterfaceDiscoveryProvider) {
//	    startScan()
//	}
func HasInterface(c *PluginContract, iface PluginInterface) bool {
	return slices.Contains(c.Interfaces, iface)
}

// containsSensorType reports membership of val in slice (typed wrapper
// around slices.Contains).
func containsSensorType(slice []SensorType, val SensorType) bool {
	return slices.Contains(slice, val)
}

// containsRole reports membership of val in slice (typed wrapper around
// slices.Contains).
func containsRole(slice []PluginRole, val PluginRole) bool {
	return slices.Contains(slice, val)
}

// containsInterface reports membership of val in slice (typed wrapper
// around slices.Contains).
func containsInterface(slice []PluginInterface, val PluginInterface) bool {
	return slices.Contains(slice, val)
}

// containsCapability reports membership of val in slice (typed wrapper
// around slices.Contains).
func containsCapability(slice []PluginCapability, val PluginCapability) bool {
	return slices.Contains(slice, val)
}

// HasCapability reports whether the plugin requested the given capability
// (i.e. cap is listed in the contract's Capabilities).
//
// Example:
//
//	if HasCapability(contract, CapabilityPublishNotifications) {
//	    allowPublish()
//	}
func HasCapability(c *PluginContract, cap PluginCapability) bool {
	return slices.Contains(c.Capabilities, cap)
}
