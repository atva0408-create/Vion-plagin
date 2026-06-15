package sdk

// Lightweight reactive primitives for camera.ui.
//
// Provides cold Observables, multicast Subjects (Subject,
// BehaviorSubject, ReplaySubject) and a small set of composable
// operators for building property-change notifications and event
// streams throughout the SDK.

import (
	"errors"
	"sync"
)

// Disposable is the subscription handle returned by Subscribe.
// Call Dispose to detach the listener and run any teardown logic
// registered by the producer. Disposing twice is a no-op.
type Disposable struct {
	mu       sync.Mutex
	closed   bool
	teardown func()
}

// NewDisposable creates a new Disposable.
func NewDisposable(teardown func()) *Disposable {
	return &Disposable{teardown: teardown}
}

// Dispose unsubscribes and cleans up.
func (d *Disposable) Dispose() {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed {
		return
	}
	d.closed = true
	if d.teardown != nil {
		d.teardown()
	}
}

// IsClosed returns whether this disposable has been disposed.
func (d *Disposable) IsClosed() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.closed
}

// Observable is a cold producer of a push-based value stream.
// The subscribeFn passed to NewObservable is executed once per
// Subscribe call, so each subscriber gets its own independent run.
// Subscribe returns a Disposable that stops the stream and triggers
// any teardown registered by the producer.
type Observable[T any] struct {
	subscribeFn func(callback func(T)) *Disposable
}

// NewObservable creates a new Observable with the given subscribe function.
func NewObservable[T any](subscribeFn func(callback func(T)) *Disposable) *Observable[T] {
	return &Observable[T]{subscribeFn: subscribeFn}
}

// Subscribe starts the producer for this subscriber and routes emitted
// values to callback. Returns a Disposable for stopping the stream.
func (o *Observable[T]) Subscribe(callback func(T)) *Disposable {
	return o.subscribeFn(callback)
}

// Subject is a multicast value source.
// Calls to Next are dispatched to every active subscriber. Complete
// releases all subscribers and locks the Subject so further Next calls
// become no-ops. Subscribe returns a Disposable for individual cleanup.
type Subject[T any] struct {
	mu          sync.RWMutex
	subscribers map[*func(T)]struct{}
	completed   bool
}

// NewSubject creates a new Subject.
func NewSubject[T any]() *Subject[T] {
	return &Subject[T]{
		subscribers: make(map[*func(T)]struct{}),
	}
}

// Next emits a value to all subscribers.
func (s *Subject[T]) Next(value T) {
	s.mu.RLock()
	if s.completed {
		s.mu.RUnlock()
		return
	}
	// Copy subscribers for safe iteration
	subs := make([]*func(T), 0, len(s.subscribers))
	for cb := range s.subscribers {
		subs = append(subs, cb)
	}
	s.mu.RUnlock()

	for _, cb := range subs {
		(*cb)(value)
	}
}

// Complete marks the subject as complete.
func (s *Subject[T]) Complete() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.completed = true
	s.subscribers = make(map[*func(T)]struct{})
}

// Subscribe registers a callback.
func (s *Subject[T]) Subscribe(callback func(T)) *Disposable {
	s.mu.Lock()
	if s.completed {
		s.mu.Unlock()
		return NewDisposable(func() {})
	}
	cb := &callback
	s.subscribers[cb] = struct{}{}
	s.mu.Unlock()

	return NewDisposable(func() {
		s.mu.Lock()
		delete(s.subscribers, cb)
		s.mu.Unlock()
	})
}

// AsObservable returns a read-only Observable that mirrors this Subject
// without exposing Next or Complete.
func (s *Subject[T]) AsObservable() *Observable[T] {
	return NewObservable(func(callback func(T)) *Disposable {
		return s.Subscribe(callback)
	})
}

// BehaviorSubject is a Subject seeded with an initial value that always
// remembers the latest emission. New subscribers receive the current
// value immediately on Subscribe and then all subsequent values. The
// current value is also accessible synchronously via Value.
type BehaviorSubject[T any] struct {
	Subject[T]
	mu    sync.RWMutex
	value T
}

