// An export on a disk that fills up and an ffmpeg that never ends (src/export.ts). The ZIP's write stream had no
// 'error' listener: ENOSPC under it was an uncaught exception that ended the plugin, and with it every camera's
// recording; the stream stayed open and the unfinished archive on the disk when a file of it could not be read. The
// export fails now, by what the disk said, with its file closed and removed. And ffmpeg ran without a time limit: one
// that hung held its place in the gate for good, after two of them every export was refused. It is stopped when it
// shows no work for ten minutes (its output, the bytes it reads), and its place is free again; a slow machine finishes.
// Run: npx tsx spec/export-failures.spec.ts
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs, { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { exportClip, writeZip } from '../src/export.js';

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
    console.error('the spec ended before its last check: something waits for what never comes', uncaught);
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

// ------------------------------------------------------------------ an ffmpeg that never ends, one that is slow

{
  // the ffmpeg of the spec does what each case says: what it writes of its output (`-progress`), the bytes it reads
  // (/proc/<pid>/io on Linux), and it ends only when it is killed
  type Fake = EventEmitter & { pid: number; stdout: EventEmitter; stderr: EventEmitter; killed: string[]; args: string[] };
  const spawned: Fake[] = [];
  const realSpawn = childProcess.spawn;
  childProcess.spawn = ((_bin: string, args: string[]) => {
    const proc = Object.assign(new EventEmitter(), { pid: 9000 + spawned.length, stdout: new EventEmitter(), stderr: new EventEmitter(), killed: [] as string[], args });
    (proc as unknown as { kill(signal: string): boolean }).kill = (signal: string) => {
      proc.killed.push(signal);
      setImmediate(() => proc.emit('close', null, signal));
      return true;
    };
    spawned.push(proc);
    return proc;
  }) as unknown as typeof realSpawn;
  const reads = new Map<number, number>();
  const realReadFile = fsp.readFile;
  fsp.readFile = (async (path: string, ...rest: unknown[]) => {
    const pid = /^\/proc\/(\d+)\/io$/.exec(String(path))?.[1];
    if (pid === undefined) return (realReadFile as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
    if (!reads.has(Number(pid))) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return `rchar: ${reads.get(Number(pid))}\nwchar: 0\n`;
  }) as typeof fsp.readFile;
  syncBuiltinESMExports();
  // the clock of the plugin and its looks at the ffmpeg, both in the hands of the spec
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  const looks = new Set<() => void>();
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  globalThis.setInterval = ((fn: () => void, ms?: number) => {
    if (ms !== 30_000) return realSetInterval(fn, ms);
    looks.add(fn);
    return fn as unknown as NodeJS.Timeout;
  }) as typeof setInterval;
  globalThis.clearInterval = ((handle: unknown) => {
    if (looks.has(handle as () => void)) looks.delete(handle as () => void);
    else realClearInterval(handle as NodeJS.Timeout);
  }) as typeof clearInterval;
  /** Time goes by in steps of the looks; `each` is what the ffmpeg does in each step. */
  const pass = async (ms: number, each: () => void = () => undefined) => {
    for (let t = 0; t < ms; t += 30_000) {
      clock += 30_000;
      each();
      for (const look of [...looks]) look();
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    }
  };
  const progress = (proc: Fake, outUs: number) =>
    proc.stdout.emit('data', Buffer.from(`frame=${Math.round(outUs / 40_000)}\ntotal_size=${outUs}\nout_time_us=${outUs}\nprogress=continue\n`));
  const S = 1_000_000;
  const segment = (endSec: number): SegmentRow => ({
    id: 1,
    camera_id: 'cam',
    role: 'high',
    start_us: 0,
    end_us: endSec * S,
    path: one,
    bytes: 1000,
    codec: 'h264',
    codec_string: 'avc1.640015',
    width: 320,
    height: 240,
    video_pid: 256,
    audio_pid: -1,
    keyframes: '[]',
  });
  const clip = (name: string, endSec: number, extra: { timelapseIntervalSec?: number } = {}) => {
    const outcome = { value: undefined as string | undefined };
    void exportClip({
      ffmpegPath: 'ffmpeg',
      segments: [segment(endSec)],
      startUs: 0,
      endUs: endSec * S,
      outDir: join(dir, 'exports'),
      filename: `${name}.mp4`,
      ...extra,
    }).then(
      () => (outcome.value = 'done'),
      (error: Error) => (outcome.value = error.message),
    );
    return outcome;
  };
  const started = async (count: number) => {
    for (let i = 0; i < 300 && spawned.length < count; i++) await sleep(10);
    assert.equal(spawned.length, count, 'ffmpeg started');
    return spawned[count - 1];
  };

  // a slow machine: an hour of H.265 made H.264 at 0.15 of real time takes more than six hours, its output grows all
  // the while. A limit by the length of the clip stopped it; it goes on as long as it works
  const slow = clip('slow', 3600);
  const slowProc = await started(1);
  assert.deepEqual(slowProc.args.slice(0, 2), ['-progress', 'pipe:1'], 'ffmpeg tells what it made');
  let made = 0;
  await pass(7 * 3_600_000, () => progress(slowProc, (made += 4_500_000)));
  assert.equal(slow.value, undefined, `seven hours of work, still running: ${slow.value}`);
  assert.deepEqual(slowProc.killed, []);
  // then it stops making anything: ten minutes later it is stopped
  await pass(9 * 60_000, () => progress(slowProc, made));
  assert.equal(slow.value, undefined, 'nine minutes without work: not yet');
  await pass(2 * 60_000, () => progress(slowProc, made));
  for (let i = 0; i < 300 && slow.value === undefined; i++) await sleep(10);
  assert.match(slow.value ?? '', /ffmpeg showed no work for 1[01] min and was stopped/, `stopped: ${slow.value}`);
  assert.deepEqual(slowProc.killed, ['SIGKILL']);
  assert.equal(existsSync(join(dir, 'exports', 'slow.mp4')), false, 'nothing of it stays');

  // two that hang from the start hold both places of the gate; stopped, they free them
  const a = clip('a', 30);
  const b = clip('b', 30);
  await started(3);
  await pass(11 * 60_000);
  for (let i = 0; i < 300 && (a.value === undefined || b.value === undefined); i++) await sleep(10);
  assert.match(a.value ?? '', /no work for/);
  assert.match(b.value ?? '', /no work for/);

  // a timelapse says nothing of its output until its end; where the reads cannot be seen it is allowed twenty times
  // its range (an hour: twenty hours), where they can (Linux) it works as long as it reads
  const blind = clip('blind', 3600, { timelapseIntervalSec: 60 });
  await started(4);
  await pass(19 * 3_600_000);
  assert.equal(blind.value, undefined, 'nineteen hours of a timelapse of an hour without its reads: still running');
  await pass(2 * 3_600_000);
  for (let i = 0; i < 300 && blind.value === undefined; i++) await sleep(10);
  assert.match(blind.value ?? '', /no work for 12\d\d min/, `stopped after twenty hours: ${blind.value}`);
  const seen = clip('seen', 3600, { timelapseIntervalSec: 60 });
  const seenProc = await started(5);
  let read = 0;
  reads.set(seenProc.pid, 0);
  await pass(5 * 3_600_000, () => reads.set(seenProc.pid, (read += 1_000_000)));
  assert.equal(seen.value, undefined, 'five hours of reading: still running');
  await pass(11 * 60_000);
  for (let i = 0; i < 300 && seen.value === undefined; i++) await sleep(10);
  assert.match(seen.value ?? '', /no work for 1[01] min/, `it stopped reading: stopped ten minutes later (${seen.value})`);

  Date.now = realNow;
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
  childProcess.spawn = realSpawn;
  fsp.readFile = realReadFile;
  syncBuiltinESMExports();
}

finished = true;
console.log(
  'export-failures.spec: a full disk under a ZIP fails the export, closed and removed, the plugin goes on; a hung ffmpeg is stopped after ten minutes without work, a slow one goes on — ok',
);
process.exit(0);
