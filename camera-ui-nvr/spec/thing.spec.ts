// A thing the person marked on a frame, followed by its outline (src/thing.ts), in a made-up world: a red thing lies on
// a gray table; a person walks past it once (its place changes for a keyframe, the thing still there), later picks it
// up at 3000.4 s and carries it to the right out of the picture. The outliner outlines the thing where a prompt falls
// on it and some gray part of the table where one does not (as SAM does on an empty table): the look inside the outline
// tells them apart. Also: the thing never went, nothing outlined at the mark, the outliner failing, the night.
// Run: npx tsx spec/thing.spec.ts
import assert from 'node:assert/strict';

import { PATCH } from '../src/gone.js';
import { BUDGET_MS, colourDistance, FOLLOW_MS, followThing, GONE_EXACT_MS, LOOKS_MAX, overlap, sameThing, thingLook } from '../src/thing.js';

import type { Place } from '../src/gone.js';
import type { Outlined, PersonThere, Prompt, ThingLook, ThingSources } from '../src/thing.js';

const S = 1000;
const MARK = 1000 * S;
const PASS = 2000 * S; // the person walks past the thing
const TAKEN = 3000 * S + 400; // the thing picked up
const END = 4000 * S;
const LYING: Place = { x: 0.45, y: 0.55, width: 0.06, height: 0.05 };
/** the share of the picture the thing moves to the right each second while carried */
const SPEED = 0.05;

/** Where the thing is at a time: on the table until taken, then carried (`speed`: shares of the picture a second, to the
right when positive); out of the picture after that. */
function thingAt(t: number, speed = SPEED): Place | undefined {
  if (t < TAKEN) return LYING;
  const x = LYING.x + ((t - TAKEN) / S) * speed;
  if (x >= 1 || x + LYING.width <= 0) return undefined;
  const left = Math.max(0, x);
  return { ...LYING, x: left, width: Math.min(x + LYING.width, 1) - left };
}
/** A person whose hand (the point at 0.3 across and 0.6 down their box) holds the thing. */
const holding = (thing: Place): Place => ({ x: thing.x + thing.width / 2 - 0.06, y: thing.y + thing.height / 2 - 0.3, width: 0.2, height: 0.5 });
/** The one carrying it (handed it by a helper for the first second), and the one passing by. */
function peopleAt(t: number, speed = SPEED): PersonThere[] {
  const thing = thingAt(t, speed);
  const out: PersonThere[] = [];
  if (thing && t >= TAKEN && t < TAKEN + S) out.push({ eventId: 'ev-helper', trackId: 2, box: holding(thing) });
  if (thing && t >= TAKEN - 3 * S) out.push({ eventId: 'ev-took', trackId: 7, box: holding(thing) });
  if (Math.abs(t - PASS) < 2 * S) out.push({ eventId: 'ev-passed', trackId: 3, box: { x: 0.4, y: 0.2, width: 0.2, height: 0.7 } });
  return out;
}
/** A thing like it, lying beside it all the time. */
const TWIN: Place = { ...LYING, x: LYING.x + LYING.width * 0.9 };

const encode = (t: number) => new Uint8Array(new Float64Array([t]).buffer);
const decode = (picture: Uint8Array) => new Float64Array(picture.slice().buffer)[0];
const contains = (box: Place, p: { x: number; y: number }) => p.x >= box.x && p.x <= box.x + box.width && p.y >= box.y && p.y <= box.y + box.height;

const RED: ThingLook = { colour: [200, 30, 30], patch: Uint8Array.from({ length: PATCH * PATCH }, (_, i) => ((i % PATCH) * 7 + Math.floor(i / PATCH) * 3) % 200), night: false };
const TABLE: ThingLook = { colour: [120, 118, 115], patch: Uint8Array.from({ length: PATCH * PATCH }, (_, i) => ((i * 37) % 97) + 60), night: false };