// NewBehaviorSubject creates a new BehaviorSubject with an initial value.
func NewBehaviorSubject[T any](initialValue T) *BehaviorSubject[T] {
	return &BehaviorSubject[T]{
		Subject: *NewSubject[T](),
		value:   initialValue,
	}
}

// Next sets the value and notifies subscribers.
func (bs *BehaviorSubject[T]) Next(value T) {
	bs.mu.Lock()
	bs.value = value
	bs.mu.Unlock()
	bs.Subject.Next(value)
}

// Value returns the current value.
func (bs *BehaviorSubject[T]) Value() T {
	bs.mu.RLock()
	defer bs.mu.RUnlock()
	return bs.value
}

// AsObservable returns an Observable that replays the current value to new subscribers.
func (bs *BehaviorSubject[T]) AsObservable() *Observable[T] {
	return NewObservable(func(callback func(T)) *Disposable {
		return bs.Subscribe(callback)
	})
}

// Subscribe registers a callback and immediately invokes it with the current value.
func (bs *BehaviorSubject[T]) Subscribe(callback func(T)) *Disposable {
	disposable := bs.Subject.Subscribe(callback)
	bs.mu.RLock()
	v := bs.value
	bs.mu.RUnlock()
	callback(v)
	return disposable
}

// ReplaySubject is a Subject that buffers up to the last bufferSize
// values. New subscribers immediately receive every buffered value in
// order before continuing with live emissions.
type ReplaySubject[T any] struct {
	Subject[T]
	mu         sync.RWMutex
	buffer     []T
	bufferSize int
}

// NewReplaySubject creates a new ReplaySubject with the given buffer size.
func NewReplaySubject[T any](bufferSize int) *ReplaySubject[T] {
	return &ReplaySubject[T]{
		Subject:    *NewSubject[T](),
		bufferSize: bufferSize,
	}
}

// Next buffers the value and emits to all subscribers.
func (rs *ReplaySubject[T]) Next(value T) {
	rs.mu.Lock()
	rs.buffer = append(rs.buffer, value)
	if len(rs.buffer) > rs.bufferSize {
		rs.buffer = rs.buffer[1:]
	}
	rs.mu.Unlock()
	rs.Subject.Next(value)
}

// Subscribe replays buffered values first, then subscribes to live values.
func (rs *ReplaySubject[T]) Subscribe(callback func(T)) *Disposable {
	rs.mu.RLock()
	buf := make([]T, len(rs.buffer))
	copy(buf, rs.buffer)
	rs.mu.RUnlock()

	for _, v := range buf {
		callback(v)
	}
	return rs.Subject.Subscribe(callback)
}

// ── Operators ────────────────────────────────────────────────────────

// Filter emits only the values for which predicate returns true.
//
// Example:
//
//	detected := Filter(sensor.OnPropertyChanged(), func(e PropertyChange) bool {
//	    return e.Property == "detected"
//	})
func Filter[T any](source *Observable[T], predicate func(T) bool) *Observable[T] {
	return NewObservable(func(cb func(T)) *Disposable {
		return source.Subscribe(func(value T) {
			if predicate(value) {
				cb(value)
			}
		})
	})
}

// Map applies transform to each emitted value and emits the result.
//
// Example:
//
//	values := Map(sensor.OnPropertyChanged(), func(e PropertyChange) any {
//	    return e.Value
//	})
func Map[T any, R any](source *Observable[T], transform func(T) R) *Observable[R] {
	return NewObservable(func(cb func(R)) *Disposable {
		return source.Subscribe(func(value T) {
			cb(transform(value))
		})
	})
}

// DistinctUntilChanged emits a value only when it differs from the
// previous one (uses == for comparable types). For custom equality use
// DistinctUntilChangedFunc.
//
// Example:
//
//	stream := DistinctUntilChanged(source)
func DistinctUntilChanged[T comparable](source *Observable[T]) *Observable[T] {
	return NewObservable(func(cb func(T)) *Disposable {
		var hasValue bool
		var lastValue T
		return source.Subscribe(func(value T) {
			if !hasValue || lastValue != value {
				hasValue = true
				lastValue = value
				cb(value)
			}
		})
	})
}

