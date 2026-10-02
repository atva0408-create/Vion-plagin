// The numbers of the recordings page and of the storage page, through the real plugin class on a fixed fixture: the
// «has a recording» of an event is one look at the index instead of a walk over the camera's archive, the event
// counts of a filter that does not look into the events are read by the database instead of every event being
// parsed, and the storage statistics sum the archive once. What they answer is what it was: the numbers of this
// fixture were taken from the code before the change and are written down here.
// Run: npx tsx spec/stats.spec.ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import VionNvr from '../src/index.js';

import type { Store } from '../src/store.js';
import type { GetEventsOptions, RecordedEvent } from '../src/types.js';

const disk = { blocks: 1000, bavail: 500, bsize: 4096 };
fsp.statfs = (async () => disk) as unknown as typeof fsp.statfs;
syncBuiltinESMExports();

// a fixed clock: an event still going on is recorded «until now»
const NOW = Date.UTC(2026, 8, 1, 12, 0, 0);
Date.now = () => NOW;
const HOUR = 3600_000;
const T0 = NOW - 6 * HOUR;
const noop = () => undefined;

type Stats = Awaited<ReturnType<VionNvr['getEventStats']>>;
interface Internals {
  cameras: Map<string, unknown>;
  store: Store;
  queryEvents(cameraIds: string[] | undefined, opts: GetEventsOptions, limit: number, scanRows: number): { events: RecordedEvent[]; hasMore: boolean };
}
function start(cameras: Record<string, string[]>): { nvr: VionNvr; internals: Internals } {
  const api = {
    storagePath: mkdtempSync(join(tmpdir(), 'nvr-stats-')),
    on: noop,
    once: noop,
    emit: noop,
    notificationManager: { publish: async () => undefined },
    coreManager: { assistantAccess: async () => ({ allowed: false }), getFFmpegPath: () => new Promise<string>(noop), getPluginsByInterface: async () => [] },
  };
  const storage = { values: {} as Record<string, unknown>, getValue: async () => undefined, setValue: async () => undefined };
  const nvr = new VionNvr({ log: noop, warn: noop, error: console.error, debug: noop, attention: noop, trace: noop } as never, api as never, storage as never);
  const internals = nvr as unknown as Internals;
  // the roles a camera records decide which stream «has a recording» looks at
  for (const [id, roles] of Object.entries(cameras)) {
    internals.cameras.set(id, { device: { id, name: id }, recorders: new Map(roles.map((role) => [role, { isRecording: false }])), subscriptions: [] });
  }
  return { nvr, internals };
}

let seed = 20261002;
const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = <T>(list: T[]): T => list[Math.floor(random() * list.length)];

function recording(store: Store, camera: string, role: string, startMs: number, endMs: number, bytes = 1_000_000): void {
  store.addSegment({
    camera_id: camera,
    role,
    start_us: startMs * 1000,
    end_us: endMs * 1000,
    path: `${camera}-${startMs}.ts`,
    bytes,
    codec: 'h264',
    codec_string: 'avc1.640028',
    width: 1920,
    height: 1080,
    video_pid: 256,
    audio_pid: -1,
    keyframes: '[[0,0]]',
  });
}

// ------------------------------------------------------------------ the fixture: six hours of four cameras

const { nvr, internals } = start({ a: ['high', 'low'], b: ['high'], c: [], d: ['low'] });
const store = internals.store;
store.sql.exec('BEGIN');
// a: recorded all the time but for half an hour from 3:00; a file left by a clock that was set (2:50–3:10) reaches
// into that pause from before the files that end at it
for (let t = T0; t < NOW; t += 60_000) if (t < T0 + 3 * HOUR || t >= T0 + 3.5 * HOUR) recording(store, 'a', 'high', t, t + 60_000);
recording(store, 'a', 'high', T0 + 2 * HOUR + 50 * 60_000, T0 + 3 * HOUR + 10 * 60_000);
// d records its low stream only, for the first two hours; what lies under another role does not count for it
for (let t = T0; t < T0 + 2 * HOUR; t += 60_000) recording(store, 'd', 'low', t, t + 60_000);
for (let t = T0 + 4 * HOUR; t < T0 + 5 * HOUR; t += 60_000) recording(store, 'd', 'high', t, t + 60_000);

