// An export on a disk that fills up and an ffmpeg that never ends (src/export.ts). The ZIP's write stream had no
// 'error' listener: ENOSPC under it was an uncaught exception that ended the plugin, and with it every camera's
// recording; the stream stayed open and the unfinished archive on the disk when a file of it could not be read. The
// export fails now, by what the disk said, with its file closed and removed. And ffmpeg ran without a time limit: one
// that hung held its place in the gate for good, after two of them every export was refused. It is stopped after a
// time that grows with the length of the clip, more for one that is encoded, and its place is free again.
// Run: npx tsx spec/export-failures.spec.ts
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs, { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { exportClip, exportTimeoutMs, writeZip } from '../src/export.js';

import type { WriteStream } from 'node:fs';
import type { SegmentRow } from '../src/store.js';

const dir = mkdtempSync(join(tmpdir(), 'nvr-export-failures-'));
// what the plugin would not survive is counted here; a failed check of the spec itself ends it as it would without
const uncaught: unknown[] = [];
process.on('uncaughtException', (error) => {
  if (error instanceof assert.AssertionError) {
    console.error(error);
    process.exit(1);
  }
  uncaught.push(error);
});
let finished = false;
process.on('exit', (code) => {
  if (!finished && code === 0) {
    console.error('the spec ended before its last check: something waits for what never comes');
    process.exitCode = 1;
  }
});
const realSetTimeout = globalThis.setTimeout;
const sleep = (ms: number) => new Promise((resolve) => realSetTimeout(resolve, ms));

// ------------------------------------------------------------------ the ZIP on a disk that fills up

const one = join(dir, 'one.mp4');
const two = join(dir, 'two.mp4');
writeFileSync(one, Buffer.alloc(300_000, 1));
writeFileSync(two, Buffer.alloc(300_000, 2));

/** The streams the next archives are written by: their bytes go to the disk until `room` is used up. */
const streams: WriteStream[] = [];
let room = Number.POSITIVE_INFINITY;
const realCreateWriteStream = fs.createWriteStream;
fs.createWriteStream = ((path: string, opts?: never) => {
  const stream = realCreateWriteStream(path, opts);
  streams.push(stream);
  let written = 0;
  const full = () => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
  const write = stream._write.bind(stream);
  stream._write = (chunk: Buffer, encoding, callback) => {
    written += chunk.length;
    if (written > room) callback(full());
    else write(chunk, encoding, callback);
  };
  const writev = stream._writev?.bind(stream);
  if (writev) {
    stream._writev = (chunks, callback) => {
      written += chunks.reduce((n, c) => n + (c.chunk as Buffer).length, 0);
      if (written > room) callback(full());
      else writev(chunks, callback);
    };
  }
  return stream;
}) as typeof fs.createWriteStream;
syncBuiltinESMExports();

{
  // room for the first file and part of the second
  room = 400_000;
  const target = join(dir, 'full.zip');
  await assert.rejects(
    writeZip(target, [
      { path: one, name: 'one.mp4' },
      { path: two, name: 'two.mp4' },
    ]),
    /ENOSPC/,
    'the export fails by what the disk said',
  );
  await sleep(50);
  assert.deepEqual(uncaught, [], 'and the plugin goes on: no exception nobody catches');
  assert.equal(streams.at(-1)!.closed, true, 'the archive is closed');
  assert.equal(existsSync(target), false, 'and the unfinished archive is removed');
  room = Number.POSITIVE_INFINITY;
}
{
  // a folder that is not there: the archive cannot even be opened
  const target = join(dir, 'gone', 'missing.zip');
  await assert.rejects(writeZip(target, [{ path: one, name: 'one.mp4' }]), /ENOENT/);
  await sleep(50);
  assert.deepEqual(uncaught, []);
  assert.equal(streams.at(-1)!.closed, true);
}
{
  // a file of the archive that cannot be read (a folder in its place): the archive is closed and goes too
  const folder = join(dir, 'a-folder');
  mkdirSync(folder);
  const target = join(dir, 'unreadable.zip');
  await assert.rejects(
    writeZip(target, [
      { path: one, name: 'one.mp4' },
      { path: folder, name: 'two.mp4' },
    ]),
    /EISDIR/,
  );
  await sleep(50);
  assert.deepEqual(uncaught, []);
  assert.equal(streams.at(-1)!.closed, true, 'the archive is closed');
  assert.equal(existsSync(target), false, 'and removed');
}
{
  // a disk with room: the archive as before
  const target = join(dir, 'fine.zip');
  const size = await writeZip(target, [
    { path: one, name: 'one.mp4' },
    { path: two, name: 'two.mp4' },
  ]);
  assert.equal(fs.statSync(target).size, size);
}
fs.createWriteStream = realCreateWriteStream;
syncBuiltinESMExports();

// ------------------------------------------------------------------ an ffmpeg that never ends

assert.equal(exportTimeoutMs(30, false), 150_000, 'two minutes and the clip');
assert.equal(exportTimeoutMs(30, true), 240_000, 'two minutes and four times the clip, encoded');
assert.equal(exportTimeoutMs(3600, true), 120_000 + 4 * 3_600_000, 'an hour encoded');

{
  // every ffmpeg hangs: it ends only when it is killed
  const spawned: { args: string[]; killed: string[] }[] = [];
  const realSpawn = childProcess.spawn;
  childProcess.spawn = ((_bin: string, args: string[]) => {
    const proc = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), killed: [] as string[] });
    spawned.push({ args, killed: proc.killed });
    (proc as unknown as { kill(signal: string): boolean }).kill = (signal: string) => {
      proc.killed.push(signal);
      setImmediate(() => proc.emit('close', null, signal));
      return true;
    };
    return proc;
  }) as unknown as typeof realSpawn;
  syncBuiltinESMExports();
  // the long waits of the spec come at once; what they were set to is kept
  const delays: number[] = [];
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
    if ((ms ?? 0) < 60_000) return realSetTimeout(fn, ms, ...rest);
    delays.push(ms!);
    return realSetTimeout(fn, 20);
  }) as typeof setTimeout;

  const S = 1_000_000;
  const segment: SegmentRow = {
    id: 1,
    camera_id: 'cam',
    role: 'high',
    start_us: 0,
    end_us: 30 * S,
    path: one,
    bytes: 1000,
    codec: 'h264',
    codec_string: 'avc1.640015',
    width: 320,
    height: 240,
    video_pid: 256,
    audio_pid: -1,
    keyframes: '[]',
  };
  const clip = (name: string, extra: { timelapseIntervalSec?: number } = {}) =>
    exportClip({ ffmpegPath: 'ffmpeg', segments: [segment], startUs: 0, endUs: 30 * S, outDir: join(dir, 'exports'), filename: `${name}.mp4`, ...extra });
  const outcome = (p: Promise<unknown>) =>
    Promise.race([
      p.then(
        () => 'done',
        (error: Error) => error.message,
      ),
      sleep(3000).then(() => 'hang'),
    ]);

  // two at once, the places of the gate
  const [a, b] = await Promise.all([outcome(clip('a')), outcome(clip('b'))]);
  assert.match(a, /ffmpeg did not finish in 150 s and was stopped/, 'a copy of 30 s is stopped after two and a half minutes');
  assert.match(b, /did not finish/);
  assert.deepEqual(delays.slice(0, 2), [150_000, 150_000]);
  assert.deepEqual(
    spawned.map((s) => s.killed),
    [['SIGKILL'], ['SIGKILL']],
    'the hung ffmpeg is killed',
  );
  assert.equal(existsSync(join(dir, 'exports', 'a.mp4')), false, 'nothing of it stays');
  // their places are free: the next export is not refused as too many, it runs (and is stopped the same way)
  const lapse = await outcome(clip('c', { timelapseIntervalSec: 1 }));
  assert.match(lapse, /did not finish in 240 s/, `a timelapse is encoded: four times the clip (${lapse})`);
  assert.equal(spawned.length, 3);
  globalThis.setTimeout = realSetTimeout;
  childProcess.spawn = realSpawn;
  syncBuiltinESMExports();
}

finished = true;
console.log(
  'export-failures.spec: a full disk under a ZIP fails the export, closed and removed, the plugin goes on; a hung ffmpeg is stopped in a time by the clip — ok',
);
process.exit(0);