// DistinctUntilChangedFunc emits a value only when it differs from the
// previous one according to the supplied equality function.
func DistinctUntilChangedFunc[T any](source *Observable[T], equal func(T, T) bool) *Observable[T] {
	return NewObservable(func(cb func(T)) *Disposable {
		var hasValue bool
		var lastValue T
		return source.Subscribe(func(value T) {
			if !hasValue || !equal(lastValue, value) {
				hasValue = true
				lastValue = value
				cb(value)
			}
		})
	})
}

// Pairwise emits [previous, current] pairs (as [2]T arrays) for every
// value after the first.
//
// Example:
//
//	pairs := Pairwise(source)
//	pairs.Subscribe(func(p [2]int) { fmt.Println(p[0], p[1]) })
func Pairwise[T any](source *Observable[T]) *Observable[[2]T] {
	return NewObservable(func(cb func([2]T)) *Disposable {
		var hasValue bool
		var prev T
		return source.Subscribe(func(value T) {
			if hasValue {
				cb([2]T{prev, value})
			}
			hasValue = true
			prev = value
		})
	})
}

// MergeMap projects each source value to a slice and flattens the
// results into the output stream.
//
// Example:
//
//	stream := MergeMap(source, func(v int, i int) []int { return []int{v, v * 2} })
func MergeMap[T any, R any](source *Observable[T], project func(T, int) []R) *Observable[R] {
	return NewObservable(func(cb func(R)) *Disposable {
		index := 0
		return source.Subscribe(func(value T) {
			results := project(value, index)
			index++
			for _, r := range results {
				cb(r)
			}
		})
	})
}

// Share multicasts a cold Observable through a Subject, sharing a
// single upstream subscription among all subscribers (reference-counted).
// Supply a custom connector (e.g. NewReplaySubject[T](1)) to change
// buffering.
//
// Example:
//
//	events := Share(source, func() *Subject[int] { return NewReplaySubject[int](1).Subject })
//	events.Subscribe(func(v int) { fmt.Println("a", v) })
//	events.Subscribe(func(v int) { fmt.Println("b", v) })
func Share[T any](source *Observable[T], connector func() *Subject[T]) *Observable[T] {
	var mu sync.Mutex
	var subject *Subject[T]
	var sourceDisposable *Disposable
	refCount := 0

	return NewObservable(func(cb func(T)) *Disposable {
		mu.Lock()
		if subject == nil {
			if connector != nil {
				subject = connector()
			} else {
				subject = NewSubject[T]()
			}
			s := subject
			sourceDisposable = source.Subscribe(func(v T) {
				s.Next(v)
			})
		}
		refCount++
		sub := subject.Subscribe(cb)
		mu.Unlock()

		return NewDisposable(func() {
			sub.Dispose()
			mu.Lock()
			defer mu.Unlock()
			refCount--
			if refCount == 0 {
				if sourceDisposable != nil {
					sourceDisposable.Dispose()
					sourceDisposable = nil
				}
				subject = nil
			}
		})
	})
}

// ── Utilities ────────────────────────────────────────────────────────

// ErrNoValue is returned by FirstValueFrom when the source completes without emitting.
var ErrNoValue = errors.New("observable completed without emitting a value")

// Subscribable is the interface accepted by FirstValueFrom.
type Subscribable[T any] interface {
	Subscribe(func(T)) *Disposable
}

// FirstValueFrom subscribes to the source, blocks until it emits its
// first value, returns that value, and then disposes the subscription.
// Returns ErrNoValue if the source completes without emitting.
//
// Example:
//
//	value, err := FirstValueFrom(behaviorSubject)
func FirstValueFrom[T any](source Subscribable[T]) (T, error) {
	ch := make(chan T, 1)
	sub := source.Subscribe(func(v T) {
		select {
		case ch <- v:
		default:
		}
	})
	defer sub.Dispose()

	select {
	case v := <-ch:
		return v, nil
	default:
		// For BehaviorSubject/ReplaySubject the value is delivered synchronously
		// before Subscribe returns, so check the channel again
	}

	v, ok := <-ch
	if !ok {
		var zero T
		return zero, ErrNoValue
	}
	return v, nil
}
