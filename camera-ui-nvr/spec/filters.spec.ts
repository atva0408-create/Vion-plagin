// Event filters of the recordings page (triggers, types, attributes, «И/ИЛИ»), detection trace storage,
// export quality and the feature flags, through the real NVR plugin class with a fake host API.
// Run: npx tsx spec/filters.spec.ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { matchesContent, matchesEvent } from '../src/filter.js';
import VionNvr from '../src/index.js';

import type { GetEventsOptions, RecordedEvent } from '../src/types.js';

const dir = mkdtempSync(join(tmpdir(), 'nvr-filters-'));
const noop = () => undefined;
const logger = { log: noop, warn: (...a: unknown[]) => console.warn('[warn]', ...a), error: console.error, debug: noop, attention: noop, trace: noop };
const api = {
  storagePath: dir,
  on: noop,
  once: noop,
  emit: noop,
  notificationManager: { publish: async () => undefined },
  coreManager: {
    assistantAccess: async () => ({ allowed: false }),
    getFFmpegPath: () => new Promise<string>(noop),
    getPluginsByInterface: async () => [],
  },
};
const storage = { values: {} as Record<string, unknown>, getValue: async () => undefined, setValue: async () => undefined };
const nvr = new VionNvr(logger as never, api as never, storage as never);

interface Spec {
  id: string;
  start: number;
  triggers?: { type: string; label?: string }[];
  labels?: string[];
  attrs?: string[];
  types?: string[];
  score?: number;
  camera?: string;
}

function event(s: Spec): RecordedEvent {
  const detections = (s.labels ?? []).map((label) => ({ label, score: s.score ?? 0.9, maxCount: 1 }));
  const attributes = (s.attrs ?? []).map((type) => ({ type, label: type === 'face' ? 'Анна' : 'A123BC77', confidence: 0.9 }));
  const triggers = (s.triggers ?? []).map((t) => ({ ...t, firstSeen: s.start, lastSeen: s.start + 1000 }));
  return {
    id: s.id,
    cameraId: s.camera ?? 'cam1',
    state: 'ended',
    startTime: s.start,
    endTime: s.start + 5000,
    lastUpdate: s.start + 5000,
    types: s.types ?? [...new Set([...triggers.map((t) => t.type), ...(s.labels ?? []), ...(s.attrs ?? [])])],
    triggers,
    segmentIndex: 0,
    segments: detections.length || attributes.length ? [{ firstSeen: s.start, lastSeen: s.start + 5000, detections, attributes }] : [],
  } as unknown as RecordedEvent;
}

const specs: Spec[] = [
  { id: 'motion-person', start: 1000, triggers: [{ type: 'motion' }], labels: ['person'] },
  { id: 'motion-person-face', start: 2000, triggers: [{ type: 'motion' }], labels: ['person'], attrs: ['face'] },
  { id: 'motion-vehicle-plate', start: 3000, triggers: [{ type: 'motion' }], labels: ['vehicle'], attrs: ['license_plate'] },
  { id: 'doorbell', start: 4000, triggers: [{ type: 'doorbell' }] },
  { id: 'audio-glass', start: 5000, triggers: [{ type: 'audio', label: 'glass_break' }] },
  { id: 'contact-person', start: 6000, triggers: [{ type: 'contact' }], labels: ['person'] },
  { id: 'motion-bird', start: 7000, triggers: [{ type: 'motion' }], labels: ['bird'] },
  { id: 'weak-person', start: 8000, triggers: [{ type: 'motion' }], labels: ['person'], score: 0.3 },
  { id: 'cam2-animal', start: 9000, triggers: [{ type: 'motion' }], labels: ['animal'], camera: 'cam2' },
];
const byId = new Map(specs.map((s) => [s.id, event(s)]));

// ------------------------------------------------------------ the matcher alone
const pick = (opts: GetEventsOptions) =>
  specs
    .map((s) => byId.get(s.id)!)
    .filter((e) => matchesContent(e, opts))
    .map((e) => e.id)
    .sort();

