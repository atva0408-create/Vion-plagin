package sdk

// AssistantToolProperty is the property schema of a tool input: the JSON
// Schema draft-07 subset every supported model provider accepts unchanged.
// Fill the fields that apply to Type, the rest stay empty.
type AssistantToolProperty struct {
	// Type is one of string, number, integer, boolean, array or object.
	Type string `msgpack:"type" json:"type"`
	// Description tells the model what the argument means.
	Description string `msgpack:"description,omitempty" json:"description,omitempty"`
	// Enum restricts a string to these values.
	Enum []string `msgpack:"enum,omitempty" json:"enum,omitempty"`
	// Format of a string: date-time, date or time.
	Format string `msgpack:"format,omitempty" json:"format,omitempty"`
	// Minimum of a number or integer.
	Minimum *float64 `msgpack:"minimum,omitempty" json:"minimum,omitempty"`
	// Maximum of a number or integer.
	Maximum *float64 `msgpack:"maximum,omitempty" json:"maximum,omitempty"`
	// MinItems of an array.
	MinItems *int `msgpack:"minItems,omitempty" json:"minItems,omitempty"`
	// MaxItems of an array.
	MaxItems *int `msgpack:"maxItems,omitempty" json:"maxItems,omitempty"`
	// Items is the element schema of an array.
	Items *AssistantToolProperty `msgpack:"items,omitempty" json:"items,omitempty"`
	// Properties are the named members of an object.
	Properties map[string]AssistantToolProperty `msgpack:"properties,omitempty" json:"properties,omitempty"`
	// Required lists the object members the model has to provide.
	Required []string `msgpack:"required,omitempty" json:"required,omitempty"`
}

// AssistantToolSchema is the input schema of a tool: always an object schema.
// The model fills the properties, the host passes them to CallAssistantTool
// as a parsed map.
type AssistantToolSchema struct {
	// Type is always "object".
	Type string `msgpack:"type" json:"type"`
	// Properties are the named arguments the model may pass.
	Properties map[string]AssistantToolProperty `msgpack:"properties" json:"properties"`
	// Required lists the arguments the model has to provide.
	Required []string `msgpack:"required,omitempty" json:"required,omitempty"`
	// AdditionalProperties set to a false pointer rejects arguments outside Properties.
	AdditionalProperties *bool `msgpack:"additionalProperties,omitempty" json:"additionalProperties,omitempty"`
}

// AssistantToolSpec is one tool a plugin offers to the assistant. The host
// prefixes Name with the plugin name, so names only have to be unique within
// the plugin.
//
// Example:
//
//	queryEvents := sdk.AssistantToolSpec{
//		Name:        "query_events",
//		Description: "List recorded events for a time range, optionally filtered by camera and label.",
//		InputSchema: sdk.AssistantToolSchema{
//			Type: "object",
//			Properties: map[string]sdk.AssistantToolProperty{
//				"from":   {Type: "string", Format: "date-time", Description: "Start of the range, ISO 8601"},
//				"to":     {Type: "string", Format: "date-time", Description: "End of the range, ISO 8601"},
//				"camera": {Type: "string", Description: "Camera name, all cameras when omitted"},
//			},
//			Required: []string{"from", "to"},
//		},
//	}
type AssistantToolSpec struct {
	// Name is the tool name in snake_case, unique within the plugin.
	Name string `msgpack:"name" json:"name"`
	// Description says what the tool does and when to use it, written for the model. Name units and defaults.
	Description string `msgpack:"description" json:"description"`
	// InputSchema is the object schema of the arguments.
	InputSchema AssistantToolSchema `msgpack:"inputSchema" json:"inputSchema"`
	// Approval makes the user confirm every call before it runs. Set it on anything that changes state.
	Approval bool `msgpack:"approval,omitempty" json:"approval,omitempty"`
	// AdminOnly hides the tool from users without the admin role.
	AdminOnly bool `msgpack:"adminOnly,omitempty" json:"adminOnly,omitempty"`
	// TimeoutMs is the time the host waits for CallAssistantTool, in milliseconds. Default 60000.
	TimeoutMs int `msgpack:"timeoutMs,omitempty" json:"timeoutMs,omitempty"`
	// Lazy offers the tool through tool discovery instead of on every turn. Use for rarely needed tools.
	Lazy bool `msgpack:"lazy,omitempty" json:"lazy,omitempty"`
}

