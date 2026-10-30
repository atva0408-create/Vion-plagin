// Retention over files it cannot delete (src/index.ts, enforceRetention). `rm` with `force` is quiet only about a file
// that is gone; a file the plugin may not delete (EACCES, EPERM) or cannot (EIO) threw out of the pass, and the next
// pass began with the same file: the retention by days, the quota and the free-space guard stopped for good and the
// disk filled up. Such a file stays with its row, is told once and tried again an hour later; the passes go on past
// it, more than a batch of them too. It is out of the quota: counted, it made the guard delete every recording of every
// camera when such files alone were over the quota. The free-space guard deletes only what can make the room, and
// pauses the recording when nothing can. Twenty refusals in a row (a read-only disk) end a pass. A pass is not started
// over a running one, and a disk that tells no size (statfs with no blocks) has no free share the guard could keep: it
// deleted up to 10 000 of the oldest files at every pass.
// Run: npx tsx spec/retention.spec.ts
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import VionNvr from '../src/index.js';

import type { Store } from '../src/store.js';
import type { SystemEvent } from '../src/types.js';

// the disk as the plugin sees it; a share freed by every file deleted, where a section asks for it (blocks of 4 KiB:
// 10 blocks are one file of 40 KiB, a hundredth of the disk)
const disk = { blocks: 1000, bavail: 500, bsize: 4096, perFile: 0 };
const FILE = 10 * 4096;
fsp.statfs = (async () => ({ blocks: disk.blocks, bavail: disk.bavail, bsize: disk.bsize })) as unknown as typeof fsp.statfs;
// files the plugin may not delete (and how it is refused), every call of rm, and a gate a section can hold rm at
const locked = new Map<string, string>();
let refuseAll: string | undefined;
const calls: string[] = [];
let inFlight = 0;
let maxInFlight = 0;
let gate: Promise<void> | undefined;
const realRm = fsp.rm;
fsp.rm = (async (path: string, opts?: Parameters<typeof realRm>[1]) => {
  calls.push(String(path));
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  try {
    if (gate) await gate;
    const code = refuseAll ?? locked.get(String(path));
    if (code) throw Object.assign(new Error(`${code}: refused, unlink '${path}'`), { code });
    await realRm(path, opts);
    if (disk.perFile) disk.bavail += disk.perFile;
  } finally {
    inFlight--;
  }
}) as typeof realRm;
syncBuiltinESMExports();
// the clock of the plugin: a file that could not be deleted is tried again an hour later
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;

const noop = () => undefined;
const HOUR = 3_600_000;
const GB = 1024 ** 3;