assert.deepEqual(pick({}), [...byId.keys()].sort(), 'no content filter: everything');
assert.deepEqual(pick({ triggers: ['doorbell', 'contact'] }), ['contact-person', 'doorbell']);
assert.deepEqual(pick({ triggers: ['audio'], triggerLabels: ['glass_break'] }), ['audio-glass']);
assert.deepEqual(pick({ triggerLabels: ['glass_break'] }), ['audio-glass'], 'audio label alone');
assert.deepEqual(pick({ attributes: ['face'] }), ['motion-person-face']);
assert.deepEqual(pick({ attributes: ['face', 'license_plate'] }), ['motion-person-face', 'motion-vehicle-plate'], 'values of one group: any of them');
assert.deepEqual(pick({ types: ['__other__'] }), ['motion-bird'], '«Другое»: types the filter bar does not name');
// triggers ⟷ types
assert.deepEqual(pick({ triggers: ['contact'], types: ['person'], filterLogicTriggers: 'and' }), ['contact-person']);
assert.deepEqual(
  pick({ triggers: ['contact'], types: ['person'], filterLogicTriggers: 'or' }),
  ['contact-person', 'motion-person', 'motion-person-face', 'weak-person'],
);
assert.deepEqual(pick({ triggers: ['contact'], types: ['person'] }), pick({ triggers: ['contact'], types: ['person'], filterLogicTriggers: 'or' }), 'default is «ИЛИ»');
// types ⟷ attributes
assert.deepEqual(pick({ types: ['person'], attributes: ['face'], filterLogicAttributes: 'and' }), ['motion-person-face']);
assert.deepEqual(
  pick({ types: ['vehicle'], attributes: ['face'], filterLogicAttributes: 'or' }),
  ['motion-person-face', 'motion-vehicle-plate'],
);
// «И» binds tighter than «ИЛИ»: doorbell OR (person AND face)
assert.deepEqual(
  pick({ triggers: ['doorbell'], types: ['person'], attributes: ['face'], filterLogicTriggers: 'or', filterLogicAttributes: 'and' }),
  ['doorbell', 'motion-person-face'],
);
// (motion AND person) OR plate
assert.deepEqual(
  pick({ triggers: ['motion'], types: ['person'], attributes: ['license_plate'], filterLogicTriggers: 'and', filterLogicAttributes: 'or' }),
  ['motion-person', 'motion-person-face', 'motion-vehicle-plate', 'weak-person'],
);
// the camera tab sends types and attributes without a logic: «ИЛИ»
assert.deepEqual(pick({ types: [], attributes: ['license_plate'] }), ['motion-vehicle-plate'], 'camera tab: only «Номерной знак»');

// confidence rules out weak detections, never events without any scored detection (sensor triggers)
assert.equal(matchesEvent(byId.get('weak-person')!, { minConfidence: 0.5 }), false);
assert.equal(matchesEvent(byId.get('doorbell')!, { minConfidence: 0.5, triggers: ['doorbell'] }), true);
// hidden types per camera: hidden when nothing else was seen
assert.equal(matchesEvent(byId.get('cam2-animal')!, { hiddenTypes: { cam2: ['animal'] } }), false);
assert.equal(matchesEvent(byId.get('motion-person-face')!, { hiddenTypes: { cam1: ['person'] } }), true, 'the face is not hidden');
assert.equal(matchesEvent(byId.get('doorbell')!, { hiddenTypes: { cam1: ['doorbell'] } }), false);

// --------------------------------------------------------- through the plugin
for (const s of specs) await nvr.ingestDetectionEvent(s.camera ?? 'cam1', 'end' as never, byId.get(s.id) as never);
// filler events: a selective filter must scan past a full batch of non-matching rows
for (let i = 0; i < 450; i++) await nvr.ingestDetectionEvent('cam1', 'end' as never, event({ id: `filler-${i}`, start: 10_000 + i, labels: ['vehicle'] }) as never);

const ids = (r: { events: RecordedEvent[] }) => r.events.map((e) => e.id);
// the recordings page sends hasDetections only without a content filter; confidence 0.5 is its default
const page = (opts: GetEventsOptions) => nvr.getEvents({ minConfidence: 0.5, ...opts });

assert.deepEqual(ids(await page({ triggers: ['doorbell'], limit: 10 })), ['doorbell'], 'trigger filter, below 450 newer events');
assert.deepEqual(ids(await page({ attributes: ['face'], limit: 10 })), ['motion-person-face']);
assert.deepEqual(ids(await page({ triggers: ['contact'], types: ['person'], filterLogicTriggers: 'and', limit: 10 })), ['contact-person']);
assert.deepEqual(ids(await page({ triggers: ['doorbell'], types: ['person'], attributes: ['face'], filterLogicAttributes: 'and', limit: 10 })), [
  'doorbell',
  'motion-person-face',
]);
assert.deepEqual(ids(await nvr.getCameraEvents(['cam1'], { types: [], attributes: ['license_plate'], limit: 10 })), ['motion-vehicle-plate']);
assert.deepEqual(ids(await page({ types: ['__other__'], limit: 10 })), ['motion-bird']);

