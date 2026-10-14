// What became of a place marked on a frame of the recording (place.ts placeHistory): the place's look at keyframes
// compared with the marked moment. On a made-up camera with a keyframe every 2 s: a thing lying in the place for some
// whiles, someone standing in front of it, the night picture (no colour), the camera turned, someone close to the
// lens, pauses in the recording, keyframes that cannot be read.
// Run: npx tsx spec/place.spec.ts
import assert from 'node:assert/strict';

import { PATCH } from '../src/gone.js';
import { insidePicture, LOOKS_MAX, NIGHT_COLOUR, OVERVIEW_H, OVERVIEW_W, placeHistory, PLACE_MIN } from '../src/place.js';

import type { Place, Stretch } from '../src/gone.js';
import type { PlaceAnswer, PlaceLook, PlaceMode, PlaceSources } from '../src/place.js';

const T0 = Date.parse('2026-10-14T00:00:00+03:00');
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const GOP = 2 * SEC;
const at = (hhmmss: string) => {
  const [h, m, s = '0'] = hhmmss.split(':');
  return T0 + Number(h) * HOUR + Number(m) * MIN + Number(s) * SEC;
};
const clock = (ms: number | undefined) => (ms === undefined ? '-' : new Date(ms + 3 * HOUR).toISOString().slice(11, 19));
const PLACE: Place = { x: 0.1, y: 0.5, width: 0.2, height: 0.25 };

/** A seeded pattern of `size` pixels: the same seed, the same pixels, plus the sensor's noise of each keyframe. */
function pattern(seed: number, noiseSeed: number, size: number, flat = false): Uint8Array {
  const out = new Uint8Array(size);
  let s = seed;
  let n = noiseSeed;
  for (let i = 0; i < size; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    n = (n * 22695477 + 1) >>> 0;
    const base = flat ? 180 : 60 + ((s >>> 16) % 150);
    out[i] = Math.max(0, Math.min(255, base + ((n >>> 16) % 7) - 3));
  }
  return out;
}

type Span = [number, number];
interface World {
  recorded?: Stretch[];
  /** the thing lies in the place during these */
  lying?: Span[];
  /** someone stands in front of the place */
  covered?: Span[];
  /** someone close to the lens: the whole picture otherwise */
  close?: Span[];
  /** the camera looks elsewhere from this on */
  turnedAt?: number;
  /** the night picture (gray) */
  night?: Span[];
  unreadable?: (kf: number) => boolean;
}

const inside = (spans: Span[] | undefined, t: number) => (spans ?? []).some(([a, b]) => t >= a && t < b);

function sources(world: World): PlaceSources & { decoded: number[] } {
  const decoded: number[] = [];
  const recorded = world.recorded ?? [{ startMs: T0 - 48 * HOUR, endMs: T0 + 72 * HOUR }];
  return {
    decoded,
    recorded: (from, to) => recorded.filter((s) => s.endMs >= from && s.startMs <= to),
    look: async (atMs): Promise<PlaceLook | undefined> => {
      const stretch = recorded.find((s) => atMs >= s.startMs && atMs <= s.endMs) ?? recorded.find((s) => s.startMs > atMs && s.startMs <= atMs + 2 * SEC);
      if (!stretch) return undefined;
      // a file of the recording starts with a keyframe; then one every GOP of the clock
      const kf = Math.max(stretch.startMs, T0 + Math.floor((Math.max(atMs, stretch.startMs) - T0) / GOP) * GOP);
      if (world.unreadable?.(kf)) return undefined;
      decoded.push(kf);
      const night = inside(world.night, kf);
      const turned = world.turnedAt !== undefined && kf >= world.turnedAt;
      const lying = inside(world.lying, kf);
      const patch = turned
        ? pattern(50, kf, PATCH * PATCH)
        : inside(world.covered, kf)
          ? pattern(3, kf, PATCH * PATCH)
          : night
            ? lying
              ? pattern(11, kf, PATCH * PATCH)
              : pattern(12, kf, PATCH * PATCH, true)
            : lying
              ? pattern(1, kf, PATCH * PATCH)
              : pattern(2, kf, PATCH * PATCH, true);
      const overview = inside(world.close, kf)
        ? pattern(77, kf, OVERVIEW_W * OVERVIEW_H)
        : turned
          ? pattern(60, kf, OVERVIEW_W * OVERVIEW_H)
          : pattern(night ? 41 : 40, kf, OVERVIEW_W * OVERVIEW_H);
      return { atMs: kf, patch, overview, colour: night ? 0.4 : 18 };
    },
  };
}

