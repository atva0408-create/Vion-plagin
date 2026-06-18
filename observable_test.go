package sdk

import (
	"slices"
	"testing"
	"time"
)

func TestDisposableTeardownOnce(t *testing.T) {
	count := 0
	d := NewDisposable(func() { count++ })
	if d.IsClosed() {
		t.Fatal("new disposable should not be closed")
	}
	d.Dispose()
	if !d.IsClosed() {
		t.Fatal("disposable should be closed after Dispose")
	}
	d.Dispose() // idempotent
	if count != 1 {
		t.Fatalf("teardown ran %d times, want 1", count)
	}
}

func TestSubjectEmitsValues(t *testing.T) {
	s := NewSubject[int]()
	var got []int
	s.Subscribe(func(v int) { got = append(got, v) })
	s.Next(1)
	s.Next(2)
	s.Next(3)
	if !slices.Equal(got, []int{1, 2, 3}) {
		t.Fatalf("got %v", got)
	}
}

func TestSubjectMultipleSubscribers(t *testing.T) {
	s := NewSubject[int]()
	var a, b []int
	s.Subscribe(func(v int) { a = append(a, v) })
	s.Subscribe(func(v int) { b = append(b, v) })
	s.Next(42)
	if !slices.Equal(a, []int{42}) || !slices.Equal(b, []int{42}) {
		t.Fatalf("a=%v b=%v", a, b)
	}
}

func TestSubjectStopsAfterComplete(t *testing.T) {
	s := NewSubject[int]()
	var got []int
	s.Subscribe(func(v int) { got = append(got, v) })
	s.Next(1)
	s.Complete()
	s.Next(2)
	if !slices.Equal(got, []int{1}) {
		t.Fatalf("got %v", got)
	}
}

func TestSubjectDisposeRemovesSubscriber(t *testing.T) {
	s := NewSubject[int]()
	var got []int
	sub := s.Subscribe(func(v int) { got = append(got, v) })
	s.Next(1)
	sub.Dispose()
	s.Next(2)
	if !slices.Equal(got, []int{1}) {
		t.Fatalf("got %v", got)
	}
}

func TestSubjectSubscribeToCompleted(t *testing.T) {
	s := NewSubject[int]()
	s.Complete()
	var got []int
	s.Subscribe(func(v int) { got = append(got, v) })
	s.Next(1)
	if len(got) != 0 {
		t.Fatalf("got %v, want empty", got)
	}
}

func TestSubjectAsObservable(t *testing.T) {
	s := NewSubject[int]()
	obs := s.AsObservable()
	var got []int
	obs.Subscribe(func(v int) { got = append(got, v) })
	s.Next(10)
	if !slices.Equal(got, []int{10}) {
		t.Fatalf("got %v", got)
	}
}

func TestBehaviorSubjectEmitsCurrentOnSubscribe(t *testing.T) {
	s := NewBehaviorSubject(42)
	var got []int
	s.Subscribe(func(v int) { got = append(got, v) })
	if !slices.Equal(got, []int{42}) {
		t.Fatalf("got %v", got)
	}
}

func TestBehaviorSubjectValue(t *testing.T) {
	s := NewBehaviorSubject("hello")
	if s.Value() != "hello" {
		t.Fatalf("value=%q", s.Value())
	}
	s.Next("world")
	if s.Value() != "world" {
		t.Fatalf("value=%q", s.Value())
	}
}

func TestBehaviorSubjectInitialAndSubsequent(t *testing.T) {
	s := NewBehaviorSubject(0)
	var got []int
	s.Subscribe(func(v int) { got = append(got, v) })
	s.Next(1)
	s.Next(2)
	if !slices.Equal(got, []int{0, 1, 2}) {
		t.Fatalf("got %v", got)
	}
}

func TestBehaviorSubjectLateSubscriberGetsLatest(t *testing.T) {
	s := NewBehaviorSubject(0)
	s.Next(1)
	s.Next(2)
	var got []int
	s.Subscribe(func(v int) { got = append(got, v) })
	if !slices.Equal(got, []int{2}) {
		t.Fatalf("got %v", got)
	}
}

