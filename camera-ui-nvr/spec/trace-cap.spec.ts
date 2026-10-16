// The size of the database of the recorder: its detection traces are most of it (744 thousand rows, 1.2 of 1.41 GB on
// the bench, 2026-10-16), and the traces of the events whose video is still there were never cleared. Over the size set
// (Storage → «Предел базы событий, ГБ»), the retention clears the traces of the oldest events, a portion a pass; the
// events stay. The size is read from the pages in use, not counted (a count of the trace took 285 s on the bench).
// Run: npx tsx spec/trace-cap.spec.ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import VionNvr from '../src/index.js';

import type { RecordedEvent } from '../src/types.js';

// the disk as the plugin sees it, half free: the free-space guard reads the disk that runs the test otherwise
fsp.statfs = (async () => ({ blocks: 1000, bavail: 500, bsize: 4096 })) as unknown as typeof fsp.statfs;
syncBuiltinESMExports();

const noop = () => undefined;
const logged: string[] = [];
const logger = { log: (m: string) => void logged.push(m), warn: noop, error: console.error, debug: noop, attention: noop, trace: noop };
const api = {
  storagePath: mkdtempSync(join(tmpdir(), 'nvr-trace-cap-')),
  on: noop,
  once: noop,
  emit: noop,
  notificationManager: { publish: async () => undefined },
  coreManager: { assistantAccess: async () => ({ allowed: false }), getFFmpegPath: () => new Promise<string>(noop), getPluginsByInterface: async () => [] },
  proxy: { createProxy: () => ({}) },
};
const storage = { values: { retentionDays: 90, minFreePercent: 5, quotaGB: 0 } as Record<string, unknown>, getValue: async () => undefined, setValue: async () => undefined };
const nvr = new VionNvr(logger as never, api as never, storage as never);
type Store = {
  upsertEvent(event: RecordedEvent): void;
  event(id: string): unknown;
  addTrace(eventId: string, ticks: { tMs: number }[]): void;
  traceCount(eventId: string): number;
  usedBytes(): number;
};
const internals = nvr as unknown as { store: Store; enforceRetention(): Promise<void>; ready: Promise<void> };
await internals.ready;
const store = internals.store;

// 400 events of a camera with no video (the rule of the oldest video keeps them all), traces of 6 MB in all; the
// retention clears a portion of 100 events at a time, so a size over the first quarter keeps the rest
const T = Date.now() - 24 * 3_600_000;
const tick = (t: number) => ({ tMs: t, boxes: 'x'.repeat(300) });
const N = 400;
const idOf = (i: number) => `e${String(i).padStart(3, '0')}`;
for (let i = 0; i < N; i++) {
  const id = idOf(i);
  const start = T + i * 30_000;
  store.upsertEvent({ id, cameraId: 'cam', state: 'ended', startTime: start, endTime: start + 30_000, lastUpdate: start + 30_000, types: ['person'], segments: [] } as unknown as RecordedEvent);
  store.addTrace(id, Array.from({ length: 50 }, (_, n) => tick(start + n * 500)));
}
const used = store.usedBytes();
assert.ok(used > 2_000_000, `the database holds the traces: ${used}`);

// no size set: 1 GB, far over this database, nothing goes
assert.equal((nvr as unknown as { traceCapBytes(): number }).traceCapBytes(), 1e9);
await internals.enforceRetention();
assert.equal(store.traceCount(idOf(0)), 50);

// a size under what is used: the traces of the oldest events go, the newest stay, the events stay
const cap = used - 1_200_000;
storage.values.traceCapGB = cap / 1e9;
for (let pass = 0; pass < 10 && store.usedBytes() > cap; pass++) await internals.enforceRetention();
assert.ok(store.usedBytes() <= cap, `${store.usedBytes()} over ${cap}`);
assert.equal(store.traceCount(idOf(0)), 0, 'the oldest first');
assert.equal(store.traceCount(idOf(N - 1)), 50, 'the newest stay');
assert.ok(store.event(idOf(0)), 'the event stays');
const left = Array.from({ length: N }, (_, i) => store.traceCount(idOf(i)));
assert.ok(left.filter((n) => n > 0).length >= N / 2, `no more than a portion over: ${left.filter((n) => n > 0).length} kept`);
const firstKept = left.findIndex((n) => n > 0);
assert.ok(left.slice(firstKept).every((n) => n === 50), `cleared from the oldest on, no hole: ${left.join(',')}`);
assert.ok(logged.some((m) => /traces of \d+ oldest events cleared/.test(m)), logged.join('\n'));
// within the size: the next pass takes nothing
const before = left.reduce((a, b) => a + b, 0);
await internals.enforceRetention();
assert.equal(
  Array.from({ length: N }, (_, i) => store.traceCount(idOf(i))).reduce((a, b) => a + b, 0),
  before,
);

// the oldest events with a trace are found from indexes, not from the rows of the events (cold on the bench's HDD)
const db = (store as unknown as { db: { prepare(sql: string): { all(...args: unknown[]): { detail: string }[] } } }).db;
const plan = db
  .prepare(`EXPLAIN QUERY PLAN ${(store as unknown as { oldestTracedSql: string }).oldestTracedSql}`)
  .all(100)
  .map((row) => row.detail)
  .join(' | ');
assert.match(plan, /USING COVERING INDEX events_state_time/, plan);
assert.match(plan, /USING INDEX event_trace_event|USING COVERING INDEX event_trace_event/, plan);
assert.doesNotMatch(plan, /TEMP B-TREE/, plan);

console.log('trace-cap.spec: over the size set the traces of the oldest events go, the events stay, nothing more once within — ok');
process.exit(0);
