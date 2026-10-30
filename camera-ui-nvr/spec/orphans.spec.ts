// Recorded files without a row (src/index.ts, sweepOrphans). The server restores a backup without the folders marked to
// be left out of it: the recordings stay as they are on this machine and nvr.db comes from the backup, so the files
// recorded after the backup have no row; the retention went by the rows and never deleted them. They follow the rules
// of the recordings now: deleted past the days kept (by their last write), the first to go for the free-space guard
// and the quota. Never one younger than an hour, never what the recorder does not write itself, and none as such when
// the database has no recordings at all (lost or broken: the days kept alone decide). Looked for at the start and once
// a day, not at every pass.
// Run: npx tsx spec/orphans.spec.ts
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { API_EVENT } from '@camera.ui/sdk';

import VionNvr from '../src/index.js';

import type { Store } from '../src/store.js';

// the disk as the plugin sees it, a share freed by every file deleted where a section asks for it
const disk = { blocks: 1000, bavail: 500, bsize: 4096, perFile: 0 };
fsp.statfs = (async () => ({ blocks: disk.blocks, bavail: disk.bavail, bsize: disk.bsize })) as unknown as typeof fsp.statfs;
const realRm = fsp.rm;
fsp.rm = (async (path: string, opts?: Parameters<typeof realRm>[1]) => {
  await realRm(path, opts);
  if (disk.perFile) disk.bavail += disk.perFile;
}) as typeof realRm;
syncBuiltinESMExports();

const noop = () => undefined;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = Date.now();
// a file of 40 KiB: what the disk below frees for each one deleted (10 blocks of 4 KiB, a hundredth of it)
const FILE = 10 * 4096;

function plugin(name: string, values: Record<string, unknown>) {
  const storagePath = mkdtempSync(join(tmpdir(), `nvr-orphans-${name}-`));
  const logs: string[] = [];
  const hostEvents = new Map<string, () => void>();
  const logger = { log: (m: string) => logs.push(m), warn: (m: string) => logs.push(`warn: ${m}`), error: console.error, debug: noop, attention: noop, trace: noop };
  const api = {
    storagePath,
    on: (event: string, handler: () => void) => void hostEvents.set(event, handler),
    once: noop,
    emit: noop,
    notificationManager: { publish: async () => undefined },
    coreManager: { assistantAccess: async () => ({ allowed: false }), getFFmpegPath: () => new Promise<string>(noop), getPluginsByInterface: async () => [] },
    proxy: { createProxy: () => ({}) },
  };
  const storage = { values, getValue: async () => undefined, setValue: async () => undefined };
  const nvr = new VionNvr(logger as never, api as never, storage as never);
  const internals = nvr as unknown as { store: Store; ready: Promise<void>; enforceRetention(): Promise<void>; sweepOrphans(): Promise<void>; paused: boolean };
  const recordings = join(storagePath, 'recordings');
  /** A file where the recorder puts one (or anywhere below the recordings), last written `ageMs` ago. */
  const file = (place: string, ageMs: number, bytes = 100) => {
    const path = join(recordings, place);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.alloc(bytes, 1));
    const at = (now - ageMs) / 1000;
    utimesSync(path, at, at);
    return path;
  };
  /** A row of the archive for a file, with the time it covers. */
  const row = (path: string, endMs: number, bytes = 100) =>
    internals.store.addSegment({
      camera_id: 'cam',
      role: 'high',
      start_us: (endMs - 60_000) * 1000,
      end_us: endMs * 1000,
      path,
      bytes,
      codec: 'h264',
      codec_string: 'avc1.64000d',
      width: 320,
      height: 240,
      video_pid: 256,
      audio_pid: -1,
      keyframes: JSON.stringify([[0, (endMs - 60_000) * 1000]]),
    });
  const summaries = () => logs.filter((l) => l.startsWith('Recorded files without a row'));
  return { internals, file, row, logs, summaries, recordings, hostEvents };
}

// ------------------------------------------------------------------ a backup restored: the files after it have no row

const restored = plugin('restored', { retentionDays: 7, quotaGB: 0, minFreePercent: 5 });
await restored.internals.ready;
const { file, row, recordings } = restored;
// what the restored database knows: a file written long ago whose row still covers a recent time, and a row of an
// older version with the absolute path of the archive where it was before
const withRow = file('cam/2026-10-01/1790000000000-high.ts', 30 * DAY, FILE);
row(withRow, now - 2 * HOUR, FILE);
const moved = file('cam/2026-10-01/1790000060000-low.ts', 30 * DAY, FILE);
row('D:/old-disk/vion/recordings/cam/2026-10-01/1790000060000-low.ts', now - 2 * HOUR, FILE);
// what was recorded after the backup: no row
const pastDays = file('cam/2026-10-20/1792000000000-high.ts', 10 * DAY);
const withinDays = file('door/2026-10-28/1793000000000-high.ts', 2 * DAY, FILE);
const young = file('door/2026-10-30/1793100000000-high.ts', 10 * 60_000, FILE);
// what the recorder does not write: left alone whatever its age
const foreign = [
  file('cam/2026-10-20/notes.txt', 30 * DAY),
  file('cam/2026-10-20/1792000000000-high.mp4', 30 * DAY),
  file('cam/not-a-day/1792000000000-high.ts', 30 * DAY),
  file('1792000000000-high.ts', 30 * DAY),
  file('cam/1792000000000-high.ts', 30 * DAY),
];
const marker = join(recordings, '.backupignore');
assert.ok(existsSync(marker), 'the marker of the backups is there');