async function ask(world: World, mode: PlaceMode, marked: number, from: number, to: number): Promise<PlaceAnswer & { decoded: number[] }> {
  const src = sources(world);
  const answer = await placeHistory(src, { place: PLACE, atMs: marked, fromMs: from, toMs: to, mode });
  assert.ok(answer.looks <= LOOKS_MAX, `looks within the budget (${answer.looks})`);
  return { ...answer, decoded: src.decoded };
}

const changed = (a: PlaceAnswer) => a.changes.filter((c) => c.kind === 'changed');
const near = (ms: number | undefined, want: number, slack: number, what: string) =>
  assert.ok(ms !== undefined && Math.abs(ms - want) <= slack, `${what}: ${clock(ms)}, want ${clock(want)} ± ${slack / SEC} s`);

// ---- gone: taken at 10:00:01 while someone stood in front 09:59:30-10:00:20; marked at 08:00
{
  const a = await ask({ lying: [[at('0:00'), at('10:00:01')]], covered: [[at('9:59:30'), at('10:00:20')]] }, 'gone', at('8:00'), at('8:00'), at('12:00'));
  assert.equal(a.state, 'ok');
  const [c] = changed(a);
  assert.ok(c, 'the change found');
  near(c.beforeMs, at('9:59:28'), 0, 'the last keyframe as marked is just before someone came');
  near(c.afterMs, at('10:00:20'), 0, 'the first as it became is just after they left');
  assert.ok(c.exact, 'narrowed to keyframes');
  assert.ok(c.busy && c.busy.fromMs === at('9:59:30') && c.busy.toMs === at('10:00:18'), `someone in front between: ${clock(c.busy?.fromMs)}-${clock(c.busy?.toMs)}`);
  assert.equal(a.lastSameMs, c.beforeMs);
  assert.ok(!c.gap);
  console.log(`ok gone: last as marked ${clock(c.beforeMs)}, someone in front ${clock(c.busy!.fromMs)}-${clock(c.busy!.toMs)}, after ${clock(c.afterMs)} (${a.looks} looks)`);
}

// ---- gone, nobody in front: the neighbouring keyframes
{
  const a = await ask({ lying: [[at('0:00'), at('10:00:01')]] }, 'gone', at('8:00'), at('8:00'), at('12:00'));
  const [c] = changed(a);
  assert.equal(c.beforeMs, at('10:00:00'));
  assert.equal(c.afterMs, at('10:00:02'));
  assert.ok(c.exact && !c.busy);
  console.log(`ok gone: ${clock(c.beforeMs)} → ${clock(c.afterMs)}`);
}

// ---- gone, still there: no change, the last look is the end; someone in front for four minutes is a pass
{
  const a = await ask({ lying: [[at('0:00'), at('23:00')]], covered: [[at('9:00'), at('9:04')]] }, 'gone', at('8:00'), at('8:00'), at('12:00'));
  assert.equal(changed(a).length, 0, 'nothing went');
  near(a.lastSameMs, at('12:00'), GOP, 'as marked to the end');
  assert.ok(a.passes.some((p) => p.fromMs >= at('9:00') && p.toMs < at('9:04')), `the pass seen: ${JSON.stringify(a.passes.map((p) => [clock(p.fromMs), clock(p.toMs)]))}`);
  console.log(`ok still there: until ${clock(a.lastSameMs)}, passes ${a.passes.length}`);
}