func TestReplaySubjectReplaysBuffered(t *testing.T) {
	s := NewReplaySubject[int](2)
	s.Next(1)
	s.Next(2)
	s.Next(3)
	var got []int
	s.Subscribe(func(v int) { got = append(got, v) })
	if !slices.Equal(got, []int{2, 3}) {
		t.Fatalf("got %v", got)
	}
}

func TestReplaySubjectReplayPlusLive(t *testing.T) {
	s := NewReplaySubject[int](1)
	s.Next(1)
	var got []int
	s.Subscribe(func(v int) { got = append(got, v) })
	s.Next(2)
	if !slices.Equal(got, []int{1, 2}) {
		t.Fatalf("got %v", got)
	}
}

func TestReplaySubjectLargeBuffer(t *testing.T) {
	s := NewReplaySubject[int](100)
	s.Next(1)
	s.Next(2)
	s.Next(3)
	var got []int
	s.Subscribe(func(v int) { got = append(got, v) })
	if !slices.Equal(got, []int{1, 2, 3}) {
		t.Fatalf("got %v", got)
	}
}

func TestObservableSubscribeCallsFactory(t *testing.T) {
	called := false
	obs := NewObservable(func(cb func(int)) *Disposable {
		called = true
		return NewDisposable(func() {})
	})
	obs.Subscribe(func(int) {})
	if !called {
		t.Fatal("subscribe factory not called")
	}
}

func TestFilter(t *testing.T) {
	s := NewSubject[int]()
	var got []int
	Filter(s.AsObservable(), func(v int) bool { return v%2 == 0 }).
		Subscribe(func(v int) { got = append(got, v) })
	for _, v := range []int{1, 2, 3, 4} {
		s.Next(v)
	}
	if !slices.Equal(got, []int{2, 4}) {
		t.Fatalf("got %v", got)
	}
}

func TestMap(t *testing.T) {
	s := NewSubject[int]()
	var got []string
	Map(s.AsObservable(), func(v int) string { return "v" + string(rune('0'+v)) }).
		Subscribe(func(v string) { got = append(got, v) })
	s.Next(1)
	s.Next(2)
	if !slices.Equal(got, []string{"v1", "v2"}) {
		t.Fatalf("got %v", got)
	}
}

func TestDistinctUntilChanged(t *testing.T) {
	s := NewSubject[int]()
	var got []int
	DistinctUntilChanged(s.AsObservable()).
		Subscribe(func(v int) { got = append(got, v) })
	for _, v := range []int{1, 1, 2, 2, 1} {
		s.Next(v)
	}
	if !slices.Equal(got, []int{1, 2, 1}) {
		t.Fatalf("got %v", got)
	}
}

