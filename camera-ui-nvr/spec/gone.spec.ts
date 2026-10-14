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
}

function sources(world: World): GoneSources & { asked: number[] } {
  const asked: number[] = [];
  const lying = (t: number) => (world.lyingFrom === undefined || t >= world.lyingFrom) && (world.lyingUntil === undefined || t < world.lyingUntil);
  const covered = (t: number) => (world.covered ?? []).some(([a, b]) => t >= a && t < b);
  const recordedAt = (t: number) => (world.recorded ?? [{ startMs: T0 - 24 * 60 * MIN, endMs: T0 + 48 * 60 * MIN }]).some((s) => t >= s.startMs && t <= s.endMs);
  const look = (t: number) => (covered(t) ? pattern(3, t) : lying(t) ? pattern(1, t) : pattern(2, t, true));
  const decode = (picture: Uint8Array) => Number(new TextDecoder().decode(picture));
  return {
    asked,
    recorded: (from, to) => (world.recorded ?? [{ startMs: from, endMs: to }]).filter((s) => s.endMs >= from && s.startMs <= to),
    frame: async (atMs) => (recordedAt(atMs) ? new TextEncoder().encode(String(atMs)) : undefined),
    find: async (picture) => {
      if (world.noFinder) return { problem: NO_FINDER };
      const t = decode(picture);
      asked.push(t);
      const seen = lying(t) && !covered(t) && !(world.missed?.(t) ?? false);
      return { english: 'phone', foundScore: 0.1, boxes: seen ? [{ ...PHONE, score: 0.3 }] : [{ x: 0.1, y: 0.1, width: 0.05, height: 0.05, score: 0.04 }] };
    },
    patchOf: async (picture, region) => {
      assert.deepEqual(region, widened(PHONE), 'the place with what is around it');
      return look(decode(picture));
    },
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

// ---- nothing recorded, no finder
{
  assert.equal((await whenGone(sources({ recorded: [] }), T0, T0 + MIN)).state, 'no-recording');
  const none = await whenGone(sources({ noFinder: true }), T0, T0 + 60 * MIN);
  assert.equal(none.state, 'no-finder');
}

console.log('gone.spec: patches, gone to the half second, still there, never there, put down later, a person over it, a missing finder, a pause in the recording OK');
