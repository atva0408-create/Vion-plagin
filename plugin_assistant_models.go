package sdk

// AssistantModelSpec is one model a plugin offers to the assistant. The user
// picks it under Settings, Assistant like any other model; the host never sees
// a key or an endpoint of it.
type AssistantModelSpec struct {
	// ID of the model, unique within the plugin and stable across restarts: the settings store it.
	ID string `msgpack:"id" json:"id"`
	// Name shown in the model list.
	Name string `msgpack:"name" json:"name"`
	// ContextTokens is the hard context limit of the model. The host plans prompt, tools and history with it.
	ContextTokens int `msgpack:"contextTokens" json:"contextTokens"`
	// Vision reports whether the model reads images. Without it the host sends text only.
	Vision bool `msgpack:"vision" json:"vision"`
	// ToolCalling reports whether the model calls tools. Without it the assistant answers from the conversation alone.
	ToolCalling bool `msgpack:"toolCalling" json:"toolCalling"`
	// StructuredOutput reports whether the model honors a JSON schema. Without it the host asks for free text.
	StructuredOutput bool `msgpack:"structuredOutput" json:"structuredOutput"`
	// Note is one line shown next to the model, for example where it runs or what it costs.
	Note string `msgpack:"note,omitempty" json:"note,omitempty"`
}

// AssistantModelContent is one part of a message: Type "text" with Text, or
// Type "image" with Data and MimeType. Images arrive only for a model whose
// spec says Vision, and only when the instance allows pictures to reach it.
type AssistantModelContent struct {
	// Type is "text" or "image".
	Type string `msgpack:"type" json:"type"`
	// Text of a text part.
	Text string `msgpack:"text,omitempty" json:"text,omitempty"`
	// Data is the base64-encoded image of an image part.
	Data string `msgpack:"data,omitempty" json:"data,omitempty"`
	// MimeType of Data: image/jpeg, image/png or image/webp.
	MimeType string `msgpack:"mimeType,omitempty" json:"mimeType,omitempty"`
}

// AssistantModelToolCall is a tool call: which tool with which arguments.
type AssistantModelToolCall struct {
	// ID the host uses to match the result, unique within the request.
	ID string `msgpack:"id" json:"id"`
	// Name of the tool as declared in AssistantModelRequest.Tools.
	Name string `msgpack:"name" json:"name"`
	// Arguments as parsed JSON, matching the tool's input schema.
	Arguments map[string]any `msgpack:"arguments" json:"arguments"`
}

// AssistantModelMessage is one message of the conversation. A message with
// Role "tool" carries the result of the call with the matching ToolCallID.
type AssistantModelMessage struct {
	// Role is "user", "assistant" or "tool".
	Role string `msgpack:"role" json:"role"`
	// Content holds the text and images of the message.
	Content []AssistantModelContent `msgpack:"content" json:"content"`
	// ToolCalls the assistant asked for, on assistant messages.
	ToolCalls []AssistantModelToolCall `msgpack:"toolCalls,omitempty" json:"toolCalls,omitempty"`
	// ToolCallID names the call this message answers, on tool messages.
	ToolCallID string `msgpack:"toolCallId,omitempty" json:"toolCallId,omitempty"`
}

// AssistantModelTool is a tool the model may call in this request.
type AssistantModelTool struct {
	// Name the model uses in its call.
	Name string `msgpack:"name" json:"name"`
	// Description of what the tool does, written for the model.
	Description string `msgpack:"description" json:"description"`
	// InputSchema is the JSON Schema object of the arguments.
	InputSchema map[string]any `msgpack:"inputSchema" json:"inputSchema"`
}