interface World {
  /** the thing carried this fast (shares of the picture a second; to the left when negative) */
  speed?: number;
  /** a thing like it lies beside it */
  twin?: boolean;
  night?: boolean;
  /** the outliner fails from this many pictures on */
  failAfter?: number;
  /** nothing taken: it lies there all the time */
  stays?: boolean;
  /** the mark outlined weakly */
  weakMark?: boolean;
  /** the camera turned at this moment (before the thing was taken): elsewhere after it */
  turnedAt?: number;
  /** each outline takes this long by the question's clock */
  outlineMs?: number;
}

function world(w: World = {}) {
  const asked: number[] = [];
  let clock = 0;
  const at = (t: number) => (w.stays ? LYING : thingAt(t, w.speed));
  /** the thing a prompt falls on, the marked one before its twin */
  const things = (t: number) => [at(t), ...(w.twin ? [TWIN] : [])].filter((p): p is Place => p !== undefined);
  const sources: ThingSources = {
    recorded: () => [{ startMs: 0, endMs: END }],
    frame: async (t) => encode(t),
    outline: async (picture, prompts: Prompt[]) => {
      const t = decode(picture);
      asked.push(t);
      clock += w.outlineMs ?? 0;
      if (w.failAfter !== undefined && asked.length > w.failAfter) return { problem: 'outliner gone' };
      return prompts.map((prompt): Outlined => {
        if (w.turnedAt !== undefined && t >= w.turnedAt) return prompts.map(() => ({ score: 0.7, present: true }));
      const thing = things(t).find(
          (one) => (prompt.box && overlap(prompt.box, one) > 0.1) || (prompt.points ?? []).some((p) => contains({ ...one, x: one.x - 0.01, y: one.y - 0.01, width: one.width + 0.02, height: one.height + 0.02 }, p)),
        );
        if (thing) return { score: w.weakMark && t === MARK ? 0.2 : 0.95, present: true, mask: { box: thing, width: 60, height: 40, data: new Uint8Array(60 * 40).fill(255), area: thing.width * thing.height * 0.8 } };
        // some part of the table: a box is outlined as it is, a point on nothing gets nothing
        if (prompt.box) return { score: 0.74, present: true, mask: { box: prompt.box, width: 60, height: 40, data: new Uint8Array(60 * 40).fill(255), area: prompt.box.width * prompt.box.height * 0.6 } };
        return { score: 0.06, present: true };
      });
    },
    lookOf: async (picture, outline) => {
      const look = things(decode(picture)).some((thing) => overlap(outline.box, thing) > 0.5) ? RED : TABLE;
      return w.night ? { colour: [90, 90, 90], patch: look.patch, night: true } : look;
    },
    changes: async (place, from, to) => {
      // keyframes every 10 s: the place changes as the person passes (and is as before after) and as the thing goes
      const out = [{ beforeMs: PASS - 10 * S, afterMs: PASS }];
      if (!w.stays) out.push({ beforeMs: Math.floor(TAKEN / (10 * S)) * 10 * S, afterMs: Math.ceil(TAKEN / (10 * S)) * 10 * S });
      return { changes: out.filter((c) => c.beforeMs >= from && c.afterMs <= to && overlap(place, LYING) > 0), ...(w.turnedAt !== undefined ? { turnedMs: w.turnedAt - 10 * S } : {}) };
    },
    people: async (t) => peopleAt(t, w.speed),
    now: () => clock,
  };
  return { sources, asked };
}

const query = (carried: boolean) => ({ place: { x: 0.42, y: 0.52, width: 0.12, height: 0.11 }, atMs: MARK, toMs: END, carried });