// ---- gone, someone sat in front for twenty minutes and left: the thing is there after them, nothing went
{
  const a = await ask({ lying: [[at('0:00'), at('23:00')]], covered: [[at('9:00'), at('9:20')]] }, 'gone', at('8:00'), at('8:00'), at('12:00'));
  assert.equal(changed(a).length, 0, 'a long stay in front is not a going when the place looks as marked after it');
  assert.ok(a.passes.some((p) => p.fromMs >= at('9:00') && p.toMs < at('9:20') && p.toMs - p.fromMs >= 10 * MIN));
  console.log('ok a long stay in front is a pass');
}

// ---- appeared: put at 10:00:05 by someone standing there 10:00:00-10:00:30; marked at 11:00
{
  const a = await ask({ lying: [[at('10:00:05'), at('23:00')]], covered: [[at('10:00'), at('10:00:30')]] }, 'appeared', at('11:00'), at('8:00'), at('11:00'));
  const [c] = changed(a);
  assert.ok(c, 'the coming found');
  near(c.beforeMs, at('9:59:58'), 0, 'the last keyframe as before is just before someone came');
  near(c.afterMs, at('10:00:30'), 0, 'the first as marked is when they left');
  assert.ok(c.busy && c.busy.fromMs === at('10:00') && c.busy.toMs === at('10:00:28'));
  assert.equal(a.firstSameMs, c.afterMs);
  console.log(`ok appeared: ${clock(c.beforeMs)} → ${clock(c.afterMs)} (someone ${clock(c.busy!.fromMs)}-${clock(c.busy!.toMs)})`);
}

// ---- appeared, someone passing a minute before the marked moment is not the coming
{
  const a = await ask({ lying: [[at('9:00:09'), at('23:00')]], covered: [[at('10:58'), at('10:59')]] }, 'appeared', at('11:00'), at('8:00'), at('11:00'));
  const [c] = changed(a);
  near(c.afterMs, at('9:00:10'), 0, 'the coming is at nine, not the pass before eleven');
  console.log(`ok appeared past a pass: ${clock(c.afterMs)}`);
}

// ---- history: put at 9:00, taken at 10:00, put back at 11:00; marked at 9:30 while it lay; someone passing at 9:45
// (on one look of the first pass, a look every 90 s from 8:00) is no change
{
  const lying: Span[] = [
    [at('9:00:01'), at('10:00:01')],
    [at('11:00:01'), at('23:00')],
  ];
  const a = await ask({ lying, covered: [[at('9:44:50'), at('9:45:40')]] }, 'history', at('9:30'), at('8:00'), at('12:00'));
  const c = changed(a);
  assert.ok(a.passes.some((p) => p.fromMs === at('9:45')), `the pass: ${JSON.stringify(a.passes.map((p) => clock(p.fromMs)))}`);
  assert.equal(c.length, 3, `three changes: ${c.map((x) => clock(x.afterMs)).join(', ')}`);
  near(c[0].afterMs, at('9:00:02'), 0, 'put');
  near(c[1].afterMs, at('10:00:02'), 0, 'taken');
  near(c[2].afterMs, at('11:00:02'), 0, 'put back');
  assert.deepEqual(
    c.map((x) => !!x.asMarked),
    [true, false, true],
    'after the first and the third it looks as marked',
  );
  console.log(`ok history: ${c.map((x) => `${clock(x.beforeMs)}→${clock(x.afterMs)}${x.asMarked ? ' (as marked)' : ''}`).join(', ')}`);
}

// ---- the camera turned at 10:30: the looking stops there, the place's new look is not a going
{
  const a = await ask({ lying: [[at('0:00'), at('23:00')]], turnedAt: at('10:30') }, 'gone', at('8:00'), at('8:00'), at('12:00'));
  const turned = a.changes.filter((c) => c.kind === 'turned');
  assert.equal(turned.length, 1, 'the turn said');
  near(turned[0].afterMs, at('10:30'), 0, 'when it turned, to a keyframe');
  assert.equal(changed(a).length, 0, 'the place itself did not change');
  assert.ok(a.toMs! < at('10:30'), `the looking stopped at the turn: ${clock(a.toMs)}`);
  near(a.lastSameMs, at('10:30'), 2 * a.stepMs!, 'as marked until the turn');
  console.log(`ok turned at ${clock(turned[0].afterMs)}, looked to ${clock(a.toMs)}`);
}