func TestDistinctUntilChangedFunc(t *testing.T) {
	type item struct {
		ID   int
		Name string
	}
	s := NewSubject[item]()
	var got []item
	DistinctUntilChangedFunc(s.AsObservable(), func(a, b item) bool { return a.ID == b.ID }).
		Subscribe(func(v item) { got = append(got, v) })
	s.Next(item{1, "a"})
	s.Next(item{1, "b"})
	s.Next(item{2, "c"})
	want := []item{{1, "a"}, {2, "c"}}
	if !slices.Equal(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestPairwise(t *testing.T) {
	s := NewSubject[int]()
	var got [][2]int
	Pairwise(s.AsObservable()).
		Subscribe(func(p [2]int) { got = append(got, p) })
	s.Next(1)
	s.Next(2)
	s.Next(3)
	want := [][2]int{{1, 2}, {2, 3}}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestPairwiseNoEmitOnFirst(t *testing.T) {
	s := NewSubject[int]()
	var got [][2]int
	Pairwise(s.AsObservable()).
		Subscribe(func(p [2]int) { got = append(got, p) })
	s.Next(1)
	if len(got) != 0 {
		t.Fatalf("got %v, want empty", got)
	}
}

func TestMergeMap(t *testing.T) {
	s := NewSubject[int]()
	var got []int
	MergeMap(s.AsObservable(), func(v, _ int) []int { return []int{v, v * 10} }).
		Subscribe(func(v int) { got = append(got, v) })
	s.Next(1)
	s.Next(2)
	if !slices.Equal(got, []int{1, 10, 2, 20}) {
		t.Fatalf("got %v", got)
	}
}

func TestMergeMapEmptyLists(t *testing.T) {
	s := NewSubject[int]()
	var got []int
	MergeMap(s.AsObservable(), func(v, idx int) []int {
		if idx == 0 {
			return nil
		}
		return []int{v}
	}).Subscribe(func(v int) { got = append(got, v) })
	s.Next(1)
	s.Next(2)
	if !slices.Equal(got, []int{2}) {
		t.Fatalf("got %v", got)
	}
}

func TestShareSingleSourceSubscription(t *testing.T) {
	count := 0
	source := NewObservable(func(cb func(int)) *Disposable {
		count++
		return NewDisposable(func() {})
	})
	shared := Share(source, nil)
	shared.Subscribe(func(int) {})
	shared.Subscribe(func(int) {})
	if count != 1 {
		t.Fatalf("upstream subscribed %d times, want 1", count)
	}
}

func TestShareResubscribesAfterAllDispose(t *testing.T) {
	count := 0
	subject := NewSubject[int]()
	source := NewObservable(func(cb func(int)) *Disposable {
		count++
		return subject.Subscribe(cb)
	})
	shared := Share(source, nil)
	s1 := shared.Subscribe(func(int) {})
	s2 := shared.Subscribe(func(int) {})
	if count != 1 {
		t.Fatalf("count=%d after two subscribes, want 1", count)
	}
	s1.Dispose()
	s2.Dispose()
	shared.Subscribe(func(int) {})
	if count != 2 {
		t.Fatalf("count=%d after resubscribe, want 2", count)
	}
}

func TestOperatorChaining(t *testing.T) {
	s := NewSubject[int]()
	var got []int
	chained := DistinctUntilChanged(
		Map(
			Filter(s.AsObservable(), func(v int) bool { return v > 1 }),
			func(v int) int { return v * 10 },
		),
	)
	chained.Subscribe(func(v int) { got = append(got, v) })
	for _, v := range []int{1, 2, 2, 3} {
		s.Next(v)
	}
	if !slices.Equal(got, []int{20, 30}) {
		t.Fatalf("got %v", got)
	}
}

func TestFirstValueFromBehaviorSubject(t *testing.T) {
	s := NewBehaviorSubject("hello")
	v, err := FirstValueFrom(s)
	if err != nil || v != "hello" {
		t.Fatalf("v=%q err=%v", v, err)
	}
}

func TestFirstValueFromReplaySubject(t *testing.T) {
	s := NewReplaySubject[int](1)
	s.Next(99)
	v, err := FirstValueFrom(s)
	if err != nil || v != 99 {
		t.Fatalf("v=%d err=%v", v, err)
	}
}

func TestFirstValueFromAsyncEmit(t *testing.T) {
	s := NewSubject[int]()
	go func() {
		time.Sleep(10 * time.Millisecond)
		s.Next(42)
	}()
	v, err := FirstValueFrom(s)
	if err != nil || v != 42 {
		t.Fatalf("v=%d err=%v", v, err)
	}
}

// TestFirstValueFromHangsOnCompletedEmpty documents that a source which
// completes without ever emitting never resolves (matches the Python SDK).
func TestFirstValueFromHangsOnCompletedEmpty(t *testing.T) {
	s := NewSubject[int]()
	s.Complete()
	done := make(chan struct{})
	go func() {
		_, _ = FirstValueFrom(s) // intentionally blocks forever
		close(done)
	}()
	select {
	case <-done:
		t.Fatal("FirstValueFrom returned; expected it to block on a completed empty source")
	case <-time.After(50 * time.Millisecond):
		// expected: still blocked
	}
}