// ------------------------------------------------------------------ when it went, and where
{
  const { sources, asked } = world();
  const answer = await followThing(sources, query(true));
  assert.equal(answer.state, 'gone', JSON.stringify({ ...answer, pictures: undefined }));
  assert.deepEqual(answer.outline, LYING, 'the outline of the thing, not the box drawn');
  // the moment it left its place: picked up, it stays at its place for a moment (moved by less than half its width)
  assert.ok(answer.goneMs! > TAKEN && answer.goneMs! - TAKEN <= 1.5 * S, `went between ${answer.lastThereMs} and ${answer.goneMs}`);
  assert.ok(answer.goneMs! - answer.lastThereMs! <= GONE_EXACT_MS, 'to the second');
  assert.ok(!asked.some((t) => t > PASS - 10 * S && t < PASS), 'the keyframe looks found the moments: the outliner was not asked between them');
  assert.ok(asked.includes(PASS), 'the change as the person passed was looked at: the thing was still there');
  const carried = answer.carried!;
  assert.ok(carried.track.length >= 8, `followed ${carried.track.length} times`);
  assert.ok(carried.track.every((p, i) => !i || p.box.x > carried.track[i - 1].box.x), 'to the right, as it was carried');
  assert.ok(carried.leftPicture, 'out of the picture at its right edge');
  assert.ok(carried.lastSeenMs! - answer.lastThereMs! <= FOLLOW_MS);
  assert.deepEqual(carried.by && { eventId: carried.by.eventId, trackId: carried.by.trackId }, { eventId: 'ev-took', trackId: 7 }, 'carried by the one who took it, not the one who passed');
  assert.ok(answer.pictures.marked && answer.pictures.before && answer.pictures.after && answer.pictures.lastSeen);
  assert.equal(decode(answer.pictures.before!), answer.lastThereMs);
  assert.ok(answer.looks < LOOKS_MAX, `${answer.looks} pictures outlined`);

  // asked when only: nothing followed
  const { sources: s2 } = world();
  const when = await followThing(s2, query(false));
  assert.equal(when.state, 'gone');
  assert.equal(when.carried, undefined);
  assert.ok(when.looks < answer.looks);
}

// ------------------------------------------------------------------ carried fast to the left: found only in the hands
{
  // a step of 0.15 of the picture, farther than the points around where it was: the hands of the one with it find it
  const answer = await followThing(world({ speed: -0.3 }).sources, query(true));
  assert.equal(answer.state, 'gone');
  const carried = answer.carried!;
  assert.ok(carried.track.length >= 3, `followed ${carried.track.length} times`);
  assert.ok(carried.track.every((p, i) => !i || p.box.x < carried.track[i - 1].box.x), 'to the left');
  assert.ok(carried.leftPicture, 'out of the picture at its left edge');
  assert.equal(carried.by?.eventId, 'ev-took', 'the one it was with most, not the one who handed it over');
}

// ------------------------------------------------------------------ a thing like it beside it
{
  // the twin is in the box the thing is looked for in at its place: it is not the thing, its place is another
  const answer = await followThing(world({ twin: true }).sources, query(false));
  assert.equal(answer.state, 'gone', JSON.stringify({ ...answer, pictures: undefined }));
  assert.ok(answer.goneMs! > TAKEN && answer.goneMs! - TAKEN <= 1.5 * S);
}

// ------------------------------------------------------------------ the camera turned before it went
{
  // the turned picture shows another place: the thing is not there, and that is no going
  const answer = await followThing(world({ turnedAt: 2500 * S }).sources, query(true));
  assert.equal(answer.state, 'still-there', JSON.stringify({ ...answer, pictures: undefined }));
  // the last keyframe before the turn, as the place's looks give it
  assert.equal(answer.turnedMs, 2490 * S);
  assert.equal(answer.lastThereMs, 2490 * S, 'there until the camera turned');
}

