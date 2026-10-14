// When a thing that lay in the picture of a camera went (gone.ts whenGone): the words found where it lay, the recording
// halved, the last minute looked at twice a second. On a made-up camera: a phone on a table until a given second, a
// person standing over it for a while, pauses in the recording, a finder that misses the phone now and then.
// Run: npx tsx spec/gone.spec.ts
import assert from 'node:assert/strict';

import { FINE_MS, NO_FINDER, PATCH, patchDiff, SAME_LOOK, whenGone, widened } from '../src/gone.js';

import type { GoneSources, Place, Stretch } from '../src/gone.js';

const T0 = Date.parse('2026-10-14T08:00:00+03:00');
const MIN = 60_000;
const PHONE: Place = { x: 0.5, y: 0.6, width: 0.05, height: 0.03 };

/** A seeded pattern: the same seed, the same pixels (plus a little noise of the sensor). */
function pattern(seed: number, noiseSeed: number, flat = false): Uint8Array {
  const out = new Uint8Array(PATCH * PATCH);
  let s = seed;
  let n = noiseSeed;
  for (let i = 0; i < out.length; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    n = (n * 22695477 + 1) >>> 0;
    const base = flat ? 180 : 60 + ((s >>> 16) % 150);
    out[i] = Math.max(0, Math.min(255, base + ((n >>> 16) % 7) - 3));
  }
  return out;
}

interface World {
  /** the phone lies from (default always) until this time */
  lyingFrom?: number;
  lyingUntil?: number;
  /** a person stands over it (it cannot be seen, the place looks otherwise) */
  covered?: [number, number][];
  /** the finder misses it at these times although it is there (the place looks as it did) */
  missed?: (t: number) => boolean;
  recorded?: Stretch[];
  noFinder?: boolean;
  /** the whole frame (JPEG, scaled) and the stream give the same place other pixels: measured 0.1-0.27 on the bench */
  twoPaths?: boolean;
  /** it moves while it is there (a person sitting): its place never looks the same twice */
  restless?: boolean;
  /** the camera looks elsewhere from this on (a PTZ camera turned): the whole picture is another, the place too */
  turnedAt?: number;
  /** the night picture (gray): the whole picture another than by day (0.74-1.05 apart on the bench's Xiaomi) */
  night?: [number, number][];
}

function sources(world: World): GoneSources & { asked: number[] } {
  const asked: number[] = [];
  const lying = (t: number) => (world.lyingFrom === undefined || t >= world.lyingFrom) && (world.lyingUntil === undefined || t < world.lyingUntil);
  const covered = (t: number) => (world.covered ?? []).some(([a, b]) => t >= a && t < b);
  const recordedAt = (t: number) => (world.recorded ?? [{ startMs: T0 - 24 * 60 * MIN, endMs: T0 + 48 * 60 * MIN }]).some((s) => t >= s.startMs && t <= s.endMs);
  const turned = (t: number) => world.turnedAt !== undefined && t >= world.turnedAt;
  const look = (t: number) =>
    turned(t) ? pattern(50, t) : covered(t) ? pattern(3, t) : lying(t) ? pattern(world.restless ? 1000 + Math.floor(t / 1000) : 1, t) : pattern(2, t, true);
  // the whole picture: the room as the camera sees it, another one once it turned, another by night
  const dark = (t: number) => (world.night ?? []).some(([a, b]) => t >= a && t < b);
  const view = (t: number) => pattern((turned(t) ? 60 : 40) + (dark(t) ? 1 : 0), t);
  // the picture's path: the same look, other pixels (here reversed: as unlike as two looks can be)
  const viaPicture = (pixels: Uint8Array) => (world.twoPaths ? pixels.slice().reverse() : pixels);
  const decode = (picture: Uint8Array) => Number(new TextDecoder().decode(picture));
  return {
    asked,
    recorded: (from, to) => (world.recorded ?? [{ startMs: from, endMs: to }]).filter((s) => s.endMs >= from && s.startMs <= to),
    frame: async (atMs) => (recordedAt(atMs) ? new TextEncoder().encode(String(atMs)) : undefined),
    find: async (picture) => {
      if (world.noFinder) return { problem: NO_FINDER };
      const t = decode(picture);
      asked.push(t);
      const seen = lying(t) && !covered(t) && !turned(t) && !(world.missed?.(t) ?? false);
      return { english: 'phone', foundScore: 0.1, boxes: seen ? [{ ...PHONE, score: 0.3 }] : [{ x: 0.1, y: 0.1, width: 0.05, height: 0.05, score: 0.04 }] };
    },
    patchOf: async (picture, region) => {
      if (region.width === 1 && region.height === 1) return view(decode(picture));
      assert.deepEqual(region, widened(PHONE), 'the place with what is around it');
      return viaPicture(look(decode(picture)));
    },
    colourOf: async (picture) => (dark(decode(picture)) ? 0.4 : 18),
    patches: async (from, to, region, stepMs) => {
      assert.deepEqual(region, widened(PHONE));
      const out: { atMs: number; pixels: Uint8Array }[] = [];
      for (let t = from; t <= to; t += stepMs) if (recordedAt(t)) out.push({ atMs: t, pixels: look(t) });
      return out;
    },
  };
}