await restored.internals.sweepOrphans();
assert.equal(existsSync(pastDays), false, 'a file without a row past the days kept is deleted');
assert.equal(existsSync(withinDays), true, 'one within the days kept stays');
assert.equal(existsSync(young), true, 'one younger than an hour stays');
assert.equal(existsSync(withRow), true, 'a file with a row is not touched, however old it is');
assert.equal(existsSync(moved), true, 'nor one whose row has the path of the archive before it was moved');
assert.ok(
  foreign.every((path) => existsSync(path)),
  'nothing the recorder does not write is touched',
);
assert.equal(existsSync(marker), true, 'nor the marker');
const summary = [...restored.summaries()];

// the free-space guard: the file without a row goes before any recording the archive knows. 3 % free, 1 % for each
// file: two must go, the file without a row and then the oldest recording, not the young file without a row
Object.assign(disk, { bavail: 30, perFile: 10 });
await restored.internals.enforceRetention();
Object.assign(disk, { bavail: 500, perFile: 0 });
assert.equal(existsSync(withinDays), false, 'the file without a row went first');
assert.equal(existsSync(young), true, 'the young one is not among those the guard deletes');
assert.equal(existsSync(withRow), false, 'then the oldest recording');
assert.equal(existsSync(moved), true, 'and no more: 5 % are free');
assert.equal(restored.internals.store.oldestSegments(10).length, 1);
assert.ok(restored.logs.some((l) => /^Retention: 1 recorded file\(s\) without a row deleted first for room/.test(l)));
// what the look said, in one line
assert.equal(summary.length, 1, `one line for the look: ${JSON.stringify(restored.logs)}`);
assert.match(summary[0], /^Recorded files without a row: 2 found \(0 GB\), 1 past the days kept deleted \(0 GB\); 1 within the days kept go first/);

// ------------------------------------------------------------------ the quota counts them, and deletes them first

{
  // a quota of about a KiB: the row says 1000 bytes, the file without a row has 600
  const quota = plugin('quota', { retentionDays: 7, quotaGB: 1e-6, minFreePercent: 5 });
  await quota.internals.ready;
  const recorded = quota.file('cam/2026-10-28/1793000000000-high.ts', 3 * DAY, 10);
  quota.row(recorded, now - 3 * DAY, 1000);
  const orphan = quota.file('cam/2026-10-29/1793050000000-high.ts', 2 * DAY, 600);
  await quota.internals.sweepOrphans();
  await quota.internals.enforceRetention();
  assert.equal(existsSync(orphan), false, 'over the quota with it: the file without a row goes');
  assert.equal(existsSync(recorded), true, 'and the recording with a row, older, stays');
}

// ------------------------------------------------------------------ a database with no recordings at all

{
  const lost = plugin('lost', { retentionDays: 7, quotaGB: 0, minFreePercent: 5 });
  await lost.internals.ready;
  const old = lost.file('cam/2026-10-10/1791000000000-high.ts', 20 * DAY);
  const files = Array.from({ length: 30 }, (_, i) => lost.file(`cam/2026-10-28/${1793000000000 + i * 60_000}-high.ts`, 2 * DAY, FILE));
  await lost.internals.sweepOrphans();
  assert.equal(existsSync(old), false, 'past the days kept a file goes, as it would with a row');
  assert.ok(
    files.every((path) => existsSync(path)),
    'the rest stays: a lost database is no backup restored',
  );
  // and the free-space guard does not take them for files a restore left
  Object.assign(disk, { bavail: 40, perFile: 10 });
  await lost.internals.enforceRetention();
  Object.assign(disk, { bavail: 500, perFile: 0 });
  assert.ok(
    files.every((path) => existsSync(path)),
    'none deleted for room',
  );
  assert.match(lost.summaries()[0], /the database has no recordings at all .*the 30 within the days kept stay/);
}

// ------------------------------------------------------------------ when it looks: at the start, then once a day

{
  const intervals: { ms: number; fn: () => void }[] = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((fn: () => void, ms?: number) => {
    intervals.push({ ms: ms ?? 0, fn });
    return { unref: noop } as unknown as NodeJS.Timeout;
  }) as typeof setInterval;
  const started = plugin('started', { retentionDays: 7, quotaGB: 0, minFreePercent: 5 });
  await started.internals.ready;
  const first = started.file('cam/2026-10-10/1791000000000-high.ts', 20 * DAY);
  started.row(started.file('cam/2026-10-29/1793050000000-high.ts', DAY), now - DAY);
  started.hostEvents.get(API_EVENT.FINISH_LAUNCHING)!();
  globalThis.setInterval = realSetInterval;
  for (let i = 0; i < 100 && existsSync(first); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(existsSync(first), false, 'looked for at the start, in the background');
  const daily = intervals.filter((i) => i.ms === 24 * HOUR);
  assert.equal(daily.length, 1, `and once a day after: ${intervals.map((i) => i.ms).join(', ')}`);
  assert.ok(!intervals.some((i) => i.ms < 24 * HOUR && i.fn.toString().includes('sweepOrphans')), 'not at every pass of the retention');
  const later = started.file('cam/2026-10-11/1791100000000-high.ts', 20 * DAY);
  daily[0].fn();
  for (let i = 0; i < 100 && existsSync(later); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(existsSync(later), false, 'the daily look deletes what came since');
}

console.log(
  'orphans.spec: files without a row past the days kept deleted, younger ones and those with a row kept, nothing foreign touched, first for room and in the quota, a lost database left to the days kept, looked for at the start and daily — ok',
);
process.exit(0);
