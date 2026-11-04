package sdk

import (
	"slices"
	"testing"
)

func TestEmitterOnEmit(t *testing.T) {
	ee := newEventEmitter()
	var got []any
	ee.On("test", func(args ...any) { got = append(got, args[0]) })
	ee.Emit("test", "hello")
	if len(got) != 1 || got[0] != "hello" {
		t.Fatalf("got %v", got)
	}
}

func TestEmitterMultipleListenersInOrder(t *testing.T) {
	ee := newEventEmitter()
	var got []int
	ee.On("evt", func(...any) { got = append(got, 1) })
	ee.On("evt", func(...any) { got = append(got, 2) })
	ee.Emit("evt")
	if !slices.Equal(got, []int{1, 2}) {
		t.Fatalf("got %v", got)
	}
}

func TestEmitterPassesArgs(t *testing.T) {
	ee := newEventEmitter()
	var a, b any
	ee.On("evt", func(args ...any) { a, b = args[0], args[1] })
	ee.Emit("evt", 7, "x")
	if a != 7 || b != "x" {
		t.Fatalf("a=%v b=%v", a, b)
	}
}

func TestEmitterOnceFiresOnce(t *testing.T) {
	ee := newEventEmitter()
	count := 0
	ee.Once("evt", func(...any) { count++ })
	ee.Emit("evt")
	ee.Emit("evt")
	if count != 1 {
		t.Fatalf("count=%d, want 1", count)
	}
}

func TestEmitterOnceDoesNotAffectOthers(t *testing.T) {
	ee := newEventEmitter()
	var got []string
	ee.Once("evt", func(...any) { got = append(got, "once") })
	ee.On("evt", func(...any) { got = append(got, "on") })
	ee.Emit("evt")
	ee.Emit("evt")
	if !slices.Equal(got, []string{"once", "on", "on"}) {
		t.Fatalf("got %v", got)
	}
}

func TestEmitterOffRemovesAllForEvent(t *testing.T) {
	ee := newEventEmitter()
	var got []int
	ee.On("evt", func(...any) { got = append(got, 1) })
	ee.On("evt", func(...any) { got = append(got, 2) })
	ee.Off("evt", nil)
	ee.Emit("evt")
	if len(got) != 0 {
		t.Fatalf("got %v, want empty (Off removes all for the event)", got)
	}
}

func TestEmitterOffNonexistentIsNoop(t *testing.T) {
	ee := newEventEmitter()
	ee.Off("no_such_event", nil) // must not panic
}

func TestEmitterRemoveAllListenersForEvent(t *testing.T) {
	ee := newEventEmitter()
	var a, b []int
	ee.On("a", func(...any) { a = append(a, 1) })
	ee.On("b", func(...any) { b = append(b, 2) })
	ee.RemoveAllListeners("a")
	ee.Emit("a")
	ee.Emit("b")
	if len(a) != 0 || !slices.Equal(b, []int{2}) {
		t.Fatalf("a=%v b=%v", a, b)
	}
}

func TestEmitterRemoveAllListenersAllEvents(t *testing.T) {
	ee := newEventEmitter()
	var got []int
	ee.On("a", func(...any) { got = append(got, 1) })
	ee.On("b", func(...any) { got = append(got, 2) })
	ee.RemoveAllListeners("")
	ee.Emit("a")
	ee.Emit("b")
	if len(got) != 0 {
		t.Fatalf("got %v, want empty", got)
	}
}

func TestEmitterEmitNoListeners(t *testing.T) {
	ee := newEventEmitter()
	ee.Emit("nobody", 1, 2, 3) // must not panic
}