const TYPES = [['person'], ['vehicle'], ['person', 'vehicle'], ['motion'], ['animal'], ['person', 'person'], []];
const SCORES = [0.21, 0.35, 0.5, 0.62, 0.77, 0.9, 0.99, 0, undefined, '0.8'];
let previous = T0;
for (let i = 0; i < 7000; i++) {
  const cameraId = pick(['a', 'a', 'a', 'b', 'b', 'c', 'd']);
  // on a grid of seconds, and every tenth event in the same second as the one before it: many equal start times
  const startTime = i % 10 === 9 ? previous : T0 + Math.floor(random() * 6 * 3600) * 1000;
  previous = startTime;
  const active = random() < 0.02;
  const endTime = startTime + 1000 + Math.floor(random() * 30) * 1000;
  const types = pick(TYPES);
  const segments = Array.from({ length: Math.floor(random() * 4) }, (_, s) => ({
    firstSeen: startTime + s * 1000,
    lastSeen: startTime + s * 1000 + 900,
    detections: Array.from({ length: Math.floor(random() * 3) }, () => {
      const score = pick(SCORES);
      return { label: pick(['person', 'vehicle', 'cat']), ...(score === undefined ? {} : { score }), box: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } };
    }),
    attributes: random() < 0.2 ? [{ type: 'face', label: 'unknown', confidence: 0.7 }] : [],
  }));
  const event = {
    id: `e${i}`,
    cameraId,
    state: active ? 'active' : 'ended',
    startTime,
    ...(active ? {} : { endTime }),
    lastUpdate: endTime,
    types,
    triggers: random() < 0.3 ? [{ type: 'motion' }] : [],
    segmentIndex: 0,
    segments,
    ...(random() < 0.1 ? { ai: { title: 'A vehicle stops', description: 'A vehicle stops at the gate.', tags: ['vehicle'], at: endTime } } : {}),
  } as unknown as RecordedEvent;
  store.upsertEvent(event, random() < 0.05);
  // b records around a third of its events
  if (cameraId === 'b' && i % 3 === 0) recording(store, 'b', 'high', startTime - 5000, endTime + 10_000);
}
store.sql.exec('COMMIT');

// ------------------------------------------------------------------ «has a recording»: the same answer as reading the files of the range

{
  let asked = 0;
  for (const [camera, role] of [['a', 'high'], ['b', 'high'], ['c', 'high'], ['d', 'low'], ['d', 'high'], ['a', 'low']] as const) {
    for (let i = 0; i < 1500; i++) {
      const startUs = (T0 - HOUR + Math.floor(random() * 8 * 3600) * 1000) * 1000;
      const endUs = startUs + Math.floor(random() * 120) * 1_000_000;
      assert.equal(store.hasSegments(camera, role, startUs, endUs), store.segments(camera, role, startUs, endUs).length > 0, `${camera}/${role} ${startUs}…${endUs}`);
      asked++;
    }
  }
  assert.equal(asked, 9000);
  // the pause of a: reached only by the file that started before the last files in front of it
  const inPause = (T0 + 3 * HOUR + 5 * 60_000) * 1000;
  assert.equal(store.segments('a', 'high', inPause, inPause + 1_000_000).length, 1);
  assert.equal(store.hasSegments('a', 'high', inPause, inPause + 1_000_000), true, 'a file that starts earlier than the last one before the range still counts');
  assert.equal(store.hasSegments('a', 'high', inPause + 10 * 60_000_000, inPause + 11 * 60_000_000), false, 'nothing in the rest of the pause');
  // the edges of a file belong to it, as they do for `segments()`
  assert.equal(store.hasSegments('d', 'low', (T0 + 2 * HOUR) * 1000, (T0 + 3 * HOUR) * 1000), true);
  assert.equal(store.hasSegments('d', 'low', (T0 + 2 * HOUR) * 1000 + 1, (T0 + 3 * HOUR) * 1000), false);
  assert.equal(store.hasSegments('d', 'low', (T0 - HOUR) * 1000, T0 * 1000), true);
  assert.equal(store.hasSegments('d', 'low', (T0 - HOUR) * 1000, T0 * 1000 - 1), false);
}

// ------------------------------------------------------------------ the counts of events