// ---- someone close to the lens for one look: not a turn
{
  const a = await ask({ lying: [[at('0:00'), at('23:00')]], close: [[at('9:00'), at('9:01')]], covered: [[at('9:00'), at('9:01')]] }, 'gone', at('8:00'), at('8:00'), at('12:00'));
  assert.equal(a.changes.filter((c) => c.kind === 'turned').length, 0, 'one look unlike is not a turn');
  near(a.toMs, at('12:00'), GOP, 'looked to the end');
  console.log('ok close to the lens is not a turn');
}

// ---- night: taken at 15:00 by day, the night pictures (from 18:00) do not stand for the thing being there
{
  const a = await ask({ lying: [[at('0:00'), at('15:00:01')]], night: [[at('18:00'), at('30:00')]] }, 'gone', at('12:00'), at('12:00'), at('23:00'));
  const [c] = changed(a);
  assert.ok(c, 'the going by day found');
  near(c.afterMs, at('15:00:02'), 0, 'taken at three');
  assert.equal(a.lastSameMs, at('15:00'));
  assert.ok(a.changes.some((x) => x.kind === 'light'), 'the night said');
  console.log(`ok taken by day: ${clock(c.afterMs)}, night said`);
}

// ---- night: taken at 22:00 by night, marked by day: compared with the first night picture
{
  const a = await ask({ lying: [[at('0:00'), at('22:00:01')]], night: [[at('18:00'), at('30:00')]] }, 'gone', at('12:00'), at('12:00'), at('23:30'));
  const [c] = changed(a);
  assert.ok(c, 'the going by night found');
  near(c.afterMs, at('22:00:02'), 0, 'taken at ten in the night');
  console.log(`ok taken by night: ${clock(c.afterMs)}`);
}

// ---- the thing taken (or brought) as the light changed: the night pictures cannot tell, the change is said across the
// night between two pictures by the same light (it was said at the next change of light, hours off, as exact)
{
  const contains = (c: { beforeMs: number; afterMs: number } | undefined, t: number, what: string) =>
    assert.ok(c && c.beforeMs <= t && c.afterMs >= t, `${what}: ${clock(c?.beforeMs)}-${clock(c?.afterMs)} holds ${clock(t)}`);
  const night: Span[] = [[at('23:10'), at('31:30')]];
  const gone = await ask({ lying: [[at('0:00'), at('23:10')]], night }, 'gone', at('20:00'), at('20:00'), at('33:00'));
  const [g] = changed(gone);
  contains(g, at('23:10'), 'taken as the night came');
  assert.ok(g.throughLight && !g.exact, 'said across the light, not exact');
  assert.ok(gone.lastSameMs! <= at('23:10'), `last as marked ${clock(gone.lastSameMs)}`);
  const appeared = await ask({ lying: [[at('31:30'), at('40:00')]], night }, 'appeared', at('32:00'), at('20:00'), at('32:00'));
  const [a] = changed(appeared);
  contains(a, at('31:30'), 'brought as the day came');
  assert.ok(a.throughLight && !a.exact);
  const history = await ask({ lying: [[at('0:00'), at('23:10')]], night }, 'history', at('20:00'), at('20:00'), at('33:00'));
  const [h] = changed(history);
  contains(h, at('23:10'), 'the history has it');
  assert.ok(h.throughLight);
  // taken in the middle of the night: found by the night pictures, exactly, no talk of the light
  const midnight = await ask({ lying: [[at('0:00'), at('27:00:01')]], night }, 'history', at('20:00'), at('20:00'), at('33:00'));
  const inNight = changed(midnight);
  assert.equal(inNight.length, 1, JSON.stringify(inNight));
  assert.ok(!inNight[0].throughLight && inNight[0].exact);
  console.log(`ok taken as the light changed: gone ${clock(g.beforeMs)}-${clock(g.afterMs)}, appeared ${clock(a.beforeMs)}-${clock(a.afterMs)}, history ${clock(h.beforeMs)}-${clock(h.afterMs)}`);
}

