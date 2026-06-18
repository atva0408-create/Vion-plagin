# Observable

Lightweight reactive primitives: `Observable`, `Subject`, `BehaviorSubject`, `ReplaySubject`, the `Disposable` subscription handle, and a small set of composable operators (`Map`, `Filter`, `DistinctUntilChanged`, `Pairwise`, …).

!!! note
    The reference below is auto-generated from Go doc comments via [`gomarkdoc`](https://github.com/princjef/gomarkdoc). Re-run `scripts/gen-api-docs.sh` to refresh it.

## func FirstValueFrom

	func FirstValueFrom[T any](source Subscribable[T]) (T, error)

FirstValueFrom subscribes to the source, blocks until it emits its first value, returns that value, and then disposes the subscription.

Returns ErrNoValue if the source completes before emitting \(for sources that signal completion — Subject, BehaviorSubject, ReplaySubject\). A bare Observable has no completion signal, so FirstValueFrom blocks until it emits.

Example:

	value, err := FirstValueFrom(behaviorSubject)
	

<a name="Float64"></a>

## type BehaviorSubject

BehaviorSubject is a Subject seeded with an initial value that always remembers the latest emission. New subscribers receive the current value immediately on Subscribe and then all subsequent values. The current value is also accessible synchronously via Value.

	type BehaviorSubject[T any] struct {
	    // contains filtered or unexported fields
	}

<a name="NewBehaviorSubject"></a>
### func NewBehaviorSubject

	func NewBehaviorSubject[T any](initialValue T) *BehaviorSubject[T]

NewBehaviorSubject creates a new BehaviorSubject with an initial value.

<a name="BehaviorSubject[T].AsObservable"></a>
### func \(\*BehaviorSubject\[T\]\) AsObservable

	func (bs *BehaviorSubject[T]) AsObservable() *Observable[T]

AsObservable returns an Observable that replays the current value to new subscribers.

<a name="BehaviorSubject[T].Next"></a>
### func \(\*BehaviorSubject\[T\]\) Next

	func (bs *BehaviorSubject[T]) Next(value T)

Next sets the value and notifies subscribers.

<a name="BehaviorSubject[T].Subscribe"></a>
### func \(\*BehaviorSubject\[T\]\) Subscribe

	func (bs *BehaviorSubject[T]) Subscribe(callback func(T)) *Disposable

Subscribe registers a callback and immediately invokes it with the current value.

<a name="BehaviorSubject[T].Value"></a>
### func \(\*BehaviorSubject\[T\]\) Value

	func (bs *BehaviorSubject[T]) Value() T

Value returns the current value.

<a name="BoundingBox"></a>

## type Disposable

Disposable is the subscription handle returned by Subscribe. Call Dispose to detach the listener and run any teardown logic registered by the producer. Disposing twice is a no\-op.

	type Disposable struct {
	    // contains filtered or unexported fields
	}

<a name="NewDisposable"></a>
### func NewDisposable

	func NewDisposable(teardown func()) *Disposable

NewDisposable creates a new Disposable.

<a name="Disposable.Dispose"></a>
### func \(\*Disposable\) Dispose

	func (d *Disposable) Dispose()

Dispose unsubscribes and cleans up.

<a name="Disposable.IsClosed"></a>
### func \(\*Disposable\) IsClosed

	func (d *Disposable) IsClosed() bool

IsClosed returns whether this disposable has been disposed.

<a name="DoorbellTrigger"></a>

## type Observable

Observable is a cold producer of a push\-based value stream. The subscribeFn passed to NewObservable is executed once per Subscribe call, so each subscriber gets its own independent run. Subscribe returns a Disposable that stops the stream and triggers any teardown registered by the producer.

	type Observable[T any] struct {
	    // contains filtered or unexported fields
	}

<a name="DistinctUntilChanged"></a>
### func DistinctUntilChanged

	func DistinctUntilChanged[T comparable](source *Observable[T]) *Observable[T]

DistinctUntilChanged emits a value only when it differs from the previous one \(uses == for comparable types\). For custom equality use DistinctUntilChangedFunc.

Example:

	stream := DistinctUntilChanged(source)
	

<a name="DistinctUntilChangedFunc"></a>
### func DistinctUntilChangedFunc

	func DistinctUntilChangedFunc[T any](source *Observable[T], equal func(T, T) bool) *Observable[T]

DistinctUntilChangedFunc emits a value only when it differs from the previous one according to the supplied equality function.

<a name="Filter"></a>
### func Filter

	func Filter[T any](source *Observable[T], predicate func(T) bool) *Observable[T]

Filter emits only the values for which predicate returns true.

Example:

	detected := Filter(sensor.OnPropertyChanged(), func(e PropertyChange) bool {
	    return e.Property == "detected"
	})
	

<a name="Map"></a>
### func Map

	func Map[T any, R any](source *Observable[T], transform func(T) R) *Observable[R]

Map applies transform to each emitted value and emits the result.

Example:

	values := Map(sensor.OnPropertyChanged(), func(e PropertyChange) any {
	    return e.Value
	})
	

<a name="MergeMap"></a>
### func MergeMap

	func MergeMap[T any, R any](source *Observable[T], project func(T, int) []R) *Observable[R]

MergeMap projects each source value to a slice and flattens the results into the output stream.

Example:

	stream := MergeMap(source, func(v int, i int) []int { return []int{v, v * 2} })
	

<a name="NewObservable"></a>
### func NewObservable

	func NewObservable[T any](subscribeFn func(callback func(T)) *Disposable) *Observable[T]

NewObservable creates a new Observable with the given subscribe function.

<a name="Pairwise"></a>
### func Pairwise

	func Pairwise[T any](source *Observable[T]) *Observable[[2]T]

Pairwise emits \[previous, current\] pairs \(as \[2\]T arrays\) for every value after the first.

Example:

	pairs := Pairwise(source)
	pairs.Subscribe(func(p [2]int) { fmt.Println(p[0], p[1]) })
	

<a name="Share"></a>
### func Share

	func Share[T any](source *Observable[T], connector func() *Subject[T]) *Observable[T]

Share multicasts a cold Observable through a Subject, sharing a single upstream subscription among all subscribers \(reference\-counted\). Supply a custom connector \(e.g. NewReplaySubject\[T\]\(1\)\) to change buffering.

Example:

	events := Share(source, func() *Subject[int] { return NewReplaySubject[int](1).Subject })
	events.Subscribe(func(v int) { fmt.Println("a", v) })
	events.Subscribe(func(v int) { fmt.Println("b", v) })
	

<a name="Observable[T].Subscribe"></a>
### func \(\*Observable\[T\]\) Subscribe

	func (o *Observable[T]) Subscribe(callback func(T)) *Disposable

Subscribe starts the producer for this subscriber and routes emitted values to callback. Returns a Disposable for stopping the stream.

<a name="OccupancySensor"></a>

## type ReplaySubject

ReplaySubject is a Subject that buffers up to the last bufferSize values. New subscribers immediately receive every buffered value in order before continuing with live emissions.

	type ReplaySubject[T any] struct {
	    // contains filtered or unexported fields
	}

<a name="NewReplaySubject"></a>
### func NewReplaySubject

	func NewReplaySubject[T any](bufferSize int) *ReplaySubject[T]

NewReplaySubject creates a new ReplaySubject with the given buffer size.

<a name="ReplaySubject[T].Next"></a>
### func \(\*ReplaySubject\[T\]\) Next

	func (rs *ReplaySubject[T]) Next(value T)

Next buffers the value and emits to all subscribers.

<a name="ReplaySubject[T].Subscribe"></a>
### func \(\*ReplaySubject\[T\]\) Subscribe

	func (rs *ReplaySubject[T]) Subscribe(callback func(T)) *Disposable

Subscribe replays buffered values first, then subscribes to live values.

<a name="SchemaCondition"></a>

## type Subject

Subject is a multicast value source. Calls to Next are dispatched to every active subscriber. Complete releases all subscribers and locks the Subject so further Next calls become no\-ops. Subscribe returns a Disposable for individual cleanup.

	type Subject[T any] struct {
	    // contains filtered or unexported fields
	}

<a name="NewSubject"></a>
### func NewSubject

	func NewSubject[T any]() *Subject[T]

NewSubject creates a new Subject.

<a name="Subject[T].AsObservable"></a>
### func \(\*Subject\[T\]\) AsObservable

	func (s *Subject[T]) AsObservable() *Observable[T]

AsObservable returns a read\-only Observable that mirrors this Subject without exposing Next or Complete.

<a name="Subject[T].Complete"></a>
### func \(\*Subject\[T\]\) Complete

	func (s *Subject[T]) Complete()

Complete marks the subject as complete, releases all value subscribers, and notifies any completion handlers registered via onCompleteNotify.

<a name="Subject[T].Next"></a>
### func \(\*Subject\[T\]\) Next

	func (s *Subject[T]) Next(value T)

Next emits a value to all subscribers.

<a name="Subject[T].Subscribe"></a>
### func \(\*Subject\[T\]\) Subscribe

	func (s *Subject[T]) Subscribe(callback func(T)) *Disposable

Subscribe registers a callback.

<a name="Subscribable"></a>

## type Subscribable

Subscribable is the interface accepted by FirstValueFrom.

	type Subscribable[T any] interface {
	    Subscribe(func(T)) *Disposable
	}

<a name="SwitchControl"></a>