// ------------------------------------------------------------------ the time of a question runs out
{
  // an outline of 12 s (the bench once, its live models busy): after the mark and one more the minute is gone, and
  // neither there nor gone can be said (it was said still there)
  const none = await followThing(world({ outlineMs: 12 * S }).sources, { ...query(true), budgetMs: 20 * S });
  assert.equal(none.state, 'cut', JSON.stringify({ ...none, pictures: undefined }));
  assert.equal(none.cut, true);
  assert.equal(none.looks, 2);
  // enough for when it went, not for all of where: what was followed is the answer, said cut
  const enough = await followThing(world({ outlineMs: 1 * S }).sources, { ...query(true), budgetMs: 30 * S });
  assert.equal(enough.state, 'gone');
  assert.equal(enough.cut, true);
  assert.ok(enough.looks <= 31, `${enough.looks} looks in 30 s of 1 s each`);
  // the default: the question of the first test took 30 looks, far within
  assert.equal(BUDGET_MS, 8 * 60_000);
}

// ------------------------------------------------------------------ the thing never went
{
  const answer = await followThing(world({ stays: true }).sources, query(true));
  assert.equal(answer.state, 'still-there');
  assert.equal(answer.lastThereMs, END, 'seen there at the end');
  assert.equal(answer.carried, undefined);
}

// ------------------------------------------------------------------ the night: the colours are not compared
{
  const answer = await followThing(world({ night: true }).sources, query(false));
  assert.equal(answer.state, 'gone', 'gray pictures: by the pattern inside the outline');
  assert.ok(answer.goneMs! > TAKEN && answer.goneMs! - TAKEN <= 1.5 * S);
}

// ------------------------------------------------------------------ nothing outlined, the outliner failing
{
  assert.equal((await followThing(world({ weakMark: true }).sources, query(true))).state, 'not-outlined');
  const none = await followThing(world({ failAfter: 0 }).sources, query(true));
  assert.deepEqual([none.state, none.problem], ['no-outliner', 'outliner gone']);
  // it fails after the mark and the first look: not taken for the thing gone
  const later = await followThing(world({ failAfter: 2 }).sources, query(false));
  assert.notEqual(later.state, 'gone', JSON.stringify({ ...later, pictures: undefined }));
  assert.equal(later.problem, 'outliner gone');
  // no recording at the mark
  const empty: ThingSources = { ...world().sources, recorded: () => [] };
  assert.equal((await followThing(empty, query(true))).state, 'no-recording');
}

// ------------------------------------------------------------------ the look inside an outline
{
  const rgb = new Uint8Array(PATCH * PATCH * 3);
  for (let i = 0; i < PATCH * PATCH; i++) {
    const left = i % PATCH < PATCH / 2;
    rgb.set(left ? [200, 20, 20] : [20, 200, 20], i * 3);
  }
  // the outline is the left half of its box: green outside it is not the thing
  const data = new Uint8Array(10 * 10);
  for (let y = 0; y < 10; y++) for (let x = 0; x < 5; x++) data[y * 10 + x] = 255;
  const look = thingLook(rgb, { width: 10, height: 10, data }, 3)!;
  assert.deepEqual(look.colour.map(Math.round), [200, 20, 20]);
  assert.equal(look.night, false);
  assert.ok(look.patch.every((v) => v === 80), 'outside the outline at the mean inside it');
  assert.equal(thingLook(rgb, { width: 10, height: 10, data: new Uint8Array(100) }, 3), undefined, 'an empty outline has no look');
  const gray = thingLook(new Uint8Array(PATCH * PATCH * 3).fill(90), { width: 10, height: 10, data }, 3)!;
  assert.equal(gray.night, true);
  assert.ok(colourDistance([0, 0, 0], [255, 255, 255]) === 1 && colourDistance([10, 10, 10], [10, 10, 10]) === 0);
  assert.ok(sameThing(RED, RED) && !sameThing(RED, TABLE));
  assert.ok(sameThing(RED, { ...RED, colour: [90, 90, 90], night: true }), 'at night by the pattern only');
  assert.ok(!sameThing(RED, { ...RED, colour: [30, 30, 200] }), 'the same pattern of another colour is another thing');
}

console.log('thing.spec: a marked thing outlined, when it went (a passer-by skipped, to the second), where it was carried and by whom, still there, the night, nothing outlined, the outliner failing — ok');