// AssistantToolContext says who is asking and in which language. Passed to
// every tool call; the host has already enforced AdminOnly and Approval, the
// fields are information.
type AssistantToolContext struct {
	// UserID is the id of the user talking to the assistant.
	UserID string `msgpack:"userId" json:"userId"`
	// Role of the user: user, admin or master.
	Role string `msgpack:"role" json:"role"`
	// Language is the BCP 47 language tag of the conversation, for localized text results.
	Language string `msgpack:"language" json:"language"`
	// Timezone is the IANA time zone of the user, for parsing and formatting times.
	Timezone string `msgpack:"timezone" json:"timezone"`
	// ThreadID is the id of the conversation the tool is called from. Empty for scheduled runs and MCP clients.
	ThreadID string `msgpack:"threadId,omitempty" json:"threadId,omitempty"`
}

// AssistantToolImage is an image a tool returns alongside its text. Forwarded
// to the model only when the instance allows images to leave the machine, so
// the result's Content should still describe what the image shows.
type AssistantToolImage struct {
	// Data is the base64-encoded image bytes.
	Data string `msgpack:"data" json:"data"`
	// MimeType of Data: image/jpeg, image/png or image/webp.
	MimeType string `msgpack:"mimeType" json:"mimeType"`
	// Caption is a short caption shown to the user next to the image.
	Caption string `msgpack:"caption,omitempty" json:"caption,omitempty"`
}

// AssistantToolReference is something in the app a tool result points at.
// The chat renders it as a button that opens the matching view: the recording
// player for an event, the episode player for an episode, the camera page for
// a camera, or a download button for a file the DownloadManager serves.
type AssistantToolReference struct {
	// Kind says what ID names: event, episode, camera or download.
	Kind string `msgpack:"kind" json:"kind"`
	// ID of the event, episode or camera.
	ID string `msgpack:"id" json:"id"`
	// Label is a short label for the button, for example the camera name and time.
	Label string `msgpack:"label,omitempty" json:"label,omitempty"`
	// CameraID is the camera the event belongs to, required for event.
	CameraID string `msgpack:"cameraId,omitempty" json:"cameraId,omitempty"`
	// Timestamp is the start of the event or episode in milliseconds since the epoch, required for event.
	Timestamp int64 `msgpack:"timestamp,omitempty" json:"timestamp,omitempty"`
	// URL is the download path from the DownloadManager, required for download; the chat shows a download button labelled with Label.
	URL string `msgpack:"url,omitempty" json:"url,omitempty"`
}

// AssistantToolResult is the result of a tool call. Set Error for problems
// the model can repair by asking differently (unknown camera, empty range);
// return a Go error only for failures that should end the run.
type AssistantToolResult struct {
	// Content is the text (string), JSON object (map) or JSON list (slice) the model reads.
	Content any `msgpack:"content,omitempty" json:"content,omitempty"`
	// Images to show and, when allowed, to send to the model.
	Images []AssistantToolImage `msgpack:"images,omitempty" json:"images,omitempty"`
	// References are things the chat should offer to open, at most a handful per result.
	References []AssistantToolReference `msgpack:"references,omitempty" json:"references,omitempty"`
	// Error is a user-level problem the model may repair. Replaces Content.
	Error string `msgpack:"error,omitempty" json:"error,omitempty"`
}

// AssistantToolProvider is implemented by plugins that list
// PluginInterfaceAssistantTools in their contract. The host asks for the tool
// list once after the plugin is ready and dispatches calls by name.
//
// Example:
//
//	func (p *MyPlugin) AssistantTools() []sdk.AssistantToolSpec {
//		return []sdk.AssistantToolSpec{queryEvents}
//	}
//
//	func (p *MyPlugin) CallAssistantTool(name string, input map[string]any, ctx sdk.AssistantToolContext) (sdk.AssistantToolResult, error) {
//		if name == "query_events" {
//			events, err := p.store.Query(input["from"].(string), input["to"].(string))
//			return sdk.AssistantToolResult{Content: events}, err
//		}
//		return sdk.AssistantToolResult{Error: "Unknown tool " + name}, nil
//	}
type AssistantToolProvider interface {
	// AssistantTools lists the tools this plugin offers. Called once per
	// plugin start; empty when the plugin currently has none.
	AssistantTools() []AssistantToolSpec
	// CallAssistantTool runs one tool. Validate input against the declared
	// schema, the host does not. Returns text, JSON or images for the model,
	// or an Error it may repair.
	CallAssistantTool(name string, input map[string]any, ctx AssistantToolContext) (AssistantToolResult, error)
}
