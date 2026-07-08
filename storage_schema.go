package sdk

// JsonSchemaType is the field type discriminating which UI control renders
// the value.
type JsonSchemaType string

const (
	JsonSchemaTypeString  JsonSchemaType = "string"
	JsonSchemaTypeNumber  JsonSchemaType = "number"
	JsonSchemaTypeBoolean JsonSchemaType = "boolean"
	JsonSchemaTypeArray   JsonSchemaType = "array"
	JsonSchemaTypeButton  JsonSchemaType = "button"
	JsonSchemaTypeSubmit  JsonSchemaType = "submit"
)

// StringFormat selects a specialized UI control for a string field.
type StringFormat string

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

// SchemaConditionOperator defines comparison operators for SchemaCondition.
type SchemaConditionOperator string

const (
	SchemaConditionEq  SchemaConditionOperator = "eq"
	SchemaConditionNeq SchemaConditionOperator = "neq"
	SchemaConditionGt  SchemaConditionOperator = "gt"
	SchemaConditionLt  SchemaConditionOperator = "lt"
	SchemaConditionIn  SchemaConditionOperator = "in"
	SchemaConditionNin SchemaConditionOperator = "nin"
)

// ButtonColor controls the color variant of a button-type schema.
type ButtonColor string

const (
	ButtonColorSuccess ButtonColor = "success"
	ButtonColorInfo    ButtonColor = "info"
	ButtonColorWarn    ButtonColor = "warn"
	ButtonColorDanger  ButtonColor = "danger"
)

// ToastType is the severity of a toast notification.
type ToastType string

const (
	ToastInfo    ToastType = "info"
	ToastSuccess ToastType = "success"
	ToastWarning ToastType = "warning"
	ToastError   ToastType = "error"
)

// SchemaCondition controls conditional field visibility.
// The field is shown only when the condition evaluates to true against
// the current form values.
//
// Combine multiple conditions on a field by passing a slice — all must
// pass (logical AND).
//
// Example — show "apiKey" only when "authMode" equals "token":
//
//	JsonSchema{
//	    Type:      JsonSchemaTypeString,
//	    Key:       "apiKey",
//	    Title:     "API Key",
//	    Condition: []SchemaCondition{{Key: "authMode", Value: "token"}},
//	}
type SchemaCondition struct {
	// Key of another field whose value drives visibility.
	Key string `json:"key" msgpack:"key"`
	// Value is the expected value — single value, or array for In / Nin.
	Value any `json:"value" msgpack:"value"`
	// Operator is the comparison operator (default: SchemaConditionEq).
	Operator SchemaConditionOperator `json:"operator,omitempty" msgpack:"operator,omitempty"`
}

// ToastMessage represents a transient banner to show in the UI.
//
// Returned from a submit handler (JsonSchema.OnClick) inside a
// FormSubmitResponse to surface UI feedback — for example to confirm
// that a credential check succeeded or failed.
type ToastMessage struct {
	// Type is the severity that controls the icon/color of the banner.
	Type ToastType `json:"type" msgpack:"type"`
	// Message is the human-readable message text.
	Message string `json:"message" msgpack:"message"`
}

// FormSubmitResponse is returned by JsonSchema.OnClick (Type=submit).
//
// Used to react to a user-triggered submit (e.g. "Test connection",
// "Pair device") with optional UI feedback.
type FormSubmitResponse struct {
	// Toast is an optional banner to display after the submit completes.
	Toast *ToastMessage `json:"toast,omitempty" msgpack:"toast,omitempty"`
	// Schema optionally replaces the rendered form fields (full replacement).
	Schema []JsonSchema `json:"schema,omitempty" msgpack:"schema,omitempty"`
}

// JsonSchema represents a single configuration field rendered in the UI.
//
// This is a unified struct that covers every schema variant — Type acts as
// the discriminator. Only the fields meaningful for the chosen Type are
// honored; the rest are ignored. Use this struct in the slice you pass to
// DeviceStorage.DefineSchemas or .AddSchema.
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

	// OnSet is invoked after a value changes. Receives (newValue, oldValue).
	OnSet func(newValue, oldValue any) any `json:"-" msgpack:"-"`
	// OnGet is invoked to compute the current value at read time.
	OnGet func() any `json:"-" msgpack:"-"`
	// OnClick is invoked when a submit-type field is submitted (Type=submit only).
	OnClick func(value any) *FormSubmitResponse `json:"-" msgpack:"-"`
}

// ToMap converts a JsonSchema to a map for RPC serialization.
func (s *JsonSchema) ToMap() map[string]any {
	m := map[string]any{
		"type":        string(s.Type),
		"key":         s.Key,
		"title":       s.Title,
		"description": s.Description,
	}

	if s.Group != "" {
		m["group"] = s.Group
	}
	if s.Hidden {
		m["hidden"] = true
	}
	if s.Required {
		m["required"] = true
	}
	if s.ReadOnly {
		m["readonly"] = true
	}
	if s.Placeholder != "" {
		m["placeholder"] = s.Placeholder
	}
	if s.DefaultValue != nil {
		m["defaultValue"] = s.DefaultValue
	}
	if s.Store != nil {
		m["store"] = *s.Store
	}
	if s.Format != "" {
		m["format"] = string(s.Format)
	}
	if s.MinLength != nil {
		m["minLength"] = *s.MinLength
	}
	if s.MaxLength != nil {
		m["maxLength"] = *s.MaxLength
	}
	if s.Minimum != nil {
		m["minimum"] = *s.Minimum
	}
	if s.Maximum != nil {
		m["maximum"] = *s.Maximum
	}
	if s.Step != nil {
		m["step"] = *s.Step
	}
	if len(s.Enum) > 0 {
		m["enum"] = s.Enum
	}
	if s.Multiple {
		m["multiple"] = true
	}
	if s.Opened {
		m["opened"] = true
	}
	if s.Items != nil {
		m["items"] = s.Items.ToMap()
	}
	if s.Color != "" {
		m["color"] = string(s.Color)
	}
	if len(s.Condition) == 1 {
		c := map[string]any{
			"key":   s.Condition[0].Key,
			"value": s.Condition[0].Value,
		}
		if s.Condition[0].Operator != "" {
			c["operator"] = string(s.Condition[0].Operator)
		}
		m["condition"] = c
	} else if len(s.Condition) > 1 {
		arr := make([]map[string]any, len(s.Condition))
		for i, cond := range s.Condition {
			c := map[string]any{
				"key":   cond.Key,
				"value": cond.Value,
			}
			if cond.Operator != "" {
				c["operator"] = string(cond.Operator)
			}
			arr[i] = c
		}
		m["condition"] = arr
	}

	return m
}
