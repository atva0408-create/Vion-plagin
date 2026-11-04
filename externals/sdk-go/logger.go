package sdk

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
)

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

type childLogMessage struct {
	Type  string   `json:"type"`
	Entry logEntry `json:"entry"`
}

type loggerOptions struct {
	Prefix       string
	Suffix       string
	TargetID     string
	TargetType   string
	PluginID     string
	DebugEnabled bool
	TraceEnabled bool
}

// Logger writes structured log entries to stdout, where the host picks them up
// and routes them to its own sinks. Debug and Trace are dropped unless the
// matching level is enabled for the plugin.
//
// Accessed via the embedded BasePlugin.Logger from within a plugin.
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

// CreateLogger derives a child logger for a specific target (camera, sensor).
// Prefix, plugin id and the debug/trace levels are inherited.
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

// Log writes an informational entry. Arguments are formatted and joined with
// spaces.
//
// Example:
//
//	p.Logger.Log("connected to", host)
func (l *Logger) Log(args ...any) { l.write("log", args...) }

// Error writes an entry for a failure or unexpected condition.
func (l *Logger) Error(args ...any) { l.write("error", args...) }

// Warn writes an entry for a problem that does not stop execution.
func (l *Logger) Warn(args ...any) { l.write("warn", args...) }

// Success writes an entry confirming a completed operation.
func (l *Logger) Success(args ...any) { l.write("success", args...) }

// Attention writes a highlighted entry that stands out in the log stream.
func (l *Logger) Attention(args ...any) { l.write("attention", args...) }

// Debug writes a diagnostic entry, dropped unless debug logging is enabled.
func (l *Logger) Debug(args ...any) {
	if l.debugEnabled {
		l.write("debug", args...)
	}
}

// Trace writes a fine-grained diagnostic entry, dropped unless trace logging
// is enabled.
func (l *Logger) Trace(args ...any) {
	if l.traceEnabled {
		l.write("trace", args...)
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
