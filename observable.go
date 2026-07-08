package sdk

import (
	"errors"
	"sync"
)

type Disposable struct {
	mu       sync.Mutex
	closed   bool
	teardown func()
}

func NewDisposable(teardown func()) *Disposable {
	return &Disposable{teardown: teardown}
}

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

func (d *Disposable) IsClosed() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.closed
}

type Observable[T any] struct {
	subscribeFn func(callback func(T)) *Disposable
}

func NewObservable[T any](subscribeFn func(callback func(T)) *Disposable) *Observable[T] {
	return &Observable[T]{subscribeFn: subscribeFn}
}

func (o *Observable[T]) Subscribe(callback func(T)) *Disposable {
	return o.subscribeFn(callback)
}

type Subject[T any] struct {
	mu               sync.RWMutex
	subscribers      map[*func(T)]struct{}
	completeHandlers map[*func()]struct{}
	completed        bool
}

func NewSubject[T any]() *Subject[T] {
	return &Subject[T]{
		subscribers:      make(map[*func(T)]struct{}),
		completeHandlers: make(map[*func()]struct{}),
	}
}

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

func (s *Subject[T]) isCompleted() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.completed
}

func (s *Subject[T]) AsObservable() *Observable[T] {
	return NewObservable(func(callback func(T)) *Disposable {
		return s.Subscribe(callback)
	})
}

type BehaviorSubject[T any] struct {
	Subject[T]
	mu    sync.RWMutex
	value T
}

func NewBehaviorSubject[T any](initialValue T) *BehaviorSubject[T] {
	return &BehaviorSubject[T]{
		Subject: *NewSubject[T](),
		value:   initialValue,
	}
}

func (bs *BehaviorSubject[T]) Next(value T) {
	bs.mu.Lock()
	bs.value = value
	bs.mu.Unlock()
	bs.Subject.Next(value)
}

func (bs *BehaviorSubject[T]) Value() T {
	bs.mu.RLock()
	defer bs.mu.RUnlock()
	return bs.value
}

func (bs *BehaviorSubject[T]) AsObservable() *Observable[T] {
	return NewObservable(func(callback func(T)) *Disposable {
		return bs.Subscribe(callback)
	})
}

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

type ReplaySubject[T any] struct {
	Subject[T]
	mu         sync.RWMutex
	buffer     []T
	bufferSize int
}

func NewReplaySubject[T any](bufferSize int) *ReplaySubject[T] {
	return &ReplaySubject[T]{
		Subject:    *NewSubject[T](),
		bufferSize: bufferSize,
	}
}

func (rs *ReplaySubject[T]) Next(value T) {
	rs.mu.Lock()
	rs.buffer = append(rs.buffer, value)
	if len(rs.buffer) > rs.bufferSize {
		rs.buffer = rs.buffer[1:]
	}
	rs.mu.Unlock()
	rs.Subject.Next(value)
}

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

func Filter[T any](source *Observable[T], predicate func(T) bool) *Observable[T] {
	return NewObservable(func(cb func(T)) *Disposable {
		return source.Subscribe(func(value T) {
			if predicate(value) {
				cb(value)
			}
		})
	})
}

func Map[T any, R any](source *Observable[T], transform func(T) R) *Observable[R] {
	return NewObservable(func(cb func(R)) *Disposable {
		return source.Subscribe(func(value T) {
			cb(transform(value))
		})
	})
}

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

var ErrNoValue = errors.New("observable completed without emitting a value")

type Subscribable[T any] interface {
	Subscribe(func(T)) *Disposable
}

type completionNotifier interface {
	onCompleteNotify(handler func()) *Disposable
}

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
