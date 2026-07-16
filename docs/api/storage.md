# Storage & Schema

Schema-driven configuration store rendered as UI forms by the host. `DeviceStorage` exposes the schema definition / read / write API; `JsonSchema` and friends describe individual fields, conditional visibility, and submit-form responses.

!!! note
    The reference below is auto-generated from Go doc comments via [`gomarkdoc`](https://github.com/princjef/gomarkdoc). Re-run `scripts/gen-api-docs.sh` to refresh it.

## type ButtonColor

ButtonColor controls the color variant of a button\-type schema.

	type ButtonColor string

<a name="ButtonColorSuccess"></a>

	const (
	    ButtonColorSuccess ButtonColor = "success"
	    ButtonColorInfo    ButtonColor = "info"
	    ButtonColorWarn    ButtonColor = "warn"
	    ButtonColorDanger  ButtonColor = "danger"
	)

<a name="Camera"></a>

## type DeviceStorage

DeviceStorage is the schema\-driven configuration store for a plugin, camera, or sensor. Define the fields the UI renders via DefineSchemas, then read/write values via GetValue / SetValue. Each plugin and camera can have its own storage instance.

Example:

	storage.DefineSchemas([]JsonSchema{
	    {Type: JsonSchemaTypeString, Key: "username", Title: "Username", Description: "Account username", Store: Bool(true)},
	    {Type: JsonSchemaTypeString, Key: "password", Title: "Password", Description: "Account password", Format: StringFormatPassword, Store: Bool(true)},
	})
	
	threshold := storage.GetValue("motionThreshold", 50)
	if err := storage.SetValue("motionThreshold", 75); err != nil {
	    log.Error("persist failed:", err)
	}
	

	type DeviceStorage struct {
	    Schemas []JsonSchema
	    Values  map[string]any
	    // contains filtered or unexported fields
	}

<a name="DeviceStorage.AddSchema"></a>
### func \(\*DeviceStorage\) AddSchema

	func (ds *DeviceStorage) AddSchema(schema *JsonSchema) error

AddSchema adds a new schema field. Returns an error if a schema with that key already exists — use ChangeSchema to modify an existing field.

<a name="DeviceStorage.ChangeSchema"></a>
### func \(\*DeviceStorage\) ChangeSchema

	func (ds *DeviceStorage) ChangeSchema(key string, newSchema *JsonSchema) error

ChangeSchema replaces an existing key's schema with a full JsonSchema; individual fields are not merged. The passed key always wins. It is a no\-op when no schema with that key is registered — use AddSchema to add a new field.

<a name="DeviceStorage.DefineSchemas"></a>
### func \(\*DeviceStorage\) DefineSchemas

	func (ds *DeviceStorage) DefineSchemas(schemas []JsonSchema)

DefineSchemas sets all schemas for this storage. Schema defaults fill any key the store does not carry; existing stored values win.

<a name="DeviceStorage.Destroy"></a>
### func \(\*DeviceStorage\) Destroy

	func (ds *DeviceStorage) Destroy() error

Destroy clears this storage's values and deletes its location from the store, blocking until the deletion is durable.

<a name="DeviceStorage.GetConfig"></a>
### func \(\*DeviceStorage\) GetConfig

	func (ds *DeviceStorage) GetConfig() map[string]any

GetConfig returns the full schema configuration \(schema definitions and current values\).

<a name="DeviceStorage.GetSchema"></a>
### func \(\*DeviceStorage\) GetSchema

	func (ds *DeviceStorage) GetSchema(key string) *JsonSchema

GetSchema returns a schema by key.

<a name="DeviceStorage.GetValue"></a>
### func \(\*DeviceStorage\) GetValue

	func (ds *DeviceStorage) GetValue(key string, defaultValue ...any) any

GetValue retrieves a configuration value. If the schema declares an OnGet callback, its result is returned as\-is, with no fallback. Otherwise resolves in order: the stored value, the schema default, then the provided default.

<a name="DeviceStorage.HasSchema"></a>
### func \(\*DeviceStorage\) HasSchema

	func (ds *DeviceStorage) HasSchema(key string) bool

HasSchema checks if a schema exists.

<a name="DeviceStorage.HasValue"></a>
### func \(\*DeviceStorage\) HasValue

	func (ds *DeviceStorage) HasValue(key string) bool

HasValue checks if a configuration value exists.

<a name="DeviceStorage.RPCMethods"></a>
### func \(\*DeviceStorage\) RPCMethods

	func (ds *DeviceStorage) RPCMethods() []string

RPCMethods restricts the storage's RPC surface to the config API. Exported lifecycle methods \(Save, DefineSchemas\) stay callable in\-process for plugin authors but are not reachable over the wire.

<a name="DeviceStorage.RemoveSchema"></a>
### func \(\*DeviceStorage\) RemoveSchema

	func (ds *DeviceStorage) RemoveSchema(key string) error

RemoveSchema removes a schema field by key, deleting its stored value along with it.

<a name="DeviceStorage.Save"></a>
### func \(\*DeviceStorage\) Save

	func (ds *DeviceStorage) Save() error

Save persists the storable configuration state, returning once the write is durable \(file synced or master acknowledged\).

<a name="DeviceStorage.SetConfig"></a>
### func \(\*DeviceStorage\) SetConfig

	func (ds *DeviceStorage) SetConfig(newConfig map[string]any) error

SetConfig merges new configuration values into the existing config and blocks until the merged state is durable. Values outside the storable domain reject the whole call before anything is applied. OnSet callbacks for keys whose values actually changed \(deep compare\) fire detached after the persist.

<a name="DeviceStorage.SetInternalValue"></a>
### func \(\*DeviceStorage\) SetInternalValue

	func (ds *DeviceStorage) SetInternalValue(key string, value any) error

SetInternalValue sets a system\-internal value \(e.g. \_displayName\) without requiring a schema, blocking until it is persisted. A nil value deletes the key; values outside the storable domain are rejected.

<a name="DeviceStorage.SetValue"></a>
### func \(\*DeviceStorage\) SetValue

	func (ds *DeviceStorage) SetValue(key string, value any) error

SetValue sets a configuration value. A nil value deletes the key. Only processes if a schema exists for the key. When the schema has Store=true the call blocks until the write is durable and returns its error; values outside the storable domain are rejected and the previous value kept. OnSet\(newValue, oldValue\) fires detached after the persist.

<a name="DeviceStorage.SubmitValue"></a>
### func \(\*DeviceStorage\) SubmitValue

	func (ds *DeviceStorage) SubmitValue(key string, value any) map[string]any

SubmitValue handles a submit\-type field click, invoking OnClick and returning its optional toast/schema response.

<a name="DiscoveredCamera"></a>

## type FormSubmitResponse

FormSubmitResponse is returned by JsonSchema.OnClick \(Type=submit\).

Used to react to a user\-triggered submit \(e.g. "Test connection", "Pair device"\) with optional UI feedback.

	type FormSubmitResponse struct {
	    // Toast is an optional banner to display after the submit completes.
	    Toast *ToastMessage `json:"toast,omitempty" msgpack:"toast,omitempty"`
	    // Schema optionally replaces the rendered form fields (full replacement).
	    Schema []JsonSchema `json:"schema,omitempty" msgpack:"schema,omitempty"`
	}

<a name="FrameFormat"></a>

## type JsonSchema

JsonSchema represents a single configuration field rendered in the UI.

This is a unified struct that covers every schema variant — Type acts as the discriminator. Only the fields meaningful for the chosen Type are honored; the rest are ignored. Use this struct in the slice you pass to DeviceStorage.DefineSchemas or .AddSchema.

	type JsonSchema struct {
	    // Type is the field type (string/number/boolean/array/button/submit).
	    Type JsonSchemaType `json:"type" msgpack:"type"`
	    // Key uniquely identifies this field within the storage scope.
	    Key string `json:"key" msgpack:"key"`
	    // Title is the human-readable label shown above the input.
	    Title string `json:"title" msgpack:"title"`
	    // Description is the help text shown beneath the input.
	    Description string `json:"description" msgpack:"description"`
	    // Group bundles related fields under a collapsible section in the UI.
	    Group string `json:"group,omitempty" msgpack:"group,omitempty"`
	    // Hidden removes the field from the UI but keeps it in the schema.
	    Hidden bool `json:"hidden,omitempty" msgpack:"hidden,omitempty"`
	    // Required marks the field as mandatory in the UI.
	    Required bool `json:"required,omitempty" msgpack:"required,omitempty"`
	    // ReadOnly makes the field non-editable in the UI.
	    ReadOnly bool `json:"readonly,omitempty" msgpack:"readonly,omitempty"`
	    // Placeholder is the hint text shown when the field is empty.
	    Placeholder string `json:"placeholder,omitempty" msgpack:"placeholder,omitempty"`
	    // DefaultValue seeds the value when no stored value exists.
	    DefaultValue any `json:"defaultValue,omitempty" msgpack:"defaultValue,omitempty"`
	    // Store controls whether the value is persisted to disk.
	    Store *bool `json:"store,omitempty" msgpack:"store,omitempty"`
	    // Condition controls visibility based on other field values (AND when multiple).
	    Condition []SchemaCondition `json:"condition,omitempty" msgpack:"condition,omitempty"`
	
	    // Format selects a specialized string control (Type=string only).
	    Format StringFormat `json:"format,omitempty" msgpack:"format,omitempty"`
	    // MinLength is the minimum string length (Type=string only).
	    MinLength *int `json:"minLength,omitempty" msgpack:"minLength,omitempty"`
	    // MaxLength is the maximum string length (Type=string only).
	    MaxLength *int `json:"maxLength,omitempty" msgpack:"maxLength,omitempty"`
	
	    // Minimum is the minimum numeric value (Type=number only).
	    Minimum *float64 `json:"minimum,omitempty" msgpack:"minimum,omitempty"`
	    // Maximum is the maximum numeric value (Type=number only).
	    Maximum *float64 `json:"maximum,omitempty" msgpack:"maximum,omitempty"`
	    // Step is the increment for numeric inputs (Type=number only).
	    Step *float64 `json:"step,omitempty" msgpack:"step,omitempty"`
	
	    // Enum lists allowed string values; renders as a select control.
	    Enum []string `json:"enum,omitempty" msgpack:"enum,omitempty"`
	    // Multiple allows selecting more than one enum value.
	    Multiple bool `json:"multiple,omitempty" msgpack:"multiple,omitempty"`
	
	    // Opened expands array items by default (Type=array only).
	    Opened bool `json:"opened,omitempty" msgpack:"opened,omitempty"`
	    // Items defines the schema for each entry of an array field.
	    Items *JsonSchema `json:"items,omitempty" msgpack:"items,omitempty"`
	
	    // Color is the button color variant (Type=button or Type=submit only).
	    Color ButtonColor `json:"color,omitempty" msgpack:"color,omitempty"`
	
	    // OnSet is invoked after SetValue writes the key, changed or not; SetConfig
	    // calls it only for keys that changed. Receives (newValue, oldValue).
	    OnSet func(newValue, oldValue any) any `json:"-" msgpack:"-"`
	    // OnGet is invoked to compute the current value at read time.
	    OnGet func() any `json:"-" msgpack:"-"`
	    // OnClick is invoked when a submit-type field is submitted (Type=submit only).
	    OnClick func(value any) *FormSubmitResponse `json:"-" msgpack:"-"`
	}

<a name="JsonSchema.ToMap"></a>
### func \(\*JsonSchema\) ToMap

	func (s *JsonSchema) ToMap() map[string]any

ToMap converts a JsonSchema to a map for RPC serialization.

<a name="JsonSchemaType"></a>

## type JsonSchemaType

JsonSchemaType is the field type discriminating which UI control renders the value.

	type JsonSchemaType string

<a name="JsonSchemaTypeString"></a>

	const (
	    JsonSchemaTypeString  JsonSchemaType = "string"
	    JsonSchemaTypeNumber  JsonSchemaType = "number"
	    JsonSchemaTypeBoolean JsonSchemaType = "boolean"
	    JsonSchemaTypeArray   JsonSchemaType = "array"
	    JsonSchemaTypeButton  JsonSchemaType = "button"
	    JsonSchemaTypeSubmit  JsonSchemaType = "submit"
	)

<a name="LeakSensor"></a>

## type SchemaCondition

SchemaCondition controls conditional field visibility. The field is shown only when the condition evaluates to true against the current form values.

Combine multiple conditions on a field by passing a slice — all must pass \(logical AND\).

Example — show "apiKey" only when "authMode" equals "token":

	JsonSchema{
	    Type:      JsonSchemaTypeString,
	    Key:       "apiKey",
	    Title:     "API Key",
	    Condition: []SchemaCondition{{Key: "authMode", Value: "token"}},
	}
	

	type SchemaCondition struct {
	    // Key of another field whose value drives visibility.
	    Key string `json:"key" msgpack:"key"`
	    // Value is the expected value — single value, or array for In / Nin.
	    Value any `json:"value" msgpack:"value"`
	    // Operator is the comparison operator (default: SchemaConditionEq).
	    Operator SchemaConditionOperator `json:"operator,omitempty" msgpack:"operator,omitempty"`
	}

<a name="SchemaConditionOperator"></a>

## type SchemaConditionOperator

SchemaConditionOperator defines comparison operators for SchemaCondition.

	type SchemaConditionOperator string

<a name="SchemaConditionEq"></a>

	const (
	    SchemaConditionEq  SchemaConditionOperator = "eq"
	    SchemaConditionNeq SchemaConditionOperator = "neq"
	    SchemaConditionGt  SchemaConditionOperator = "gt"
	    SchemaConditionLt  SchemaConditionOperator = "lt"
	    SchemaConditionIn  SchemaConditionOperator = "in"
	    SchemaConditionNin SchemaConditionOperator = "nin"
	)

<a name="SecuritySystem"></a>

## type StorageController



	type StorageController struct {
	    // contains filtered or unexported fields
	}

<a name="StorageSchemaProvider"></a>

## type StringFormat

StringFormat selects a specialized UI control for a string field.

	type StringFormat string

<a name="StringFormatDateTime"></a>

	const (
	    StringFormatDateTime StringFormat = "date-time"
	    StringFormatDate     StringFormat = "date"
	    StringFormatTime     StringFormat = "time"
	    StringFormatEmail    StringFormat = "email"
	    StringFormatUUID     StringFormat = "uuid"
	    StringFormatIPv4     StringFormat = "ipv4"
	    StringFormatIPv6     StringFormat = "ipv6"
	    StringFormatPassword StringFormat = "password"
	    StringFormatQRCode   StringFormat = "qrCode"
	    StringFormatImage    StringFormat = "image"
	)

<a name="Subject"></a>

## type ToastMessage

ToastMessage represents a transient banner to show in the UI.

Returned from a submit handler \(JsonSchema.OnClick\) inside a FormSubmitResponse to surface UI feedback — for example to confirm that a credential check succeeded or failed.

	type ToastMessage struct {
	    // Type is the severity that controls the icon/color of the banner.
	    Type ToastType `json:"type" msgpack:"type"`
	    // Message is the human-readable message text.
	    Message string `json:"message" msgpack:"message"`
	}

<a name="ToastType"></a>

## type ToastType

ToastType is the severity of a toast notification.

	type ToastType string

<a name="ToastInfo"></a>

	const (
	    ToastInfo    ToastType = "info"
	    ToastSuccess ToastType = "success"
	    ToastWarning ToastType = "warning"
	    ToastError   ToastType = "error"
	)

<a name="TrackVelocity"></a>