// AssistantModelRequest is one request to a plugin model: the conversation so
// far plus what the model may do with it.
type AssistantModelRequest struct {
	// ModelID from AssistantModelSpec.ID.
	ModelID string `msgpack:"modelId" json:"modelId"`
	// System holds the instructions that precede the conversation.
	System []string `msgpack:"system" json:"system"`
	// Messages of the conversation, oldest first. The host has already trimmed them to ContextTokens.
	Messages []AssistantModelMessage `msgpack:"messages" json:"messages"`
	// Tools the model may call. Empty when the run allows none.
	Tools []AssistantModelTool `msgpack:"tools" json:"tools"`
	// OutputSchema the answer has to match. Only set for models whose spec says StructuredOutput.
	OutputSchema map[string]any `msgpack:"outputSchema,omitempty" json:"outputSchema,omitempty"`
	// MaxOutputTokens bounds the answer, when the host has a bound.
	MaxOutputTokens int `msgpack:"maxOutputTokens,omitempty" json:"maxOutputTokens,omitempty"`
}

// AssistantModelChunk is a piece of the answer. Send Type "text" as it is
// generated, "tool_call" once the arguments are complete, "usage" when the
// model reports token counts, and "done" exactly once at the end.
type AssistantModelChunk struct {
	// Type is "text", "tool_call", "usage" or "done".
	Type string `msgpack:"type" json:"type"`
	// Delta is the text generated since the last chunk, with Type "text".
	Delta string `msgpack:"delta,omitempty" json:"delta,omitempty"`
	// Call the model asks for, with Type "tool_call".
	Call *AssistantModelToolCall `msgpack:"call,omitempty" json:"call,omitempty"`
	// PromptTokens the request consumed, with Type "usage".
	PromptTokens int `msgpack:"promptTokens,omitempty" json:"promptTokens,omitempty"`
	// CompletionTokens the answer consumed, with Type "usage".
	CompletionTokens int `msgpack:"completionTokens,omitempty" json:"completionTokens,omitempty"`
	// Finish says why the model stopped, with Type "done": stop, tool_calls, length or error.
	Finish string `msgpack:"finish,omitempty" json:"finish,omitempty"`
	// Message says what went wrong, with Finish "error".
	Message string `msgpack:"message,omitempty" json:"message,omitempty"`
}

// AssistantModelContext says who the answer is for and when to stop writing it.
type AssistantModelContext struct {
	// UserID of the user the answer is for. Empty for scheduled runs and plugin requests.
	UserID string `msgpack:"userId,omitempty" json:"userId,omitempty"`
	// Language is the BCP 47 tag the answer should use.
	Language string `msgpack:"language" json:"language"`
	// TimeoutMs is how long the host waits before it drops the answer.
	TimeoutMs int `msgpack:"timeoutMs" json:"timeoutMs"`
}

// AssistantModelProvider is implemented by plugins that list
// PluginInterfaceAssistantModels in their contract. Such a plugin is a bridge
// to a model the host cannot reach itself: one without an HTTP API, one behind
// an unusual authentication, or one that lives on the machine the plugin runs
// on. The plugin holds no conversation state, every request carries the whole
// conversation.
//
// Example:
//
//	func (p *MyPlugin) AssistantModels() []sdk.AssistantModelSpec {
//		return []sdk.AssistantModelSpec{{ID: "local", Name: "Local", ContextTokens: 8192, ToolCalling: true}}
//	}
//
//	func (p *MyPlugin) AssistantGenerate(request sdk.AssistantModelRequest, ctx sdk.AssistantModelContext) (<-chan sdk.AssistantModelChunk, error) {
//		out := make(chan sdk.AssistantModelChunk)
//		go func() {
//			defer close(out)
//			out <- sdk.AssistantModelChunk{Type: "text", Delta: p.answer(request)}
//			out <- sdk.AssistantModelChunk{Type: "done", Finish: "stop"}
//		}()
//		return out, nil
//	}
type AssistantModelProvider interface {
	// AssistantModels lists the models this plugin offers. Called after the
	// plugin is ready and whenever the settings page is opened; empty while
	// the plugin has no usable model.
	AssistantModels() []AssistantModelSpec
	// AssistantGenerate answers one request. The host reads chunks until the
	// one with Type "done", then either returns the text to the user or runs
	// the tool calls and asks again with their results in Messages.
	AssistantGenerate(request AssistantModelRequest, ctx AssistantModelContext) (<-chan AssistantModelChunk, error)
}