const clock = (ms: number | undefined) => (ms === undefined ? '-' : new Date(ms).toISOString().slice(11, 19));

// ---- the patches: the same look with noise is the same, the phone gone or a person over it is not
{
  assert.ok(patchDiff(pattern(1, 10), pattern(1, 99)) < SAME_LOOK / 3, 'noise of the sensor');
  assert.ok(patchDiff(pattern(1, 10), pattern(2, 10, true)) > SAME_LOOK * 1.5, 'the phone gone: a flat table');
  assert.ok(patchDiff(pattern(1, 10), pattern(3, 10)) > SAME_LOOK * 1.5, 'someone over it');
  // a lamp turned on: the same look brighter is the same
  const brighter = pattern(1, 10).map((v) => Math.min(255, Math.round(v * 1.2 + 15)));
  assert.ok(patchDiff(pattern(1, 10), brighter) < SAME_LOOK / 2, `brighter: ${patchDiff(pattern(1, 10), brighter)}`);
  // an empty table in two moments is the same, its noise is not a pattern
  assert.ok(patchDiff(pattern(2, 1, true), pattern(2, 2, true)) < SAME_LOOK);
}

// ---- it lay all morning and went at 14:03:40: found to the half second, within a few dozen looks of a whole day
{
  const gone = T0 + (6 * 60 + 3) * MIN + 40_000;
  const s = sources({ lyingUntil: gone });
  const answer = await whenGone(s, T0, T0 + 24 * 60 * MIN);
  assert.equal(answer.state, 'gone', JSON.stringify(answer));
  assert.equal(answer.english, 'phone');
  assert.deepEqual(answer.place, { ...PHONE, score: 0.3 });
  assert.equal(answer.seenMs, T0);
  assert.ok(answer.goneMs! >= gone && answer.goneMs! - gone <= FINE_MS, `gone ${clock(answer.goneMs)}`);
  assert.ok(gone - answer.lastSeenMs! <= FINE_MS && answer.lastSeenMs! < gone, `last seen ${clock(answer.lastSeenMs)}`);
  assert.equal(answer.gap, undefined);
  assert.ok(answer.looks <= 25, `${answer.looks} looks`);
  assert.deepEqual(new TextDecoder().decode(answer.before), String(answer.lastSeenMs), 'the picture of the last moment it lay');
  assert.deepEqual(new TextDecoder().decode(answer.after), String(answer.goneMs));
}

// ---- still there at the end: said so, with the last look
{
  const answer = await whenGone(sources({}), T0, T0 + 3 * 60 * MIN);
  assert.equal(answer.state, 'still-there');
  assert.equal(answer.lastSeenMs, T0 + 3 * 60 * MIN);
}

// ---- never there: said so, with what the words were taken for
{
  const answer = await whenGone(sources({ lyingUntil: T0 - MIN }), T0, T0 + 3 * 60 * MIN);
  assert.equal(answer.state, 'never-seen');
  assert.equal(answer.english, 'phone');
}