function plugin(name: string, values: Record<string, unknown>) {
  const storagePath = mkdtempSync(join(tmpdir(), `nvr-retention-${name}-`));
  const warnings: string[] = [];
  const logger = { log: noop, warn: (m: string) => warnings.push(m), error: console.error, debug: noop, attention: noop, trace: noop };
  const api = {
    storagePath,
    on: noop,
    once: noop,
    emit: noop,
    notificationManager: { publish: async () => undefined },
    coreManager: { assistantAccess: async () => ({ allowed: false }), getFFmpegPath: () => new Promise<string>(noop), getPluginsByInterface: async () => [] },
    proxy: { createProxy: () => ({}) },
  };
  const storage = { values, getValue: async () => undefined, setValue: async () => undefined };
  const nvr = new VionNvr(logger as never, api as never, storage as never);
  const internals = nvr as unknown as { store: Store; enforceRetention(): Promise<void>; ready: Promise<void>; paused: boolean; systemEvents: SystemEvent[] };
  const dir = join(storagePath, 'files');
  mkdirSync(dir, { recursive: true });
  const segment = (startMs: number, bytes = 1) => {
    const path = join(dir, `${startMs}.ts`);
    writeFileSync(path, 'x');
    const id = internals.store.addSegment({
      camera_id: 'cam',
      role: 'high',
      start_us: startMs * 1000,
      end_us: (startMs + 60_000) * 1000,
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
    return { id, path };
  };
  const kept = (seg: { id: number; path: string }) => internals.store.segment(seg.id) !== undefined && existsSync(seg.path);
  const gone = (seg: { id: number; path: string }) => internals.store.segment(seg.id) === undefined && !existsSync(seg.path);
  const told = () => warnings.filter((w) => w.includes('could not be deleted') || w.includes('refused in a row'));
  const events = () => internals.systemEvents.filter((e) => e.type === 'storage');
  return { internals, segment, kept, gone, told, events, warnings };
}

// ------------------------------------------------------------------ by days: past the files that stay

{
  const { internals, segment, kept, gone, told, events, warnings } = plugin('days', { retentionDays: 1, quotaGB: 0, minFreePercent: 5 });
  await internals.ready;
  const old = Date.now() - 10 * 86_400_000;
  // more files that stay than one batch of the pass reads (200): the next batch must not be the same rows again
  const stuck = Array.from({ length: 205 }, (_, i) => segment(old + i * 60_000));
  for (const seg of stuck) locked.set(seg.path, 'EACCES');
  const after = Array.from({ length: 3 }, (_, i) => segment(old + (300 + i) * 60_000));
  const young = segment(Date.now() - HOUR);
  // twenty refusals in a row end a pass; the next one passes over them and tries the next twenty
  const tries: number[] = [];
  for (let n = 0; n < 15 && !after.every(gone); n++) {
    calls.length = 0;
    await internals.enforceRetention();
    tries.push(calls.length);
  }
  assert.ok(after.every(gone), 'the expired files after those that cannot be deleted go, file and row');
  assert.deepEqual(tries, [20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 8], 'twenty refusals a pass, each file tried once, then those after them');
  assert.ok(stuck.every(kept), 'a file that cannot be deleted keeps its row: it is still on the disk, and is tried again later');
  assert.ok(kept(young), 'a file within the days stays');
  assert.deepEqual(
    warnings.filter((w) => w.startsWith('Retention failed')),
    [],
    'the passes are not ended by an error',
  );
  assert.equal(told().length, 2, `told when they begin and for the last five, not at every pass: ${JSON.stringify(told())}`);
  assert.match(told()[0], /^Retention: 20 deletions refused in a row \(.*EACCES/);
  assert.match(told()[1], /^Retention: 5 recorded file\(s\) could not be deleted and stay, out of the quota/);
  assert.equal(events().length, 2, 'and told in the events of the system as often');

  // within the hour they wait; an hour later they are tried again, and nothing new is told
  calls.length = 0;
  await internals.enforceRetention();
  assert.equal(calls.length, 0, 'not tried again at every pass');
  skew += HOUR;
  calls.length = 0;
  await internals.enforceRetention();
  assert.equal(calls.length, 20, 'tried again an hour later');
  assert.equal(told().length, 2, 'not told again');
  // one can be deleted now: it goes at its next try; another new one that cannot is told, alone
  locked.delete(stuck[0].path);
  const later = segment(old + 400 * 60_000);
  locked.set(later.path, 'EACCES');
  skew += HOUR;
  for (let n = 0; n < 15 && !gone(stuck[0]); n++) await internals.enforceRetention();
  assert.ok(gone(stuck[0]), 'deleted once it can be');
  assert.ok(stuck.slice(1).every(kept));
  for (let n = 0; n < 15 && !told().some((w) => w.startsWith('Retention: 1 recorded file(s)')); n++) await internals.enforceRetention();
  assert.ok(
    told().some((w) => w.startsWith('Retention: 1 recorded file(s)')),
    `the new one is told: ${JSON.stringify(told())}`,
  );
  locked.clear();
  skew += HOUR;
  for (let n = 0; n < 5 && !(stuck.every(gone) && gone(later)); n++) await internals.enforceRetention();
  assert.ok(stuck.every(gone) && gone(later), 'all of them once they can be');
}

// ------------------------------------------------------------------ the quota: files that stay are out of it

{
  // 1 GiB allowed; three old files of half a GiB the plugin may not delete (a folder of an earlier install) and four
  // of today, a tenth each. Counted, the stuck ones alone were over the quota: the guard deleted every recording
  const { internals, segment, kept, events } = plugin('quota-stuck', { retentionDays: 90, quotaGB: 1, minFreePercent: 5 });
  await internals.ready;
  const at = Date.now() - 10 * HOUR;
  const stuck = [0, 1, 2].map((i) => segment(at + i * HOUR, GB / 2));
  for (const seg of stuck) locked.set(seg.path, 'EACCES');
  const fresh = [3, 4, 5, 6].map((i) => segment(at + i * HOUR, GB / 10));
  await internals.enforceRetention();
  assert.ok(fresh.every(kept), 'the recordings of today stay');
  assert.ok(stuck.every(kept));
  // two of them tried: out of the quota, the rest fits it
  assert.equal(events().length, 1, 'the files that stay are told in the events of the system');
  assert.match(events()[0].message, /Не удаётся удалить файлы записи: 2 .*не считаются в квоте/);
  await internals.enforceRetention();
  assert.ok(fresh.every(kept), 'at the next pass too');
  assert.equal(events().length, 1, 'told once');
  for (const seg of stuck) locked.delete(seg.path);
}
{
  // 2 GiB of archive, 1 allowed; the oldest half GiB cannot be deleted: the rest, out of it, is 1.5 GiB
  const { internals, segment, kept, gone } = plugin('quota', { retentionDays: 90, quotaGB: 1, minFreePercent: 5 });
  await internals.ready;
  const at = Date.now() - 10 * HOUR;
  const [first, second, third, fourth] = [0, 1, 2, 3].map((i) => segment(at + i * HOUR, GB / 2));
  locked.set(first.path, 'EACCES');
  await internals.enforceRetention();
  assert.ok(kept(first), 'the file that cannot be deleted stays');
  assert.ok(gone(second), 'the next oldest goes until the rest fits');
  assert.ok(kept(third) && kept(fourth), 'and no more');
  locked.delete(first.path);
}

// ------------------------------------------------------------------ the free-space guard

{
  const { internals, segment, kept, gone } = plugin('free', { retentionDays: 90, quotaGB: 0, minFreePercent: 5 });
  await internals.ready;
  const at = Date.now() - 10 * HOUR;
  const files = [0, 1, 2, 3, 4].map((i) => segment(at + i * HOUR, FILE));
  locked.set(files[0].path, 'EACCES');
  // 3 % free, each file deleted frees 1 %
  Object.assign(disk, { blocks: 1000, bavail: 30, perFile: 10 });
  await internals.enforceRetention();
  Object.assign(disk, { bavail: 500, perFile: 0 });
  assert.ok(kept(files[0]), 'the file that cannot be deleted stays');
  assert.ok(gone(files[1]) && gone(files[2]), 'the next oldest go until 5 % are free, and no more');
  assert.ok(kept(files[3]) && kept(files[4]));
  assert.equal(internals.paused, false, 'room was made: recording goes on');
  locked.delete(files[0].path);
}
{
  // 1 % free; files that cannot be deleted hold the disk, the two that can would free 2 % of the 4 needed: deleting
  // them does not make the room, they stay and the recording pauses
  const { internals, segment, kept } = plugin('free-held', { retentionDays: 90, quotaGB: 0, minFreePercent: 5 });
  await internals.ready;
  const at = Date.now() - 10 * HOUR;
  const held = [0, 1, 2].map((i) => segment(at + i * HOUR, 300 * FILE));
  for (const seg of held) locked.set(seg.path, 'EACCES');
  const recent = [3, 4].map((i) => segment(at + i * HOUR, FILE));
  Object.assign(disk, { blocks: 1000, bavail: 10, perFile: 10 });
  await internals.enforceRetention();
  Object.assign(disk, { bavail: 500, perFile: 0 });
  assert.ok(recent.every(kept), 'the recordings that cannot make the room stay');
  assert.equal(internals.paused, true, 'the recording pauses instead');
  for (const seg of held) locked.delete(seg.path);
}

// ------------------------------------------------------------------ a disk that refuses every deletion

for (const code of ['EROFS', 'EPERM']) {
  // mounted read-only: EROFS on Linux, EPERM on a read-only volume of Windows. Every row was tried, and the guard went
  // 10 000 times round at every pass
  const { internals, segment, events } = plugin(`read-only-${code}`, { retentionDays: 1, quotaGB: 1, minFreePercent: 5 });
  await internals.ready;
  const old = Date.now() - 10 * 86_400_000;
  for (let i = 0; i < 60; i++) segment(old + i * 60_000, GB / 10);
  for (let i = 0; i < 60; i++) segment(Date.now() - 5 * HOUR + i * 60_000, GB / 10);
  refuseAll = code;
  calls.length = 0;
  await internals.enforceRetention();
  const first = calls.length;
  calls.length = 0;
  await internals.enforceRetention();
  const second = calls.length;
  refuseAll = undefined;
  // by days, then for room (over the quota): each ends at once when the disk says it is read-only, else after twenty
  assert.equal(first, code === 'EROFS' ? 2 : 40, `${code}: the deletions end at once (read-only) or after twenty refusals`);
  assert.equal(second, first, `${code}: and the next one the same, not every row`);
  assert.equal(events().length, 1, `${code}: told once for the series: ${JSON.stringify(events())}`);
  assert.match(events()[0].message, /Записи не удаляются: .*отказ/);
  assert.equal(internals.store.oldestSegments(200).length, 120, `${code}: nothing deleted, nothing lost`);
}

// ------------------------------------------------------------------ a disk that tells no size

{
  const { internals, segment, kept } = plugin('no-size', { retentionDays: 90, quotaGB: 0, minFreePercent: 5 });
  await internals.ready;
  const at = Date.now() - 10 * HOUR;
  const files = [0, 1, 2].map((i) => segment(at + i * HOUR, GB));
  Object.assign(disk, { blocks: 0, bavail: 0 });
  await internals.enforceRetention();
  assert.ok(files.every(kept), 'no free share to keep: nothing is deleted for it');
  assert.equal(internals.paused, false, 'nor is recording paused');
  // the quota still holds there
  const quota = plugin('no-size-quota', { retentionDays: 90, quotaGB: 1, minFreePercent: 5 });
  await quota.internals.ready;
  const big = [0, 1, 2].map((i) => quota.segment(at + i * HOUR, GB));
  await quota.internals.enforceRetention();
  Object.assign(disk, { blocks: 1000, bavail: 500 });
  assert.ok(quota.gone(big[0]) && quota.gone(big[1]) && quota.kept(big[2]), 'the quota alone decides');
  assert.ok(files.every(kept));
}

// ------------------------------------------------------------------ one pass at a time

{
  const { internals, segment, gone } = plugin('busy', { retentionDays: 1, quotaGB: 0, minFreePercent: 5 });
  await internals.ready;
  const old = Date.now() - 10 * 86_400_000;
  const files = [0, 1, 2].map((i) => segment(old + i * 60_000));
  let release!: () => void;
  gate = new Promise<void>((resolve) => (release = resolve));
  calls.length = 0;
  maxInFlight = 0;
  // the timer's next tick while the first pass waits for a slow disk
  const first = internals.enforceRetention();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const second = internals.enforceRetention();
  await new Promise((resolve) => setTimeout(resolve, 50));
  gate = undefined;
  release();
  await Promise.all([first, second]);
  assert.equal(maxInFlight, 1, 'no second pass over the running one');
  assert.equal(calls.filter((path) => path === files[0].path).length, 1, 'the same file is not deleted twice');
  assert.ok(files.every(gone));
  // and the next one after it runs
  const late = segment(old + 10 * 60_000);
  await internals.enforceRetention();
  assert.ok(gone(late), 'a pass after the one that ran');
}

Date.now = realNow;
console.log(
  'retention.spec: files that cannot be deleted stay, out of the quota, told once and tried again an hour later, past a batch of them; files stuck over the quota delete no recording; the free-space guard deletes only what makes the room, else pauses; a read-only disk ends a pass; no size, no free-space guard; one pass at a time — ok',
);
process.exit(0);
