// The detection trace of an event is drawn over its recording; the free-space guard and the quota delete the oldest
// video long before the events go by their days (bench 2026-10-14: 969 MB of traces, a week older than the video the
// full disk kept). Retention now deletes the trace of a camera's events that ended before the oldest video left of that
// camera; the events themselves stay. A camera with no video at all keeps its traces (nothing tells what was there).
// Run: npx tsx spec/trace-retention.spec.ts
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import VionNvr from '../src/index.js';

import type { RecordedEvent } from '../src/types.js';

// the disk as the plugin sees it, half free: the free-space guard of the plugin (1 % at the least) read the disk that
// ran the test, and on one 96 % full it deleted every segment
fsp.statfs = (async () => ({ blocks: 1000, bavail: 500, bsize: 4096 })) as unknown as typeof fsp.statfs;
syncBuiltinESMExports();

const noop = () => undefined;
const logger = { log: noop, warn: noop, error: console.error, debug: noop, attention: noop, trace: noop };
const storagePath = mkdtempSync(join(tmpdir(), 'nvr-trace-retention-'));
const api = {
  storagePath,
  on: noop,
  once: noop,
  emit: noop,
  notificationManager: { publish: async () => undefined },
  coreManager: { assistantAccess: async () => ({ allowed: false }), getFFmpegPath: () => new Promise<string>(noop), getPluginsByInterface: async () => [] },
  proxy: { createProxy: () => ({}) },
};
// the quota alone decides here, events kept by their days
const storage = { values: { retentionDays: 90, minFreePercent: 5, quotaGB: 1 } as Record<string, unknown>, getValue: async () => undefined, setValue: async () => undefined };
const nvr = new VionNvr(logger as never, api as never, storage as never);
type Store = {
  addSegment(row: Record<string, unknown>): number;
  segment(id: number): unknown;
  upsertEvent(event: RecordedEvent): void;
  event(id: string): unknown;
  addTrace(eventId: string, ticks: { tMs: number }[]): void;
  traceCount(eventId: string): number;
};
const internals = nvr as unknown as { store: Store; enforceRetention(): Promise<void>; ready: Promise<void> };
await internals.ready;
const store = internals.store;

const HOUR = 3_600_000;
const T = Date.now() - 48 * HOUR;
const dir = join(storagePath, 'files');
mkdirSync(dir, { recursive: true });
function segment(cameraId: string, startMs: number, bytes: number): number {
  const path = join(dir, `${cameraId}-${startMs}.ts`);
  writeFileSync(path, 'x');
  return store.addSegment({
    camera_id: cameraId,
    role: 'high',
    start_us: startMs * 1000,
    end_us: (startMs + HOUR) * 1000,
    path,
    bytes,
    codec: 'h264',
    codec_string: 'avc1.64000d',
    width: 320,
    height: 240,
    video_pid: 256,
    audio_pid: -1,
    keyframes: JSON.stringify([[0, startMs * 1000]]),
  });
}
function traced(id: string, cameraId: string, startMs: number): string {
  store.upsertEvent({ id, cameraId, state: 'ended', startTime: startMs, endTime: startMs + 60_000, lastUpdate: startMs + 60_000, types: ['object'], segments: [] } as unknown as RecordedEvent);
  store.addTrace(id, [{ tMs: startMs }, { tMs: startMs + 1000 }, { tMs: startMs + 2000 }]);
  return id;
}

// camera A: an old hour of video over the quota (it goes) and a young one; camera B: its one old hour, within the quota
const oldA = segment('a', T, 2 * 1024 ** 3);
const youngA = segment('a', T + 10 * HOUR, 1);
const oldB = segment('b', T, 1);
const beforeA = traced('before-a', 'a', T + HOUR);
const afterA = traced('after-a', 'a', T + 11 * HOUR);
const onB = traced('on-b', 'b', T + HOUR);
const noVideo = traced('no-video', 'c', T + HOUR);

await internals.enforceRetention();

assert.equal(store.segment(oldA), undefined, 'the quota took the old hour of A');
assert.ok(store.segment(youngA) && store.segment(oldB), 'and nothing else');
assert.equal(store.traceCount(beforeA), 0, 'the trace of an event of A older than its oldest video left is gone');
assert.ok(store.event(beforeA), 'the event itself stays');
assert.equal(store.traceCount(afterA), 3, 'a trace with its video stays');
assert.equal(store.traceCount(onB), 3, 'the video of B was kept: its trace stays');
assert.equal(store.traceCount(noVideo), 3, 'a camera with no video at all keeps its traces');

// again: nothing more goes
await internals.enforceRetention();
assert.equal(store.traceCount(afterA) + store.traceCount(onB) + store.traceCount(noVideo), 9);

// every pass read every old event of a camera (COALESCE(end_ms, start_ms) used no index: 280k events, 120 ms a camera
// every 5 min on the bench's database): the events between what was cleared and the oldest video, by an index
const db = (store as unknown as { db: { prepare(sql: string): { all(...args: unknown[]): { detail: string }[] } } }).db;
const plan = db
  .prepare(`EXPLAIN QUERY PLAN ${store.pruneTracesSql}`)
  .all('a', T, T + HOUR, 100)
  .map((row) => row.detail)
  .join(' | ');
assert.match(plan, /USING INDEX events_camera_end \(camera_id=\? AND <expr>>\? AND <expr><\?\)/, plan);
// a camera cleared up to its oldest video is read from there on: an old trace left behind it is not looked at again
const late = traced('late-a', 'a', T + 2 * HOUR);
await internals.enforceRetention();
assert.equal(store.traceCount(late), 3, 'what was cleared is not read again');

// nor after a restart: the progress is kept in the database. It was in memory only, and each start read every old event
// of each camera on a cold disk (1 818 on the bench, 4.7 s of a held recorder before the cache was warm, 2026-10-16)
(store as unknown as { close(): void }).close();
const restarted = new VionNvr(logger as never, api as never, storage as never) as unknown as typeof internals;
await restarted.ready;
await restarted.enforceRetention();
assert.equal(restarted.store.traceCount(late), 3, 'what was cleared before the restart is not read again');
// a progress that does not read as one is no progress: the camera is read from its first event
const bad = restarted.store as unknown as { setMeta(key: string, value: string): void; close(): void };
bad.setMeta('traces_cleared_to', '{"a": "soon", "b": -1}');
bad.close();
const again = new VionNvr(logger as never, api as never, storage as never) as unknown as typeof internals;
await again.ready;
await again.enforceRetention();
assert.equal(again.store.traceCount(late), 0, 'a broken progress reads from the start');

console.log('trace-retention.spec: a trace older than the oldest video of its camera deleted, its event kept, the rest kept, the progress kept over a restart OK');
process.exit(0);