// ---- put down after the start of the time asked: found where it then lay, its going after that
{
  const s = sources({ lyingFrom: T0 + 70 * MIN, lyingUntil: T0 + 200 * MIN });
  const answer = await whenGone(s, T0, T0 + 8 * 60 * MIN);
  assert.equal(answer.state, 'gone');
  assert.ok(answer.seenMs! >= T0 + 70 * MIN);
  assert.ok(Math.abs(answer.goneMs! - (T0 + 200 * MIN)) <= FINE_MS, clock(answer.goneMs));
}

// ---- a person stood over it for a minute before it went: the minute is not its going
{
  const gone = T0 + 300 * MIN + 12_000;
  const answer = await whenGone(sources({ lyingUntil: gone, covered: [[T0 + 299 * MIN, T0 + 300 * MIN]] }), T0, T0 + 12 * 60 * MIN);
  assert.equal(answer.state, 'gone');
  assert.ok(Math.abs(answer.goneMs! - gone) <= FINE_MS, `gone ${clock(answer.goneMs)}, not when the person came`);
  // one standing over it for ten minutes just where the first halving look falls (the middle of the 12 hours): that
  // look took the person for its going; the looks after it see the phone again, the halving goes on to the real moment
  const late = T0 + 500 * MIN + 30_000;
  const fooled = await whenGone(sources({ lyingUntil: late, covered: [[T0 + 355 * MIN, T0 + 365 * MIN]] }), T0, T0 + 12 * 60 * MIN);
  assert.equal(fooled.state, 'gone');
  assert.ok(Math.abs(fooled.goneMs! - late) <= FINE_MS, `gone ${clock(fooled.goneMs)}, not when the person stood over it (06:00)`);
}

// ---- the finder misses the phone now and then: the place looks as it did, so it is there
{
  const gone = T0 + 400 * MIN;
  const answer = await whenGone(sources({ lyingUntil: gone, missed: (t) => t > T0 && t < gone }), T0, T0 + 10 * 60 * MIN);
  assert.equal(answer.state, 'gone');
  assert.ok(Math.abs(answer.goneMs! - gone) <= FINE_MS, clock(answer.goneMs));
}

// ---- it went while nothing was recorded: the pause is said, between its end and the next recording
{
  const pause: [number, number] = [T0 + 100 * MIN, T0 + 140 * MIN];
  const recorded = [
    { startMs: T0, endMs: pause[0] },
    { startMs: pause[1], endMs: T0 + 300 * MIN },
  ];
  const answer = await whenGone(sources({ lyingUntil: T0 + 120 * MIN, recorded }), T0, T0 + 300 * MIN);
  assert.equal(answer.state, 'gone');
  assert.equal(answer.gap, true);
  assert.ok(answer.lastSeenMs! <= pause[0] && answer.lastSeenMs! > pause[0] - MIN, clock(answer.lastSeenMs));
  assert.ok(answer.goneMs! >= pause[1] && answer.goneMs! < pause[1] + MIN, clock(answer.goneMs));
}

// ---- the whole frame and the stream give the same place other pixels: each compared with its own kind
{
  const gone = T0 + 333 * MIN + 7_500;
  const answer = await whenGone(sources({ lyingUntil: gone, twoPaths: true }), T0, T0 + 10 * 60 * MIN);
  assert.equal(answer.state, 'gone');
  assert.ok(Math.abs(answer.goneMs! - gone) <= FINE_MS && answer.lastSeenMs! < answer.goneMs!, `${clock(answer.lastSeenMs)} → ${clock(answer.goneMs)}`);
  assert.equal(answer.roughly, undefined);
}

// ---- a thing that moves while there (a person at a desk): the finder follows it, its place never looks the same; the
// moment is the halving's, to about a minute, said as such — not one second twice
{
  const gone = T0 + 210 * MIN;
  const answer = await whenGone(sources({ lyingUntil: gone, restless: true }), T0, T0 + 6 * 60 * MIN);
  assert.equal(answer.state, 'gone');
  assert.equal(answer.roughly, true);
  assert.ok(
    answer.lastSeenMs! < gone && answer.goneMs! >= gone && answer.goneMs! - answer.lastSeenMs! <= 2 * MIN,
    `${clock(answer.lastSeenMs)} → ${clock(answer.goneMs)}`,
  );
}