// ---- a pause in the recording 10:00-10:30, taken during it
{
  const recorded = [
    { startMs: at('0:00'), endMs: at('10:00') },
    { startMs: at('10:30'), endMs: at('23:00') },
  ];
  const a = await ask({ recorded, lying: [[at('0:00'), at('10:15')]] }, 'gone', at('8:00'), at('8:00'), at('12:00'));
  const [c] = changed(a);
  assert.ok(c.gap, 'the pause said');
  assert.ok(c.beforeMs <= at('10:00') && c.afterMs >= at('10:30'), `around the pause: ${clock(c.beforeMs)} → ${clock(c.afterMs)}`);
  console.log(`ok taken in a pause: ${clock(c.beforeMs)} → ${clock(c.afterMs)}`);
}

// ---- no recording; the marked moment unreadable; keyframes that cannot be read are stepped over
{
  const none = await ask({ recorded: [{ startMs: at('0:00'), endMs: at('1:00') }] }, 'gone', at('8:00'), at('8:00'), at('12:00'));
  assert.equal(none.state, 'no-recording');
  const blind = await ask({ unreadable: () => true }, 'gone', at('8:00'), at('8:00'), at('12:00'));
  assert.equal(blind.state, 'unreadable');
  const holes = await ask({ lying: [[at('0:00'), at('10:00:01')]], unreadable: (kf) => kf % (7 * GOP) === 0 && kf !== at('8:00') }, 'gone', at('8:00'), at('8:00'), at('12:00'));
  const [c] = changed(holes);
  assert.ok(c && c.afterMs >= at('10:00:02') && c.beforeMs <= at('10:00'), `found past unreadable keyframes: ${clock(c?.beforeMs)} → ${clock(c?.afterMs)}`);
  console.log('ok no recording, unreadable');
}

// ---- a week of a place that changes every half hour: the first pass (a look an hour) sees some of the changes, the
// first ten are narrowed to keyframes, the rest said to its step; all within the looks
{
  const lying: Span[] = [];
  for (let t = at('0:00'); t < at('168:00'); t += HOUR) lying.push([t + 17 * SEC, t + 30 * MIN + 17 * SEC]);
  const a = await ask({ lying, recorded: [{ startMs: at('0:00'), endMs: at('168:00') }] }, 'history', at('84:00:30'), at('0:00'), at('168:00'));
  assert.equal(a.state, 'ok');
  assert.ok(changed(a).length > 10, `the changes the first pass saw: ${changed(a).length}`);
  assert.equal(changed(a).filter((c) => c.exact).length, 10, 'ten narrowed');
  for (const c of changed(a).filter((x) => x.exact)) {
    const phase = (c.afterMs - at('0:00')) % HOUR;
    assert.ok(phase === 18 * SEC || phase === 30 * MIN + 18 * SEC, `a narrowed change on its keyframe: ${clock(c.afterMs)}`);
  }
  console.log(`ok a busy week: ${changed(a).length} changes in ${a.looks} looks`);
}

// ---- night colour threshold, the place drawn by hand
{
  assert.ok(NIGHT_COLOUR > 0.4 && NIGHT_COLOUR < 18);
  const backwards = insidePicture({ x: 0.5, y: 0.5, width: -0.2, height: 0.1 });
  for (const [key, want] of Object.entries({ x: 0.3, y: 0.5, width: 0.2, height: 0.1 })) {
    assert.ok(Math.abs(backwards[key as keyof Place] - want) < 1e-9, `drawn right to left: ${key} ${backwards[key as keyof Place]}`);
  }
  const tiny = insidePicture({ x: 0.999, y: 0.2, width: 0.0001, height: 0.0001 });
  assert.ok(tiny.width === PLACE_MIN && tiny.x + tiny.width <= 1, `a slip of the finger made the smallest place inside: ${JSON.stringify(tiny)}`);
  const over = insidePicture({ x: 0.9, y: 0.9, width: 0.5, height: 0.5 });
  assert.ok(over.x + over.width <= 1 && over.y + over.height <= 1);
  console.log('ok places drawn by hand');
}

console.log('place: all ok');
