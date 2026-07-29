package sdk

import (
	"errors"
	"sync"
)

// ErrNoValue is returned by FirstValueFrom when the source completes before it
// emits a value.
var ErrNoValue = errors.New("observable completed without emitting a value")

// Subscribable is any source that pushes values into a callback and returns a
// Disposable to stop the delivery.
type Subscribable[T any] interface {
	Subscribe(func(T)) *Disposable
}

type completionNotifier interface {
	onCompleteNotify(handler func()) *Disposable
}

// Disposable is the subscription handle returned by Subscribe. Dispose detaches
// the listener and runs the teardown the producer registered.
type Disposable struct {
	mu       sync.Mutex
	closed   bool
	teardown func()
}

// NewDisposable returns a Disposable that runs teardown on the first Dispose.
func NewDisposable(teardown func()) *Disposable {
	return &Disposable{teardown: teardown}
}

// Dispose detaches the subscription and runs the teardown. Safe from any
// goroutine; disposing twice is a no-op.
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

// IsClosed reports whether Dispose has already run.
func (d *Disposable) IsClosed() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.closed
}

// Observable is a cold producer of a push-based value stream. The producer runs
// once per Subscribe call, so every subscriber gets its own independent run.
type Observable[T any] struct {
	subscribeFn func(callback func(T)) *Disposable
}

// NewObservable wraps a producer function into an Observable. The function is
// invoked on every Subscribe and returns the teardown for that subscriber.
func NewObservable[T any](subscribeFn func(callback func(T)) *Disposable) *Observable[T] {
	return &Observable[T]{subscribeFn: subscribeFn}
}

// Subscribe starts the producer for this subscriber and routes emitted values
// to callback. Dispose the returned handle to stop the stream.
//
// Example:
//
//	sub := api.CoreManager.OnEvent().Subscribe(func(e sdk.CoreManagerEvent) {
//	    log.Println(e.Type, e.Data)
//	})
//	defer sub.Dispose()
func (o *Observable[T]) Subscribe(callback func(T)) *Disposable {
	return o.subscribeFn(callback)
}

// Subject is a multicast value source. Next dispatches to every active
// subscriber synchronously, Complete releases them all and turns further Next
// calls into no-ops.
type Subject[T any] struct {
	mu               sync.RWMutex
	subscribers      map[*func(T)]struct{}
	completeHandlers map[*func()]struct{}
	completed        bool
}

// NewSubject returns an empty Subject with no subscribers.
func NewSubject[T any]() *Subject[T] {
	return &Subject[T]{
		subscribers:      make(map[*func(T)]struct{}),
		completeHandlers: make(map[*func()]struct{}),
	}
}

// Next dispatches value to every current subscriber. Subscriber callbacks run
// outside the lock, so they may subscribe or dispose from within.
func (s *Subject[T]) Next(value T) {
	s.mu.RLock()
	if s.completed {
		s.mu.RUnlock()
		return
	}
	subs := make([]*func(T), 0, len(s.subscribers))
	for cb := range s.subscribers {
		subs = append(subs, cb)
	}
	s.mu.RUnlock()

	for _, cb := range subs {
		(*cb)(value)
	}
}

// Complete drops every subscriber and locks the Subject. Later Next calls are
// ignored and Subscribe returns an already-closed Disposable.
func (s *Subject[T]) Complete() {
	s.mu.Lock()
	if s.completed {
		s.mu.Unlock()
		return
	}
	s.completed = true
	s.subscribers = make(map[*func(T)]struct{})
	handlers := make([]*func(), 0, len(s.completeHandlers))
	for h := range s.completeHandlers {
		handlers = append(handlers, h)
	}
	s.completeHandlers = make(map[*func()]struct{})
	s.mu.Unlock()

	for _, h := range handlers {
		(*h)()
	}
}

// Subscribe registers callback for every following value. Dispose the returned
// handle to unregister.
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

// AsObservable returns a read-only view that mirrors this Subject without
// exposing Next or Complete.
//
// Example:
//
//	func (p *MyPlugin) OnEvent() *sdk.Observable[Event] {
//	    return p.events.AsObservable()
//	}
func (s *Subject[T]) AsObservable() *Observable[T] {
	return NewObservable(func(callback func(T)) *Disposable {
		return s.Subscribe(callback)
	})
}

// runs the handler immediately when the Subject already completed
func (s *Subject[T]) onCompleteNotify(handler func()) *Disposable {
	s.mu.Lock()
	if s.completed {
		s.mu.Unlock()
		handler()
		return NewDisposable(func() {})
	}
	h := &handler
	s.completeHandlers[h] = struct{}{}
	s.mu.Unlock()

	return NewDisposable(func() {
		s.mu.Lock()
		delete(s.completeHandlers, h)
		s.mu.Unlock()
	})
}

func (s *Subject[T]) isCompleted() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.completed
}

// BehaviorSubject is a Subject that remembers the latest value. New subscribers
// receive the current value immediately, then every following one.
type BehaviorSubject[T any] struct {
	Subject[T]
	mu    sync.RWMutex
	value T
}