// The answers of the code before the change on this fixture (every event parsed, every recording looked up by
// reading its files): for the cases below in their order, for the hundred thousand events, for the storage page.
// NVR_STATS_PRINT=1 prints the three tables instead of checking them, to take them from the code as it is.
const PRINT = !!process.env.NVR_STATS_PRINT;
const BEFORE: Stats[] = [
  { total: 5001, segments: 8849, episodes: 0, byType: { person: 2827, vehicle: 1329, animal: 684, motion: 877 }, capped: true },
  { total: 2888, segments: 6356, episodes: 0, byType: { person: 1656, vehicle: 929, motion: 451, animal: 386 }, capped: false },
  { total: 1658, segments: 3785, episodes: 0, byType: { person: 945, vehicle: 526, motion: 266, animal: 221 }, capped: false },
  { total: 2968, segments: 5124, episodes: 0, byType: { person: 1670, vehicle: 780, motion: 515, animal: 389 }, capped: false },
  { total: 4462, segments: 9434, episodes: 0, byType: { person: 2520, vehicle: 1290, motion: 745, animal: 598 }, capped: false },
  { total: 5005, segments: 8808, episodes: 0, byType: { person: 2800, vehicle: 1375, animal: 626, motion: 904 }, capped: true },
  { total: 869, segments: 2039, episodes: 0, byType: { vehicle: 203, person: 443, motion: 166, animal: 165 }, capped: false },
  { total: 5006, segments: 8863, episodes: 0, byType: { person: 2865, vehicle: 1422, animal: 737, motion: 730 }, capped: true },
  { total: 359, segments: 602, episodes: 0, byType: { animal: 48, person: 191, vehicle: 89, motion: 61 }, capped: false },
  { total: 0, segments: 0, episodes: 0, byType: {}, capped: false },
  { total: 344, segments: 593, episodes: 0, byType: { person: 164, vehicle: 75, motion: 69, animal: 48 }, capped: false },
  { total: 167, segments: 257, episodes: 0, byType: { motion: 11, animal: 28, vehicle: 59, person: 59 }, capped: false },
  { total: 917, segments: 1579, episodes: 0, byType: { vehicle: 246, animal: 163, person: 402, motion: 159 }, capped: false },
  { total: 851, segments: 1793, episodes: 0, byType: { vehicle: 248, person: 465, animal: 110, motion: 122 }, capped: false },
  { total: 1563, segments: 3386, episodes: 0, byType: { person: 885, vehicle: 455, motion: 291, animal: 193 }, capped: false },
  { total: 3116, segments: 5584, episodes: 0, byType: { person: 1779, vehicle: 928, animal: 477, motion: 433 }, capped: false },
  { total: 4337, segments: 8364, episodes: 0, byType: { person: 3907, vehicle: 1321, motion: 418, animal: 317 }, capped: false },
  { total: 1192, segments: 2768, episodes: 0, byType: { person: 945, vehicle: 383, motion: 137, animal: 105 }, capped: false },
  { total: 1971, segments: 4564, episodes: 0, byType: { person: 1257, motion: 313, vehicle: 538, animal: 268 }, capped: false },
  { total: 1183, segments: 2412, episodes: 0, byType: { person: 560, vehicle: 653, motion: 133, animal: 112 }, capped: false },
  { total: 553, segments: 817, episodes: 0, byType: { animal: 137, motion: 70, person: 294, vehicle: 138 }, capped: false },
  { total: 4613, segments: 8382, episodes: 0, byType: { person: 2252, vehicle: 1434, animal: 752, motion: 735 }, capped: false },
];
const BIG_BEFORE: Stats[] = [
  { total: 5000, segments: 5000, episodes: 0, byType: { motion: 5000 }, capped: true },
  { total: 25, segments: 25, episodes: 0, byType: { motion: 25 }, capped: true },
  { total: 0, segments: 0, episodes: 0, byType: {}, capped: false },
  { total: 1, segments: 1, episodes: 0, byType: { motion: 1 }, capped: false },
  { total: 100, segments: 100, episodes: 0, byType: { motion: 100 }, capped: true },
  { total: 0, segments: 0, episodes: 0, byType: {}, capped: false },
];
const STORAGE_BEFORE = { nvrUsedGB: 1.07, a: { usedBytes: 331000000, segmentCount: 331 }, d: { usedBytes: 180000000, segmentCount: 180 } };

