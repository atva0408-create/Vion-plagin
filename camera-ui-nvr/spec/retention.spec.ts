// Retention over files it cannot delete (src/index.ts, enforceRetention). `rm` with `force` is quiet only about a file
// that is gone; a file the plugin may not delete (EACCES, EPERM) or cannot (EIO) threw out of the pass, and the next
// pass began with the same file: the retention by days, the quota and the free-space guard stopped for good and the
// disk filled up. Such a file stays with its row and is tried again at the next pass, told once; the pass goes on past
// it, more than a batch of them too. A pass is not started over a running one, and a disk that tells no size (statfs
// with no blocks) has no free share the guard could keep: it deleted up to 10 000 of the oldest files at every pass.
// Run: npx tsx spec/retention.spec.ts
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import VionNvr from '../src/index.js';

import type { Store } from '../src/store.js';

// the disk as the plugin sees it; a share freed by every file deleted, where a section asks for it
const disk = { blocks: 1000, bavail: 500, bsize: 4096, perFile: 0 };
fsp.statfs = (async () => ({ blocks: disk.blocks, bavail: disk.bavail, bsize: disk.bsize })) as unknown as typeof fsp.statfs;
// files the plugin may not delete, every call of rm, and a gate a section can hold rm at
const locked = new Set<string>();
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
    if (locked.has(String(path))) throw Object.assign(new Error(`EACCES: permission denied, unlink '${path}'`), { code: 'EACCES' });
    await realRm(path, opts);
    if (disk.perFile) disk.bavail += disk.perFile;
  } finally {
    inFlight--;
  }
}) as typeof realRm;
syncBuiltinESMExports();

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
  const internals = nvr as unknown as { store: Store; enforceRetention(): Promise<void>; ready: Promise<void>; paused: boolean };
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
  const told = () => warnings.filter((w) => w.includes('could not be deleted'));
  return { internals, segment, kept, gone, told, warnings };
}

// ------------------------------------------------------------------ by days: past the files that stay

{
  const { internals, segment, kept, gone, told, warnings } = plugin('days', { retentionDays: 1, quotaGB: 0, minFreePercent: 5 });
  await internals.ready;
  const old = Date.now() - 10 * 86_400_000;
  // more files that stay than one batch of the pass reads (200): the next batch must not be the same rows again
  const stuck = Array.from({ length: 205 }, (_, i) => segment(old + i * 60_000));
  for (const seg of stuck) locked.add(seg.path);
  const after = Array.from({ length: 3 }, (_, i) => segment(old + (300 + i) * 60_000));
  const young = segment(Date.now() - HOUR);
  calls.length = 0;
  await internals.enforceRetention();
  assert.ok(after.every(gone), 'the expired files after those that cannot be deleted go, file and row');
  assert.ok(stuck.every(kept), 'a file that cannot be deleted keeps its row: it is still on the disk, and the next pass tries again');
  assert.ok(kept(young), 'a file within the days stays');
  assert.equal(calls.length, 208, 'each expired file is tried once in a pass, not read again batch after batch');
  assert.deepEqual(
    warnings.filter((w) => w.startsWith('Retention failed')),
    [],
    'the pass is not ended by them',
  );
  assert.equal(told().length, 1, `the files that stay are told in one line: ${JSON.stringify(warnings)}`);
  assert.match(told()[0], /^Retention: 205 recorded file\(s\) could not be deleted .*EACCES/);

  // the next pass tries them again and says nothing new
  calls.length = 0;
  await internals.enforceRetention();
  assert.equal(calls.length, 205, 'tried again');
  assert.equal(told().length, 1, 'not told again at every pass');
  // one can be deleted now: it goes; another one new that cannot is told, alone
  locked.delete(stuck[0].path);
  const later = segment(old + 400 * 60_000);
  locked.add(later.path);
  await internals.enforceRetention();
  assert.ok(gone(stuck[0]), 'deleted once it can be');
  assert.ok(stuck.slice(1).every(kept) && kept(later));
  assert.equal(told().length, 2);
  assert.match(told()[1], /^Retention: 1 recorded file\(s\)/);
  for (const seg of [...stuck, later]) locked.delete(seg.path);
  await internals.enforceRetention();
  assert.ok(stuck.every(gone) && gone(later), 'all of them once they can be');
}

// ------------------------------------------------------------------ the quota: the next oldest in place of one that stays

{
  const { internals, segment, kept, gone } = plugin('quota', { retentionDays: 90, quotaGB: 1, minFreePercent: 5 });
  await internals.ready;
  const at = Date.now() - 10 * HOUR;
  // 2 GiB of archive, 1 allowed; the oldest half GiB cannot be deleted
  const [first, second, third, fourth] = [0, 1, 2, 3].map((i) => segment(at + i * HOUR, GB / 2));
  locked.add(first.path);
  await internals.enforceRetention();
  assert.ok(kept(first), 'the file that cannot be deleted stays, in the quota');
  assert.ok(gone(second) && gone(third), 'the next oldest go until the archive fits');
  assert.ok(kept(fourth), 'and no more');
  locked.delete(first.path);
}

// ------------------------------------------------------------------ the free-space guard the same way

{
  const { internals, segment, kept, gone } = plugin('free', { retentionDays: 90, quotaGB: 0, minFreePercent: 5 });
  await internals.ready;
  const at = Date.now() - 10 * HOUR;
  const files = [0, 1, 2, 3, 4].map((i) => segment(at + i * HOUR));
  locked.add(files[0].path);
  // 3 % free, each file deleted frees 1 %
  Object.assign(disk, { blocks: 1000, bavail: 30, perFile: 10 });
  await internals.enforceRetention();
  Object.assign(disk, { bavail: 500, perFile: 0 });
  assert.ok(kept(files[0]), 'the file that cannot be deleted stays');
  assert.ok(gone(files[1]) && gone(files[2]), 'the next oldest go until 5 % are free');
  assert.ok(kept(files[3]) && kept(files[4]));
  assert.equal(internals.paused, false, 'room was made: recording goes on');
  locked.delete(files[0].path);
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

console.log(
  'retention.spec: files that cannot be deleted stay and are tried again, told once, past a batch of them; the quota and the free-space guard go on past them; no size, no free-space guard; one pass at a time — ok',
);
process.exit(0);
