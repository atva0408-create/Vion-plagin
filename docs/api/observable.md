# Observable

Lightweight reactive primitives: `Observable`, `Subject`, `BehaviorSubject`, `ReplaySubject`, the `Disposable` subscription handle, and a small set of composable operators (`Map`, `Filter`, `DistinctUntilChanged`, `Pairwise`, …).

!!! note
    The reference below is auto-generated from Go doc comments via [`gomarkdoc`](https://github.com/princjef/gomarkdoc). Re-run `scripts/gen-api-docs.sh` to refresh it.

## func FirstValueFrom

	func FirstValueFrom[T any](source Subscribable[T]) (T, error)



<a name="Float64"></a>

## type BehaviorSubject



	type BehaviorSubject[T any] struct {
	    // contains filtered or unexported fields
	}

<a name="NewBehaviorSubject"></a>
### func NewBehaviorSubject

	func NewBehaviorSubject[T any](initialValue T) *BehaviorSubject[T]



<a name="BehaviorSubject[T].AsObservable"></a>
### func \(\*BehaviorSubject\[T\]\) AsObservable

	func (bs *BehaviorSubject[T]) AsObservable() *Observable[T]



<a name="BehaviorSubject[T].Next"></a>
### func \(\*BehaviorSubject\[T\]\) Next

	func (bs *BehaviorSubject[T]) Next(value T)



<a name="BehaviorSubject[T].Subscribe"></a>
### func \(\*BehaviorSubject\[T\]\) Subscribe

	func (bs *BehaviorSubject[T]) Subscribe(callback func(T)) *Disposable



<a name="BehaviorSubject[T].Value"></a>
### func \(\*BehaviorSubject\[T\]\) Value

	func (bs *BehaviorSubject[T]) Value() T



<a name="BoundingBox"></a>

## type Disposable



	type Disposable struct {
	    // contains filtered or unexported fields
	}

<a name="NewDisposable"></a>
### func NewDisposable

	func NewDisposable(teardown func()) *Disposable



<a name="Disposable.Dispose"></a>
### func \(\*Disposable\) Dispose

	func (d *Disposable) Dispose()



<a name="Disposable.IsClosed"></a>
### func \(\*Disposable\) IsClosed

	func (d *Disposable) IsClosed() bool



<a name="DoorbellTrigger"></a>

## type Observable



	type Observable[T any] struct {
	    // contains filtered or unexported fields
	}

<a name="DistinctUntilChanged"></a>
### func DistinctUntilChanged

	func DistinctUntilChanged[T comparable](source *Observable[T]) *Observable[T]



<a name="DistinctUntilChangedFunc"></a>
### func DistinctUntilChangedFunc

	func DistinctUntilChangedFunc[T any](source *Observable[T], equal func(T, T) bool) *Observable[T]



<a name="Filter"></a>
### func Filter

	func Filter[T any](source *Observable[T], predicate func(T) bool) *Observable[T]



<a name="Map"></a>
### func Map

	func Map[T any, R any](source *Observable[T], transform func(T) R) *Observable[R]



<a name="MergeMap"></a>
### func MergeMap

	func MergeMap[T any, R any](source *Observable[T], project func(T, int) []R) *Observable[R]



<a name="NewObservable"></a>
### func NewObservable

	func NewObservable[T any](subscribeFn func(callback func(T)) *Disposable) *Observable[T]



<a name="Pairwise"></a>
### func Pairwise

	func Pairwise[T any](source *Observable[T]) *Observable[[2]T]



<a name="Share"></a>
### func Share

	func Share[T any](source *Observable[T], connector func() *Subject[T]) *Observable[T]



<a name="Observable[T].Subscribe"></a>
### func \(\*Observable\[T\]\) Subscribe

	func (o *Observable[T]) Subscribe(callback func(T)) *Disposable



<a name="OccupancySensor"></a>

## type ReplaySubject



	type ReplaySubject[T any] struct {
	    // contains filtered or unexported fields
	}

<a name="NewReplaySubject"></a>
### func NewReplaySubject

	func NewReplaySubject[T any](bufferSize int) *ReplaySubject[T]



<a name="ReplaySubject[T].Next"></a>
### func \(\*ReplaySubject\[T\]\) Next

	func (rs *ReplaySubject[T]) Next(value T)



<a name="ReplaySubject[T].Subscribe"></a>
### func \(\*ReplaySubject\[T\]\) Subscribe

	func (rs *ReplaySubject[T]) Subscribe(callback func(T)) *Disposable



<a name="SchemaCondition"></a>

## type Subject



	type Subject[T any] struct {
	    // contains filtered or unexported fields
	}

<a name="NewSubject"></a>
### func NewSubject

	func NewSubject[T any]() *Subject[T]



<a name="Subject[T].AsObservable"></a>
### func \(\*Subject\[T\]\) AsObservable

	func (s *Subject[T]) AsObservable() *Observable[T]



<a name="Subject[T].Complete"></a>
### func \(\*Subject\[T\]\) Complete

	func (s *Subject[T]) Complete()



<a name="Subject[T].Next"></a>
### func \(\*Subject\[T\]\) Next

	func (s *Subject[T]) Next(value T)



<a name="Subject[T].Subscribe"></a>
### func \(\*Subject\[T\]\) Subscribe

	func (s *Subject[T]) Subscribe(callback func(T)) *Disposable



<a name="Subscribable"></a>

## type Subscribable



	type Subscribable[T any] interface {
	    Subscribe(func(T)) *Disposable
	}

<a name="SwitchControl"></a>