const afternoon = { startMs: T0 + 2 * HOUR, endMs: T0 + 4 * HOUR };
const page = { hasDetections: true, withRecordingInfo: true, hasRecording: true };
const CASES: [string, 'counted' | 'parsed', string[], GetEventsOptions][] = [
  ['everything', 'counted', [], {}],
  ['the recordings page as it opens', 'parsed', [], { ...page, minConfidence: 0.5 }],
  ['the recordings page, one camera', 'parsed', ['a'], { ...page, minConfidence: 0.5 }],
  ['two cameras', 'counted', ['b', 'c'], {}],
  ['with detections', 'parsed', [], { hasDetections: true }],
  ['confident ones', 'parsed', [], { minConfidence: 0.5 }],
  ['with detections, very confident', 'parsed', ['a', 'b'], { hasDetections: true, minConfidence: 0.95 }],
  ['with a recording', 'counted', [], { hasRecording: true }],
  ['with a recording, the low stream of d', 'counted', ['d'], { hasRecording: true, withRecordingInfo: true }],
  ['with a recording that is not looked up', 'counted', [], { hasRecording: true, withRecordingInfo: false }],
  ['favourites', 'counted', [], { favoritesOnly: true }],
  ['still going on, with a recording', 'counted', [], { state: 'active', hasRecording: true }],
  ['two hours', 'counted', ['a'], afternoon],
  ['two hours of the page', 'parsed', [], { ...page, ...afternoon }],
  ["since four o'clock", 'parsed', [], { startedSinceMs: T0 + 4 * HOUR, hasDetections: true }],
  ['hidden types of no camera', 'counted', ['a'], { hiddenTypes: { a: [], b: [] } }],
  ['people', 'parsed', [], { types: ['person'] }],
  ['people on the page', 'parsed', ['a'], { ...page, types: ['person'], minConfidence: 0.5 }],
  ['faces', 'parsed', [], { attributes: ['face'] }],
  ['motion sensors and vehicles', 'parsed', [], { triggers: ['motion'], types: ['vehicle'], filterLogicTriggers: 'and' }],
  ['a search', 'parsed', [], { search: 'vehicle stops' }],
  ['hidden types', 'parsed', ['a', 'b'], { hiddenTypes: { a: ['person'] } }],
];
const counted: Stats[] = [];
for (const [, , cameras, opts] of CASES) counted.push(await nvr.getEventStats(cameras, opts));
if (PRINT) console.log(`const BEFORE: Stats[] = ${JSON.stringify(counted)};`);
for (const [i, [name]] of PRINT ? [] : CASES.entries()) {
  assert.deepEqual(counted[i], BEFORE[i], `${name}: the numbers are what they were`);
  assert.deepEqual(Object.keys(counted[i].byType), Object.keys(BEFORE[i].byType), `${name}: the types in the order they were`);
}
assert.ok(counted[0].capped && counted[0].total >= 5000, 'the fixture has more events than are counted');
assert.ok(counted[1].total > 500 && counted[1].total < counted[4].total, 'and the filters of the page leave a part of them');

// ------------------------------------------------------------------ a hundred thousand events: where the scan ends

