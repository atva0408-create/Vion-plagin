// Events still going on (state "active", no end yet). One the server lost (a frame worker that crashed, an "end" that
// never came) is ended at its last update while the recorder runs, not only at the next start of the plugin.
// Run: npx tsx spec/active.spec.ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import VionNvr from '../src/index.js';
import { Store } from '../src/store.js';

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
  store.close();
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

console.log('active.spec: stale events ended OK');
process.exit(0);
