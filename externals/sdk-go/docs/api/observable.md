# Observable

Lightweight reactive primitives: `Observable`, `Subject`, `BehaviorSubject`, `ReplaySubject`, the `Disposable` subscription handle, and a small set of composable operators (`Map`, `Filter`, `DistinctUntilChanged`, `Pairwise`, …).

!!! note
    The reference below is auto-generated from Go doc comments via [`gomarkdoc`](https://github.com/princjef/gomarkdoc). Re-run `scripts/gen-api-docs.sh` to refresh it.

## func FirstValueFrom

	func FirstValueFrom[T any](source Subscribable[T]) (T, error)

FirstValueFrom subscribes to source and blocks until it emits, returning the first value. It returns ErrNoValue when a Subject completes first. A bare Observable never completes, so such a call blocks until a value arrives.

Example:

	event, err := sdk.FirstValueFrom(api.CoreManager.OnEvent())
	

<a name="Float64"></a>

## type BehaviorSubject

BehaviorSubject is a Subject that remembers the latest value. New subscribers receive the current value immediately, then every following one.

	type BehaviorSubject[T any] struct {
	    // contains filtered or unexported fields
	}

<a name="NewBehaviorSubject"></a>
### func NewBehaviorSubject

	func NewBehaviorSubject[T any](initialValue T) *BehaviorSubject[T]

NewBehaviorSubject returns a BehaviorSubject seeded with initialValue.

<a name="BehaviorSubject[T].AsObservable"></a>
### func \(\*BehaviorSubject\[T\]\) AsObservable

	func (bs *BehaviorSubject[T]) AsObservable() *Observable[T]

AsObservable returns a read\-only view that replays the current value to each new subscriber.

<a name="BehaviorSubject[T].Next"></a>
### func \(\*BehaviorSubject\[T\]\) Next

	func (bs *BehaviorSubject[T]) Next(value T)

Next stores value as the current one and dispatches it to all subscribers.

<a name="BehaviorSubject[T].Subscribe"></a>
### func \(\*BehaviorSubject\[T\]\) Subscribe

	func (bs *BehaviorSubject[T]) Subscribe(callback func(T)) *Disposable

Subscribe registers callback and invokes it once with the current value before any following emission.

<a name="BehaviorSubject[T].Value"></a>
### func \(\*BehaviorSubject\[T\]\) Value

	func (bs *BehaviorSubject[T]) Value() T

Value returns the latest emitted value without subscribing.

<a name="BoundingBox"></a>

## type Disposable

Disposable is the subscription handle returned by Subscribe. Dispose detaches the listener and runs the teardown the producer registered.

	type Disposable struct {
	    // contains filtered or unexported fields
	}

<a name="NewDisposable"></a>
### func NewDisposable

	func NewDisposable(teardown func()) *Disposable

NewDisposable returns a Disposable that runs teardown on the first Dispose.

<a name="Disposable.Dispose"></a>
### func \(\*Disposable\) Dispose

	func (d *Disposable) Dispose()

Dispose detaches the subscription and runs the teardown. Safe from any goroutine; disposing twice is a no\-op.

<a name="Disposable.IsClosed"></a>
### func \(\*Disposable\) IsClosed

	func (d *Disposable) IsClosed() bool

IsClosed reports whether Dispose has already run.

<a name="DoorbellTrigger"></a>

## type Observable

Observable is a cold producer of a push\-based value stream. The producer runs once per Subscribe call, so every subscriber gets its own independent run.

	type Observable[T any] struct {
	    // contains filtered or unexported fields
	}

<a name="DistinctUntilChanged"></a>
### func DistinctUntilChanged

	func DistinctUntilChanged[T comparable](source *Observable[T]) *Observable[T]

DistinctUntilChanged returns an Observable that drops a value when it equals the previous one. Use DistinctUntilChangedFunc for non\-comparable types.

<a name="DistinctUntilChangedFunc"></a>
### func DistinctUntilChangedFunc

	func DistinctUntilChangedFunc[T any](source *Observable[T], equal func(T, T) bool) *Observable[T]

DistinctUntilChangedFunc is DistinctUntilChanged with a caller\-supplied equality check. Return true from equal to suppress the value.

<a name="Filter"></a>
### func Filter

	func Filter[T any](source *Observable[T], predicate func(T) bool) *Observable[T]

Filter returns an Observable that forwards only the values for which predicate reports true.

Example:

	cloud := sdk.Filter(api.CoreManager.OnEvent(), func(e sdk.CoreManagerEvent) bool {
	    return e.Type == "cloudAccountChanged"
	})
	

<a name="Map"></a>
### func Map

	func Map[T any, R any](source *Observable[T], transform func(T) R) *Observable[R]

Map returns an Observable that applies transform to each source value.

Example:

	types := sdk.Map(api.CoreManager.OnEvent(), func(e sdk.CoreManagerEvent) string {
	    return e.Type
	})
	

<a name="MergeMap"></a>
### func MergeMap

	func MergeMap[T any, R any](source *Observable[T], project func(T, int) []R) *Observable[R]

MergeMap projects each source value to a slice and flattens the results into the output stream. project receives the value and its zero\-based index.

<a name="NewObservable"></a>
### func NewObservable

	func NewObservable[T any](subscribeFn func(callback func(T)) *Disposable) *Observable[T]

NewObservable wraps a producer function into an Observable. The function is invoked on every Subscribe and returns the teardown for that subscriber.

<a name="Pairwise"></a>
### func Pairwise

	func Pairwise[T any](source *Observable[T]) *Observable[[2]T]

Pairwise returns an Observable of \[previous, current\] pairs, emitting from the second source value onwards.

<a name="Share"></a>
### func Share

	func Share[T any](source *Observable[T], connector func() *Subject[T]) *Observable[T]

Share multicasts a cold Observable through a Subject so all subscribers share one upstream subscription \(reference\-counted\). Pass a connector to change buffering, or nil for a plain Subject.

Example:

	shared := sdk.Share(source, func() *sdk.Subject[int] {
	    return sdk.NewSubject[int]()
	})
	

<a name="Observable[T].Subscribe"></a>
### func \(\*Observable\[T\]\) Subscribe

	func (o *Observable[T]) Subscribe(callback func(T)) *Disposable

Subscribe starts the producer for this subscriber and routes emitted values to callback. Dispose the returned handle to stop the stream.

Example:

	sub := api.CoreManager.OnEvent().Subscribe(func(e sdk.CoreManagerEvent) {
	    log.Println(e.Type, e.Data)
	})
	defer sub.Dispose()
	

<a name="OccupancySensor"></a>

## type ReplaySubject

ReplaySubject is a Subject that buffers the last bufferSize values and replays them to every new subscriber before live emissions.

	type ReplaySubject[T any] struct {
	    // contains filtered or unexported fields
	}

<a name="NewReplaySubject"></a>
### func NewReplaySubject

	func NewReplaySubject[T any](bufferSize int) *ReplaySubject[T]

NewReplaySubject returns a ReplaySubject keeping at most bufferSize values. A bufferSize of zero buffers nothing, which makes it behave like a Subject.

<a name="ReplaySubject[T].Next"></a>
### func \(\*ReplaySubject\[T\]\) Next

	func (rs *ReplaySubject[T]) Next(value T)

Next appends value to the buffer, dropping the oldest entry once bufferSize is exceeded, then dispatches it. Values after Complete are ignored.

<a name="ReplaySubject[T].Subscribe"></a>
### func \(\*ReplaySubject\[T\]\) Subscribe

	func (rs *ReplaySubject[T]) Subscribe(callback func(T)) *Disposable

Subscribe replays the buffered values in order, then registers callback for live emissions.

<a name="SchemaCondition"></a>

## type Subject

Subject is a multicast value source. Next dispatches to every active subscriber synchronously, Complete releases them all and turns further Next calls into no\-ops.

	type Subject[T any] struct {
	    // contains filtered or unexported fields
	}

<a name="NewSubject"></a>
### func NewSubject

	func NewSubject[T any]() *Subject[T]

NewSubject returns an empty Subject with no subscribers.

<a name="Subject[T].AsObservable"></a>
### func \(\*Subject\[T\]\) AsObservable

	func (s *Subject[T]) AsObservable() *Observable[T]

AsObservable returns a read\-only view that mirrors this Subject without exposing Next or Complete.

Example:

	func (p *MyPlugin) OnEvent() *sdk.Observable[Event] {
	    return p.events.AsObservable()
	}
	

<a name="Subject[T].Complete"></a>
### func \(\*Subject\[T\]\) Complete

	func (s *Subject[T]) Complete()

Complete drops every subscriber and locks the Subject. Later Next calls are ignored and Subscribe returns an already\-closed Disposable.

<a name="Subject[T].Next"></a>
### func \(\*Subject\[T\]\) Next

	func (s *Subject[T]) Next(value T)

Next dispatches value to every current subscriber. Subscriber callbacks run outside the lock, so they may subscribe or dispose from within.

<a name="Subject[T].Subscribe"></a>
### func \(\*Subject\[T\]\) Subscribe

	func (s *Subject[T]) Subscribe(callback func(T)) *Disposable

Subscribe registers callback for every following value. Dispose the returned handle to unregister.

<a name="Subscribable"></a>

## type Subscribable

Subscribable is any source that pushes values into a callback and returns a Disposable to stop the delivery.

	type Subscribable[T any] interface {
	    Subscribe(func(T)) *Disposable
	}

<a name="SwitchControl"></a>