const big = start({ x: ['high'] });
{
  const insert = big.internals.store.sql.prepare('INSERT INTO events (id, camera_id, start_ms, end_ms, state, data, favorite) VALUES (?, ?, ?, ?, ?, ?, 0)');
  big.internals.store.sql.exec('BEGIN');
  const B0 = NOW - 30 * 24 * HOUR;
  for (let i = 0; i < 101_500; i++) {
    // a second apart, but for five in the same second where a page of 2000 ends; one in 4000 has a detection
    const fromNewest = 101_499 - i;
    const startTime = B0 + (fromNewest >= 1997 && fromNewest <= 2001 ? 101_499 - 1997 : i) * 1000;
    const segments = i % 4000 === 7 ? [{ firstSeen: startTime, lastSeen: startTime, detections: [{ label: 'person', score: 0.9 }], attributes: [] }] : [];
    const event = { id: `x${i}`, cameraId: 'x', state: 'ended', startTime, endTime: startTime + 500, lastUpdate: startTime + 500, types: ['motion'], triggers: [], segments };
    insert.run(event.id, 'x', startTime, event.endTime, 'ended', JSON.stringify(event));
    // and one in 4000 a recording, which the three events next to it share
    if (i % 4000 === 11) recording(big.internals.store, 'x', 'high', startTime - 1000, startTime + 2000);
  }
  big.internals.store.sql.exec('COMMIT');
}
const BIG_CASES: [string, GetEventsOptions][] = [
  ['everything', {}],
  ['the few with a detection', { hasDetections: true }],
  ['none confident enough', { hasDetections: true, minConfidence: 0.95 }],
  ['the oldest hour', { endMs: NOW - 30 * 24 * HOUR + HOUR, hasDetections: true }],
  ['the few with a recording', { hasRecording: true }],
  ['with a recording, none going on', { hasRecording: true, state: 'active' }],
];
const bigCounted: Stats[] = [];
for (const [, opts] of BIG_CASES) bigCounted.push(await big.nvr.getEventStats([], opts));
if (PRINT) console.log(`const BIG_BEFORE: Stats[] = ${JSON.stringify(bigCounted)};`);
for (const [i, [name]] of PRINT ? [] : BIG_CASES.entries()) assert.deepEqual(bigCounted[i], BIG_BEFORE[i], `100 000 events, ${name}: the numbers are what they were`);
assert.equal(bigCounted[0].total >= 5000 && bigCounted[0].capped, true);
assert.equal(bigCounted[1].capped, true, 'the scan of a rare kind of event stops after 100 000 events and says so');
assert.equal(bigCounted[2].total, 0);
assert.deepEqual([bigCounted[4].total, bigCounted[4].capped], [100, true], 'also when the database counts');

// ------------------------------------------------------------------ the storage statistics

{
  const stats = await nvr.getStorageStats();
  const of = (camera: string) => ({ usedBytes: stats.cameras[camera].usedBytes, segmentCount: stats.cameras[camera].segmentCount });
  const shown = { nvrUsedGB: stats.nvrUsedGB, a: of('a'), d: of('d') };
  if (PRINT) console.log(`const STORAGE_BEFORE = ${JSON.stringify(shown)};`);
  else assert.deepEqual(shown, STORAGE_BEFORE, 'the size of the archive is what it was');
  assert.equal(stats.nvrUsedGB, Math.round((store.totalBytes() / 1024 ** 3) * 100) / 100);
}
if (PRINT) process.exit(0);

// ------------------------------------------------------------------ and how they are counted now

{
  // no event is parsed for a count the database can make, and no recording is read for any count
  const queryEvents = internals.queryEvents.bind(internals);
  const segments = store.segments.bind(store);
  const totalBytes = store.totalBytes.bind(store);
  const calls = { queryEvents: 0, segments: 0, totalBytes: 0 };
  internals.queryEvents = (...args) => (calls.queryEvents++, queryEvents(...args));
  store.segments = (...args) => (calls.segments++, segments(...args));
  store.totalBytes = () => (calls.totalBytes++, totalBytes());
  for (const [name, how, cameras, opts] of CASES) {
    calls.queryEvents = 0;
    await nvr.getEventStats(cameras, opts);
    // a filter that looks into the events (detections, confidence, types, a search…) has them parsed, as before
    assert.equal(calls.queryEvents, how === 'parsed' ? 1 : 0, `${name}: ${how === 'parsed' ? 'the events are parsed for this filter' : 'counted by the database, no event is parsed'}`);
    assert.equal(calls.segments, 0, `${name}: no recording is read to know that there is one`);
  }
  assert.equal(CASES.filter(([, how]) => how === 'counted').length, 9);
  // a page of events with «has a recording» reads no recording either
  calls.queryEvents = 0;
  const listed = await nvr.getEvents({ limit: 40, withRecordingInfo: true });
  assert.equal(listed.events.length >= 40 && calls.segments === 0, true, 'a page of events is told about its recordings by the index alone');
  assert.ok(listed.events.some((e) => e.hasRecording) && listed.events.some((e) => !e.hasRecording));
  // the archive is summed once for the storage page
  await nvr.getStorageStats();
  assert.equal(calls.totalBytes, 0, 'the storage statistics sum the archive in the pass that reads the cameras');
}

console.log('stats.spec: event counts, recording lookups and storage statistics answer what they did before; recordings found by the index, plain counts made by the database — ok');
process.exit(0);
