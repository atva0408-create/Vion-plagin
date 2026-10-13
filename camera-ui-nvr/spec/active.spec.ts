// Events still going on (state "active", no end yet). One the server lost (a frame worker that crashed, an "end" that
// never came) is ended at its last update while the recorder runs, not only at the next start of the plugin.
// Run: npx tsx spec/active.spec.ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import VionNvr, { inEventRange } from '../src/index.js';
import { Store } from '../src/store.js';

import type { EventRow } from '../src/store.js';
import type { RecordedEvent } from '../src/types.js';

const dir = mkdtempSync(join(tmpdir(), 'nvr-active-'));
const NOW = Date.parse('2026-10-11T12:00:00Z');
const MINUTE = 60_000;
const active = (id: string, startTime: number, lastUpdate: number, cameraId = 'cam1') =>
  ({ id, cameraId, state: 'active', startTime, lastUpdate, types: ['person'], triggers: [], segmentIndex: 0, segments: [] }) as unknown as RecordedEvent;

// ------------------------------------------------------------------ stale ones ended while the recorder runs
{
  const store = new Store(join(dir, 'stale.db'));
  store.upsertEvent(active('live', NOW - 60 * MINUTE, NOW - 5_000));
  store.upsertEvent(active('lost', NOW - 60 * MINUTE, NOW - 20 * MINUTE));
  assert.equal(store.closeStaleActive(NOW - 10 * MINUTE), 1, 'only the one no update reached for 10 minutes');
  assert.deepEqual({ state: store.event('lost')?.state, end: store.event('lost')?.end_ms }, { state: 'ended', end: NOW - 20 * MINUTE }, 'ended at its last update');
  assert.equal(JSON.parse(store.event('lost')!.data).endTime, NOW - 20 * MINUTE);
  assert.deepEqual({ state: store.event('live')?.state, end: store.event('live')?.end_ms }, { state: 'active', end: null });
  // at the start of the plugin no event is live yet: all of them
  assert.equal(store.closeStaleActive(), 1);
  assert.equal(store.event('live')?.state, 'ended');
  // asked every minute: the few active rows are found by an index, not by reading every event (big JSON rows, and a
  // cold HDD under a full swap: seconds each time)
  const db = store.sql;
  const prepare = db.prepare.bind(db);
  let sql = '';
  db.prepare = (text: string) => prepare((sql = text));
  try {
    store.closeStaleActive(NOW);
  } finally {
    db.prepare = prepare;
  }
  const plan = (prepare(`EXPLAIN QUERY PLAN ${sql}`).all(NOW) as { detail: string }[]).map((row) => row.detail).join(' | ');
  assert.match(plan, /USING INDEX events_active/, plan);
  store.close();
}

// ------------------------------------------------------------------ a range reaches the events still going on
{
  const store = new Store(join(dir, 'range.db'));
  // running since before midnight, on two cameras; one ended before the range
  store.upsertEvent(active('since-evening', NOW - 13 * 60 * MINUTE, NOW - 1_000));
  store.upsertEvent(active('since-evening-2', NOW - 13 * 60 * MINUTE, NOW - 1_000, 'cam2'));
  store.upsertEvent({ ...active('ended-evening', NOW - 13 * 60 * MINUTE, NOW - 12 * 60 * MINUTE), state: 'ended', endTime: NOW - 12 * 60 * MINUTE } as RecordedEvent);
  // of another camera, inside the range: kept out of a query for the first one
  store.upsertEvent({ ...active('today-2', NOW - 60 * MINUTE, NOW - 50 * MINUTE, 'cam2'), state: 'ended', endTime: NOW - 50 * MINUTE } as RecordedEvent);
  const today = { startMs: NOW - 12 * 60 * MINUTE + 1, endMs: NOW, limit: 50 };
  assert.deepEqual(
    store
      .events(today)
      .map((row) => row.id)
      .sort(),
    ['since-evening', 'since-evening-2', 'today-2'],
    'an event going on since before the range is in it, one ended before is not',
  );
  assert.deepEqual(
    store.events({ ...today, cameraIds: ['cam1'] }).map((row) => row.id),
    ['since-evening'],
    'the camera still holds',
  );
  assert.deepEqual([...store.eventTypeCounts({ ...today, cameraIds: ['cam1'] })], [['person', 1]]);
  store.close();
}

// the same rule where the searches check rows themselves (by description, people who look alike)
{
  const row = (state: string, end: number | null) =>
    ({ id: 'r', camera_id: 'cam1', start_ms: NOW - 13 * 60 * MINUTE, end_ms: end, state, data: '{}', favorite: 0 }) as EventRow;
  const today = { startMs: NOW - 12 * 60 * MINUTE + 1, endMs: NOW };
  assert.equal(inEventRange(row('active', null), today), true);
  assert.equal(inEventRange(row('ended', NOW - 12 * 60 * MINUTE), today), false);
  assert.equal(inEventRange(row('active', null), { ...today, endMs: NOW - 14 * 60 * MINUTE }), false, 'a range before it began');
}

// ------------------------------------------------------------------ the recorder
const noop = () => undefined;
const nvr = new VionNvr(
  { log: noop, warn: noop, error: console.error, debug: noop, attention: noop, trace: noop } as never,
  {
    storagePath: mkdtempSync(join(tmpdir(), 'nvr-active-plugin-')),
    on: noop,
    once: noop,
    emit: noop,
    notificationManager: { publish: async () => undefined },
    coreManager: { assistantAccess: async () => ({ allowed: false }), getFFmpegPath: () => new Promise<string>(noop), getPluginsByInterface: async () => [] },
  } as never,
  { values: {}, getValue: async () => undefined, setValue: async () => undefined } as never,
);
const store = (nvr as unknown as { store: Store }).store;
const ingest = (ev: RecordedEvent, kind: 'start' | 'update' | 'end') => nvr.ingestDetectionEvent(ev.cameraId, kind as never, ev as never);

// the minute sweep: what no update reached for 10 minutes ends, what the server keeps alive goes on
await ingest(active('p-live', NOW - 30 * MINUTE, NOW - 30_000), 'start');
await ingest(active('p-lost', NOW - 30 * MINUTE, NOW - 11 * MINUTE), 'start');
(nvr as unknown as { closeStaleEvents(now: number): void }).closeStaleEvents(NOW);
assert.deepEqual(
  ['p-live', 'p-lost'].map((id) => store.event(id)?.state),
  ['active', 'ended'],
);

// ended as lost (or at a restart in the middle of it), the event the server still sends goes on: active, no end
await ingest(active('p-lost', NOW - 30 * MINUTE, NOW - 2_000), 'update');
assert.deepEqual(
  { state: store.event('p-lost')?.state, end: store.event('p-lost')?.end_ms, endTime: JSON.parse(store.event('p-lost')!.data).endTime },
  { state: 'active', end: null, endTime: undefined },
  'the end of when it was taken for lost does not stay',
);
// and its real end ends it
await ingest({ ...active('p-lost', NOW - 30 * MINUTE, NOW), state: 'ended', endTime: NOW } as RecordedEvent, 'end');
assert.deepEqual({ state: store.event('p-lost')?.state, end: store.event('p-lost')?.end_ms }, { state: 'ended', end: NOW });
// an update sent before that end and read after it does not open the event again
await ingest(active('p-lost', NOW - 30 * MINUTE, NOW - 1_000), 'update');
assert.deepEqual({ state: store.event('p-lost')?.state, end: store.event('p-lost')?.end_ms }, { state: 'ended', end: NOW });

console.log('active.spec: stale events ended, an event still sent goes on OK');
process.exit(0);