// paging through a filtered list: every page continues before the last event of the previous one
const first = await page({ types: ['vehicle'], limit: 200 });
assert.equal(first.events.length, 200);
assert.equal(first.hasMore, true);
const second = await page({ types: ['vehicle'], limit: 200, before: first.events.at(-1)!.startTime });
const third = await page({ types: ['vehicle'], limit: 200, before: second.events.at(-1)!.startTime });
assert.equal(third.hasMore, false);
assert.equal(new Set([...ids(first), ...ids(second), ...ids(third)]).size, 451, '450 fillers + 1 vehicle event, no duplicates');

// stats follow the same filter
const stats = await nvr.getEventStats([], { attributes: ['face', 'license_plate'] });
assert.equal(stats.total, 2);
assert.equal(stats.capped, false);

// ------------------------------------------------------------- detection trace
const traced = event({ id: 'traced', start: 50_000, labels: ['person'] });
const tick = (tMs: number) => ({ tMs, src: 'low', objectRan: true, detections: [], world: [{ id: 1, label: 'person', conf: 0.9, state: 'active', speed: 0, box: [0, 0, 1, 1] }], events: [] });
await nvr.ingestDetectionEvent('cam1', 'update' as never, { ...traced, state: 'active' } as never, { trace: [tick(50_000), tick(50_500)] } as never);
await nvr.ingestDetectionEvent('cam1', 'end' as never, traced as never, { trace: [tick(51_000), tick(51_500), tick(52_000)] } as never);
const trace = await nvr.getEventTrace('traced', 0, 2);
assert.equal(trace.total, 5);
assert.deepEqual(
  trace.ticks.map((t) => t.tMs),
  [50_000, 50_500],
);
assert.deepEqual(
  (await nvr.getEventTrace('traced', 3)).ticks.map((t) => t.tMs),
  [51_500, 52_000],
);
assert.equal(await nvr.getEventTraceOffset('traced', 51_000), 2);
assert.equal(await nvr.getEventTraceOffset('traced', 99_000), 5);
assert.equal((await nvr.getEventTrace('no-such-event')).total, 0);
// no recording for the trace times: no frames, and the UI shows the trace without pictures
assert.equal((await nvr.nvrTraceFrames('cam1', [{ tMs: 50_000, src: 'low' }], 'keyframe')).noData, true);
await nvr.deleteEvents(['traced']);
assert.equal((await nvr.getEventTrace('traced')).total, 0, 'the trace goes with its event');

// --------------------------------------------------------------- export quality
const store = (nvr as unknown as { store: { addSegment(row: Record<string, unknown>): number } }).store;
const seg = (role: string, bytes: number) =>
  store.addSegment({
    camera_id: 'cam9',
    role,
    start_us: 1_000_000_000,
    end_us: 1_060_000_000,
    path: join(dir, `${role}.ts`),
    bytes,
    codec: 'h264',
    codec_string: 'avc1.64001f',
    width: 1920,
    height: 1080,
    video_pid: 256,
    audio_pid: -1,
    keyframes: '[[0,1000000000]]',
  });
seg('high', 60_000_000);
seg('low', 6_000_000);
const slices = [{ day: '1970-01-01', startUs: 1_000_000_000, endUs: 1_060_000_000 }];
assert.equal((await nvr.nvrExportEstimate({ cameras: ['cam9'], slices, quality: 'best' })).totalBytes, 60_000_000);
assert.equal((await nvr.nvrExportEstimate({ cameras: ['cam9'], slices, quality: 'smallest' })).totalBytes, 6_000_000);
assert.equal((await nvr.nvrExportEstimate({ cameras: ['cam9'], slices })).totalBytes, 60_000_000, 'default: best');

// ---------------------------------------------------------------- feature flags
assert.deepEqual(await nvr.getNvrFeatures(), { episodes: false, exportQuality: true });

console.log('filters.spec: event filters, trace, export quality and features OK');
process.exit(0);
