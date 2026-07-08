package sdk

// Generic event-listener registry for camera.ui.
//
// eventEmitter is an event-name keyed listener registry. Handlers are
// registered via On / Once, removed via Off / RemoveAllListeners, and
// invoked through Emit.

import (
	"sync"
	"time"
)

// eventHandler is a listener invoked when an event is emitted.
type eventHandler func(args ...any)

// eventEmitter is a thread-safe, generic event-listener registry that
// dispatches arbitrary positional arguments to handlers keyed by event
// name. Listeners can be registered for every emission with On or for a
// single emission with Once.
type eventEmitter struct {
	mu        sync.RWMutex
	listeners map[string][]eventEntry
}

type eventEntry struct {
	handler eventHandler
	once    bool
}

// newEventEmitter creates a new eventEmitter.
func newEventEmitter() *eventEmitter {
	return &eventEmitter{
		listeners: make(map[string][]eventEntry),
	}
}

// On registers a listener that is invoked for every emission of event.
func (e *eventEmitter) On(event string, handler eventHandler) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.listeners[event] = append(e.listeners[event], eventEntry{handler: handler})
}

// Once registers a one-shot listener that is invoked the next time
// event is emitted and then removed automatically.
func (e *eventEmitter) Once(event string, handler eventHandler) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.listeners[event] = append(e.listeners[event], eventEntry{handler: handler, once: true})
}

// Off removes listeners for the given event. Because Go function
// values are not reliably comparable, this removes every listener
// registered for the event regardless of the handler argument; use
// RemoveAllListeners for more explicit cleanup.
func (e *eventEmitter) Off(event string, handler eventHandler) {
	e.mu.Lock()
	defer e.mu.Unlock()
	// Since Go function values are not comparable, we remove all listeners
	// for this event. For fine-grained removal, use RemoveAllListeners.
	delete(e.listeners, event)
}

// Emit invokes every listener registered for event with the provided
// arguments. Once-listeners are removed after their handler runs.
func (e *eventEmitter) Emit(event string, args ...any) {
	e.mu.RLock()
	entries := make([]eventEntry, len(e.listeners[event]))
	copy(entries, e.listeners[event])
	e.mu.RUnlock()

	var toRemove []int
	for i, entry := range entries {
		entry.handler(args...)
		if entry.once {
			toRemove = append(toRemove, i)
		}
	}

	if len(toRemove) > 0 {
		e.mu.Lock()
		current := e.listeners[event]
		// Remove once handlers (iterate in reverse to preserve indices)
		for j := len(toRemove) - 1; j >= 0; j-- {
			idx := toRemove[j]
			if idx < len(current) {
				current = append(current[:idx], current[idx+1:]...)
			}
		}
		e.listeners[event] = current
		e.mu.Unlock()
	}
}

// emitAndWait invokes every listener registered for event, each in its own
// goroutine, and waits until all of them return or timeout elapses. It
// reports whether every listener finished in time. Panics are recovered and
// handed to onPanic (may be nil) so one failing listener never propagates or
// blocks the rest; work a handler spawns in goroutines of its own is not
// tracked.
func (e *eventEmitter) emitAndWait(event string, timeout time.Duration, onPanic func(recovered any), args ...any) bool {
	e.mu.Lock()
	current := e.listeners[event]
	entries := make([]eventEntry, len(current))
	copy(entries, current)
	// Drop once-listeners before invoking so they cannot fire again.
	kept := current[:0]
	for _, entry := range current {
		if !entry.once {
			kept = append(kept, entry)
		}
	}
	if len(kept) == 0 {
		delete(e.listeners, event)
	} else {
		e.listeners[event] = kept
	}
	e.mu.Unlock()

	if len(entries) == 0 {
		return true
	}

	var wg sync.WaitGroup
	for _, entry := range entries {
		wg.Go(func() {
			defer func() {
				if r := recover(); r != nil && onPanic != nil {
					onPanic(r)
				}
			}()
			entry.handler(args...)
		})
	}

	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()

	timer := time.NewTimer(timeout)
	defer timer.Stop()

	select {
	case <-done:
		return true
	case <-timer.C:
		return false
	}
}

// RemoveAllListeners removes every listener for the given event, or
// every listener for every event if event is the empty string.
func (e *eventEmitter) RemoveAllListeners(event string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if event == "" {
		e.listeners = make(map[string][]eventEntry)
	} else {
		delete(e.listeners, event)
	}
}