// ---- the camera turned at 05:00 while the phone lay all along: not its going; the looking stops at the turn
{
  const turnAt = T0 + 300 * MIN;
  const answer = await whenGone(sources({ turnedAt: turnAt }), T0, T0 + 12 * 60 * MIN);
  assert.equal(answer.state, 'still-there', JSON.stringify({ ...answer, before: undefined, after: undefined }));
  assert.ok(answer.turn && answer.turn.beforeMs < turnAt && answer.turn.afterMs >= turnAt && answer.turn.afterMs - answer.turn.beforeMs <= 2 * MIN, `turn ${clock(answer.turn?.beforeMs)} → ${clock(answer.turn?.afterMs)}`);
  assert.ok(answer.lastSeenMs! <= answer.turn!.beforeMs, `still there until the turn: ${clock(answer.lastSeenMs)}`);
  // taken before the turn: found as before, the turn said too
  const gone = T0 + 120 * MIN + 20_000;
  const taken = await whenGone(sources({ turnedAt: turnAt, lyingUntil: gone }), T0, T0 + 12 * 60 * MIN);
  assert.equal(taken.state, 'gone');
  assert.ok(Math.abs(taken.goneMs! - gone) <= FINE_MS, `gone ${clock(taken.goneMs)}`);
  assert.ok(taken.turn, 'the turn after it is said');
  // someone close to the lens at the very end (one look unlike the view) is no turn
  const close = await whenGone(sources({ turnedAt: T0 + 12 * 60 * MIN - 20_000 }), T0, T0 + 12 * 60 * MIN);
  assert.equal(close.turn, undefined, 'one look at the end is not a turn');
  // turned within the first minute after it was first seen: no time before the turn to look in, and the thing was
  // there at its first look — still there until the turn, not «nothing recorded»
  const early = await whenGone(sources({ turnedAt: T0 + 30_000 }), T0, T0 + 12 * 60 * MIN);
  assert.equal(early.state, 'still-there', JSON.stringify({ ...early, before: undefined, after: undefined }));
  assert.ok(early.turn && early.turn.afterMs >= T0 + 30_000, `turn ${clock(early.turn?.beforeMs)} → ${clock(early.turn?.afterMs)}`);
  assert.equal(early.seenMs, T0);
  assert.equal(early.lastSeenMs, T0);
  // put down a minute before the turn, first seen at the look of 01:30: the looks before the turn do not see it again
  const late = await whenGone(sources({ lyingFrom: T0 + 89 * MIN, turnedAt: T0 + 90 * MIN + 30_000 }), T0, T0 + 12 * 60 * MIN);
  assert.equal(late.state, 'still-there', JSON.stringify({ ...late, before: undefined, after: undefined }));
  assert.equal(late.seenMs, T0 + 90 * MIN);
  assert.ok(late.turn);
}

// ---- the night coming is no turn (a day view and a night one differ as much as a turned camera's); a turn by night is
{
  const night: [number, number][] = [[T0 + 8 * 60 * MIN, T0 + 20 * 60 * MIN]];
  const dusk = await whenGone(sources({ night }), T0, T0 + 12 * 60 * MIN);
  assert.equal(dusk.state, 'still-there', JSON.stringify({ ...dusk, before: undefined, after: undefined }));
  assert.equal(dusk.turn, undefined, `the night is no turn: ${clock(dusk.turn?.beforeMs)} → ${clock(dusk.turn?.afterMs)}`);
  const turnAt = T0 + 10 * 60 * MIN;
  const byNight = await whenGone(sources({ night, turnedAt: turnAt }), T0, T0 + 12 * 60 * MIN);
  assert.ok(byNight.turn && byNight.turn.afterMs >= turnAt && byNight.turn.beforeMs < turnAt, `turned by night: ${clock(byNight.turn?.beforeMs)} → ${clock(byNight.turn?.afterMs)}`);
  assert.ok(byNight.turn.afterMs - byNight.turn.beforeMs <= 2 * MIN);
}

// ---- nothing recorded, no finder
{
  assert.equal((await whenGone(sources({ recorded: [] }), T0, T0 + MIN)).state, 'no-recording');
  const none = await whenGone(sources({ noFinder: true }), T0, T0 + 60 * MIN);
  assert.equal(none.state, 'no-finder');
}

console.log('gone.spec: patches, gone to the half second, still there, never there, put down later, a person over it, a missing finder, a pause in the recording OK');