// NewBehaviorSubject returns a BehaviorSubject seeded with initialValue.
func NewBehaviorSubject[T any](initialValue T) *BehaviorSubject[T] {
	return &BehaviorSubject[T]{
		Subject: *NewSubject[T](),
		value:   initialValue,
	}
}

// Next stores value as the current one and dispatches it to all subscribers.
func (bs *BehaviorSubject[T]) Next(value T) {
	bs.mu.Lock()
	bs.value = value
	bs.mu.Unlock()
	bs.Subject.Next(value)
}

// Value returns the latest emitted value without subscribing.
func (bs *BehaviorSubject[T]) Value() T {
	bs.mu.RLock()
	defer bs.mu.RUnlock()
	return bs.value
}

// AsObservable returns a read-only view that replays the current value to each
// new subscriber.
func (bs *BehaviorSubject[T]) AsObservable() *Observable[T] {
	return NewObservable(func(callback func(T)) *Disposable {
		return bs.Subscribe(callback)
	})
}

// Subscribe registers callback and invokes it once with the current value
// before any following emission.
func (bs *BehaviorSubject[T]) Subscribe(callback func(T)) *Disposable {
	disposable := bs.Subject.Subscribe(callback)
	if bs.isCompleted() {
		return disposable
	}
	bs.mu.RLock()
	v := bs.value
	bs.mu.RUnlock()
	callback(v)
	return disposable
}

// ReplaySubject is a Subject that buffers the last bufferSize values and
// replays them to every new subscriber before live emissions.
type ReplaySubject[T any] struct {
	Subject[T]
	mu         sync.RWMutex
	buffer     []T
	bufferSize int
}

// NewReplaySubject returns a ReplaySubject keeping at most bufferSize values.
func NewReplaySubject[T any](bufferSize int) *ReplaySubject[T] {
	return &ReplaySubject[T]{
		Subject:    *NewSubject[T](),
		bufferSize: bufferSize,
	}
}

// Next appends value to the buffer, dropping the oldest entry once bufferSize
// is exceeded, then dispatches it.
func (rs *ReplaySubject[T]) Next(value T) {
	rs.mu.Lock()
	rs.buffer = append(rs.buffer, value)
	if len(rs.buffer) > rs.bufferSize {
		rs.buffer = rs.buffer[1:]
	}
	rs.mu.Unlock()
	rs.Subject.Next(value)
}

// Subscribe replays the buffered values in order, then registers callback for
// live emissions.
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

// Filter returns an Observable that forwards only the values for which
// predicate reports true.
//
// Example:
//
//	cloud := sdk.Filter(api.CoreManager.OnEvent(), func(e sdk.CoreManagerEvent) bool {
//	    return e.Type == "cloudAccountChanged"
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

// Map returns an Observable that applies transform to each source value.
//
// Example:
//
//	types := sdk.Map(api.CoreManager.OnEvent(), func(e sdk.CoreManagerEvent) string {
//	    return e.Type
//	})
func Map[T any, R any](source *Observable[T], transform func(T) R) *Observable[R] {
	return NewObservable(func(cb func(R)) *Disposable {
		return source.Subscribe(func(value T) {
			cb(transform(value))
		})
	})
}

// DistinctUntilChanged returns an Observable that drops a value when it equals
// the previous one. Use DistinctUntilChangedFunc for non-comparable types.
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

// DistinctUntilChangedFunc is DistinctUntilChanged with a caller-supplied
// equality check. Return true from equal to suppress the value.
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

// Pairwise returns an Observable of [previous, current] pairs, emitting from
// the second source value onwards.
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

// MergeMap projects each source value to a slice and flattens the results into
// the output stream. project receives the value and its zero-based index.
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

// Share multicasts a cold Observable through a Subject so all subscribers share
// one upstream subscription (reference-counted). Pass a connector to change
// buffering, or nil for a plain Subject.
//
// Example:
//
//	shared := sdk.Share(source, func() *sdk.Subject[int] {
//	    return sdk.NewSubject[int]()
//	})
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

// FirstValueFrom subscribes to source and blocks until it emits, returning the
// first value. It returns ErrNoValue when a Subject completes first. A bare
// Observable never completes, so such a call blocks until a value arrives.
//
// Example:
//
//	event, err := sdk.FirstValueFrom(api.CoreManager.OnEvent())
func FirstValueFrom[T any](source Subscribable[T]) (T, error) {
	ch := make(chan T, 1)
	done := make(chan struct{})

	sub := source.Subscribe(func(v T) {
		select {
		case ch <- v:
		default:
		}
	})
	defer sub.Dispose()

	if cn, ok := source.(completionNotifier); ok {
		cd := cn.onCompleteNotify(func() { close(done) })
		defer cd.Dispose()
	}

	select {
	case v := <-ch:
		return v, nil
	case <-done:
		var zero T
		return zero, ErrNoValue
	}
}
