package sdk

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
)

// Logger emits structured JSON log lines on stdout for the parent (host)
// process to parse, classify, and forward to the configured log sinks.
//
// Each entry is wrapped in a childLogMessage envelope and contains the
// severity level, message text, optional prefix/suffix, and the target
// (plugin/camera/sensor) the entry belongs to.
//
// Severity levels mirror the LoggerService interface in the other SDKs:
//
//   - log:       general informational message (default level).
//   - warn:      potential problem that does not stop execution.
//   - error:     a failure or unexpected condition.
//   - success:   confirmation of a completed operation.
//   - debug:     diagnostic detail; only emitted when DebugEnabled is true.
//   - trace:     very fine-grained diagnostic detail; only emitted when
//     TraceEnabled is true.
//   - attention: highlighted message that should stand out in the log
//     stream.
type Logger struct {
	mu           sync.Mutex
	prefix       string
	suffix       string
	targetID     string
	targetType   string
	pluginID     string
	debugEnabled bool
	traceEnabled bool
}

// logEntry is the structured payload of a single log line.
type logEntry struct {
	Timestamp  int64  `json:"timestamp"`
	Level      string `json:"level"`
	Prefix     string `json:"prefix"`
	Suffix     string `json:"suffix,omitempty"`
	Message    string `json:"message"`
	TargetID   string `json:"targetId,omitempty"`
	TargetType string `json:"targetType,omitempty"`
	PluginID   string `json:"pluginId,omitempty"`
	Source     string `json:"source"`
	ProcessID  int    `json:"processId,omitempty"`
}

// childLogMessage is the envelope written to stdout for each log entry.
// The host parses lines of this shape and routes them to its log sinks.
type childLogMessage struct {
	Type  string   `json:"type"`
	Entry logEntry `json:"entry"`
}

// loggerOptions configures a Logger.
//
//   - Prefix/Suffix:        free-form labels prepended/appended in the host log.
//   - TargetID/TargetType:  identifies the entity (plugin, camera, sensor) the
//     logger is associated with.
//   - PluginID:             owning plugin identifier.
//   - DebugEnabled:         when true, Debug() entries are emitted.
//   - TraceEnabled:         when true, Trace() entries are emitted.
type loggerOptions struct {
	Prefix       string
	Suffix       string
	TargetID     string
	TargetType   string
	PluginID     string
	DebugEnabled bool
	TraceEnabled bool
}

// newLogger creates a new Logger with the given options. Used by the SDK
// runtime to construct the root logger; plugins receive that logger and
// derive child loggers via Logger.CreateLogger.
func newLogger(opts *loggerOptions) *Logger {
	return &Logger{
		prefix:       opts.Prefix,
		suffix:       opts.Suffix,
		targetID:     opts.TargetID,
		targetType:   opts.TargetType,
		pluginID:     opts.PluginID,
		debugEnabled: opts.DebugEnabled,
		traceEnabled: opts.TraceEnabled,
	}
}

// CreateLogger derives a child logger that inherits the parent's prefix,
// pluginID and debug/trace toggles, but uses a fresh suffix and target
// identification (typically a camera or sensor scope).
func (l *Logger) CreateLogger(opts *loggerOptions) *Logger {
	return &Logger{
		prefix:       l.prefix,
		suffix:       opts.Suffix,
		targetID:     opts.TargetID,
		targetType:   opts.TargetType,
		pluginID:     l.pluginID,
		debugEnabled: l.debugEnabled,
		traceEnabled: l.traceEnabled,
	}
}

func (l *Logger) write(level string, args ...any) {
	msg := formatArgs(args...)

	entry := logEntry{
		Timestamp:  time.Now().UnixMilli(),
		Level:      level,
		Prefix:     l.prefix,
		Suffix:     l.suffix,
		Message:    msg,
		TargetID:   l.targetID,
		TargetType: l.targetType,
		PluginID:   l.pluginID,
		Source:     "child",
		ProcessID:  os.Getpid(),
	}

	childMsg := childLogMessage{
		Type:  "log",
		Entry: entry,
	}

	data, err := json.Marshal(childMsg)
	if err != nil {
		return
	}

	l.mu.Lock()
	defer l.mu.Unlock()
	_, _ = fmt.Fprintln(os.Stdout, string(data))
}

func formatArgs(args ...any) string {
	parts := make([]string, len(args))
	for i, arg := range args {
		parts[i] = fmt.Sprintf("%v", arg)
	}
	return strings.Join(parts, " ")
}

// Log writes an info-level (general informational) entry.
func (l *Logger) Log(args ...any) { l.write("log", args...) }

// Error writes an error-level (failure or unexpected condition) entry.
func (l *Logger) Error(args ...any) { l.write("error", args...) }

// Warn writes a warning-level (potential problem that does not stop
// execution) entry.
func (l *Logger) Warn(args ...any) { l.write("warn", args...) }

// Success writes a success-level (confirmation of a completed operation)
// entry.
func (l *Logger) Success(args ...any) { l.write("success", args...) }

// Attention writes an attention-level (highlighted message that should
// stand out in the log stream) entry.
func (l *Logger) Attention(args ...any) { l.write("attention", args...) }

// Debug writes a debug-level (diagnostic detail) entry. Only emitted when
// DebugEnabled is true on the logger.
func (l *Logger) Debug(args ...any) {
	if l.debugEnabled {
		l.write("debug", args...)
	}
}

// Trace writes a trace-level (very fine-grained diagnostic detail) entry.
// Only emitted when TraceEnabled is true on the logger.
func (l *Logger) Trace(args ...any) {
	if l.traceEnabled {
		l.write("trace", args...)
	}
}
