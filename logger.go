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

// The host parses lines of this shape and routes them to its log sinks.
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

func (l *Logger) Log(args ...any) { l.write("log", args...) }

func (l *Logger) Error(args ...any) { l.write("error", args...) }

func (l *Logger) Warn(args ...any) { l.write("warn", args...) }

func (l *Logger) Success(args ...any) { l.write("success", args...) }

func (l *Logger) Attention(args ...any) { l.write("attention", args...) }

func (l *Logger) Debug(args ...any) {
	if l.debugEnabled {
		l.write("debug", args...)
	}
}

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
