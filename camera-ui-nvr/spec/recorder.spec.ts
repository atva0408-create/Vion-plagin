// The recorder against a synthetic MPEG-TS, without a camera and without ffmpeg: a keyframe whose picture starts
// after the first TS packet (parameter sets and a long SEI in front of it) is found and indexed where the reader
// looks for it, video without keyframes is reported once, a failing index database neither throws out of the
// stream handler nor rejects unhandled (either one ends the plugin process and with it the recording of every camera)
// and is reported when a broken file loses its index, stop() waits for a file that is still closing, and frames keep
// the spacing of the stream when they arrive late in a burst while a healthy stream is stamped exactly as it was.
// Run: npx tsx spec/recorder.spec.ts
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { nalType, nalUnits } from '../src/media/ts-demux.js';
import { readKeyframe } from '../src/reader.js';
import { ffmpegArgs, probeUrlOf, Recorder, sendsAudio } from '../src/recorder.js';
import { parseKeyframes, Store } from '../src/store.js';

import type { VideoCodec } from '../src/media/ts-demux.js';

const dir = mkdtempSync(join(tmpdir(), 'nvr-recorder-'));
const noop = () => undefined;

// ---------------------------------------------------------------- a stream

const VIDEO_PID = 0x100;
const PMT_PID = 0x1000;
const TS = 188;

const nal = (...parts: (string | Buffer)[]) => Buffer.concat([Buffer.from([0, 0, 0, 1]), ...parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'hex') : p))]);
const filler = (bytes: number, value = 0x55) => Buffer.alloc(bytes, value);
/** An SEI of `bytes` of user data: what Hikvision/Dahua send with every frame and x265 with every keyframe. */
const seiBody = (bytes: number) => Buffer.concat([Buffer.from([5, ...Array<number>(Math.floor(bytes / 255)).fill(255), bytes % 255]), filler(bytes, 0xaa), Buffer.from([0x80])]);

// parameter sets of real 320x240 streams (x264, x265); the pictures are filler, the recorder does not decode them
const CODECS = {
  h264: {
    streamType: 0x1b,
    idr: 5,
    header: [nal('09f0'), nal('67f4000b919640507ec044000003000400000300503c50a920'), nal('68ebc3c44844')],
    sei: (bytes: number) => nal('06', seiBody(bytes)),
    key: (mark: number) => nal('65', Buffer.from([mark]), filler(3000)),
    delta: () => Buffer.concat([nal('09f0'), nal('41', filler(400))]),
  },
  h265: {
    streamType: 0x24,
    idr: 19,
    header: [
      nal('460150'),
      nal('40010c01ffff0408000003009e0800000300003c959809'),
      nal('4201010408000003009e0800000300003c90014101e2cb2b349265780b702020004000000300400000030282'),
      nal('4401c172860c4624'),
    ],
    sei: (bytes: number) => nal('4e01', seiBody(bytes)),
    key: (mark: number) => nal('2601', Buffer.from([mark]), filler(3000)),
    delta: () => Buffer.concat([nal('460150'), nal('0201', filler(400))]),
  },
};

function psi(pid: number, section: number[]): Buffer {
  const pkt = Buffer.alloc(TS, 0xff);
  // pointer field 0, then the section; nobody here checks the CRC, four bytes stand in for it
  Buffer.from([0x47, 0x40 | (pid >> 8), pid & 0xff, 0x10, 0x00, ...section, 0, 0, 0, 0]).copy(pkt);
  return pkt;
}
const pat = () => psi(0, [0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xe0 | (PMT_PID >> 8), PMT_PID & 0xff]);
const pmt = (streamType: number) =>
  psi(PMT_PID, [0x02, 0xb0, 0x12, 0x00, 0x01, 0xc1, 0x00, 0x00, 0xe0 | (VIDEO_PID >> 8), VIDEO_PID & 0xff, 0xf0, 0x00, streamType, 0xe0 | (VIDEO_PID >> 8), VIDEO_PID & 0xff, 0xf0, 0x00]);

/** One access unit as a PES packet with a PTS, cut into TS packets (the last one padded by an adaptation field). */
function pes(pts: number, es: Buffer, counter: { value: number }): Buffer[] {
  const stamp = [0x21 | ((Math.floor(pts / 2 ** 30) & 7) << 1), (pts >>> 22) & 0xff, ((pts >>> 14) & 0xfe) | 1, (pts >>> 7) & 0xff, ((pts << 1) & 0xfe) | 1];
  const data = Buffer.concat([Buffer.from([0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5, ...stamp]), es]);
  const out: Buffer[] = [];
  for (let at = 0; at < data.length;) {
    const left = data.length - at;
    const pkt = Buffer.alloc(TS, 0xff);
    const head = [0x47, (at === 0 ? 0x40 : 0) | (VIDEO_PID >> 8), VIDEO_PID & 0xff];
    counter.value = (counter.value + 1) & 0x0f;
    let payloadAt = 4;
    if (left < TS - 4) {
      const stuffing = TS - 5 - left;
      Buffer.from([...head, 0x30 | counter.value, stuffing, ...(stuffing > 0 ? [0x00] : [])]).copy(pkt);
      payloadAt = 5 + stuffing;
    } else {
      Buffer.from([...head, 0x10 | counter.value]).copy(pkt);
    }
    data.copy(pkt, payloadAt, at, at + TS - payloadAt);
    at += TS - payloadAt;
    out.push(pkt);
  }
  return out;
}

/**
 * `gops` groups of ten frames at 10 fps. `seiBytes` > 0 puts an SEI of that size between the parameter sets and the
 * picture of every keyframe, which moves the picture out of the first TS packet; `keyframes: false` sends no
 * keyframe at all; `ptsOffset` moves the clock of the stream (ticks of 90 kHz, wrapping at 33 bits like a real one).
 */
function stream(codec: VideoCodec, opts: { gops: number; seiBytes?: number; keyframes?: boolean; firstGop?: number; ptsOffset?: number; h264Aud?: boolean }): Buffer {
  const c = CODECS[codec];
  const counter = { value: 0 };
  const out: Buffer[] = [];
  for (let gop = opts.firstGop ?? 0; gop < (opts.firstGop ?? 0) + opts.gops; gop++) {
    for (let frame = 0; frame < 10; frame++) {
      const pts = (90_000 + (opts.ptsOffset ?? 0) + (gop * 10 + frame) * 9000) % 2 ** 33;
      if (frame === 0) out.push(pat(), pmt(c.streamType));
      const key = frame === 0 && opts.keyframes !== false;
      const es = key ? Buffer.concat([...c.header, ...(opts.seiBytes ? [c.sei(opts.seiBytes)] : []), c.key(gop + 1)]) : c.delta();
      // go2rtc's Xiaomi HEVC transport stream also prefixes each access unit with this AVC delimiter.
      out.push(...pes(pts, opts.h264Aud ? Buffer.concat([nal('09f0'), es]) : es, counter));
    }
  }
  return Buffer.concat(out);
}

// the stream itself is what it claims to be: where the picture of a keyframe starts
for (const codec of ['h264', 'h265'] as const) {
  const firstPacketOfKeyframe = (seiBytes: number) => stream(codec, { gops: 1, seiBytes }).subarray(2 * TS, 3 * TS);
  const hasPicture = (pkt: Buffer) => [...nalUnits(pkt.subarray(4 + 14))].some((n) => nalType(n, codec) === CODECS[codec].idr);
  assert.equal(hasPicture(firstPacketOfKeyframe(0)), true, `${codec}: without an SEI the picture starts in the first TS packet`);
  assert.equal(hasPicture(firstPacketOfKeyframe(200)), false, `${codec}: with a 200-byte SEI the picture starts in a later TS packet`);
}

// ---------------------------------------------------------------- the recorder

interface Logged {
  level: string;
  message: string;
}

function recorder(name: string, opts: { mode?: 'continuous' | 'event'; store?: Store; onState?: (recording: boolean) => void } = {}) {
  const store = opts.store ?? new Store(join(dir, `${name}.db`));
  const logs: Logged[] = [];
  const states: boolean[] = [];
  const rec = new Recorder({
    cameraId: name,
    role: 'high',
    rtspUrl: 'rtsp://unused',
    ffmpegPath: 'ffmpeg',
    dir: join(dir, name),
    store,
    mode: opts.mode ?? 'continuous',
    preBufferSec: 0,
    postBufferSec: 0,
    segmentSec: 60,
    log: (level, message) => logs.push({ level, message }),
    onStateChange: (recording) => {
      states.push(recording);
      opts.onState?.(recording);
    },
    onSegment: noop,
  });
  return { rec, store, logs, states, feed: (chunk: Buffer) => (rec as unknown as { onData(c: Buffer): void }).onData(Buffer.from(chunk)) };
}

// ------------------------------------------- 1. keyframes behind a long header

for (const codec of ['h264', 'h265'] as const) {
  // SEI sizes that put the start code of the picture across the end of the first TS packet: all of it in the first
  // packet with the NAL type in the second, then three, two and one of its bytes, then all of it in the second
  const esInFirstPacket = TS - 4 - 14;
  const pictureAt = (seiBytes: number) => Buffer.concat([...CODECS[codec].header, CODECS[codec].sei(seiBytes)]).length;
  const split = [4, 3, 2, 1, 0].map((before) => esInFirstPacket - before - pictureAt(0));
  assert.deepEqual(
    split.map((seiBytes) => esInFirstPacket - pictureAt(seiBytes)),
    [4, 3, 2, 1, 0],
  );
  for (const seiBytes of [0, 200, 2400, ...split]) {
    const name = `${codec}-sei${seiBytes}`;
    const { rec, store, feed } = recorder(name);
    feed(stream(codec, { gops: 4, seiBytes }));
    await rec.stop();
    const [segment] = store.segments(name, 'high', 0, Number.MAX_SAFE_INTEGER);
    assert.ok(segment, `${name}: nothing was recorded: the keyframes of the stream were not found`);
    const keyframes = parseKeyframes(segment.keyframes);
    assert.equal(keyframes.length, 4, `${name}: every keyframe is in the index`);
    assert.equal(segment.bytes, statSync(segment.path).size, `${name}: the index knows the size of the file`);
    // the index points at the packet the keyframe starts in: the reader finds exactly that picture there
    for (const [i, keyframe] of keyframes.entries()) {
      const frame = await readKeyframe(segment, keyframe);
      const picture = [...nalUnits(frame?.data ?? Buffer.alloc(0))].find((n) => nalType(n, codec) === CODECS[codec].idr);
      assert.equal(picture?.[codec === 'h264' ? 1 : 2], i + 1, `${name}: keyframe ${i + 1} is read back from its index entry`);
    }
    store.close();
  }
}

// Xiaomi HEVC through go2rtc: an AVC access-unit delimiter precedes the actual HEVC NAL units.
for (const seiBytes of [0, 200, 2400]) {
  const name = `xiaomi-hevc-sei${seiBytes}`;
  const { rec, store, feed } = recorder(name);
  feed(stream('h265', { gops: 4, seiBytes, h264Aud: true }));
  await rec.stop();
  const [segment] = store.segments(name, 'high', 0, Number.MAX_SAFE_INTEGER);
  assert.ok(segment, `${name}: HEVC behind an AVC delimiter must still record`);
  const keyframes = parseKeyframes(segment.keyframes);
  assert.equal(keyframes.length, 4, 'every Xiaomi keyframe is indexed');
  for (const [i, keyframe] of keyframes.entries()) {
    const frame = await readKeyframe(segment, keyframe);
    const picture = [...nalUnits(frame?.data ?? Buffer.alloc(0))].find((n) => nalType(n, 'h265') === CODECS.h265.idr);
    assert.equal(picture?.[2], i + 1, 'the recorded keyframe can be read back for playback');
  }
  store.close();
}

// the rest runs on a clock the spec moves: the recorder reads the time for its flushes and its warning
const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;
const settle = () => new Promise((resolve) => setTimeout(resolve, 200));
const unhandled: unknown[] = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));

// ------------------------------------------- 2. video without keyframes is said once

{
  const warnings = (logs: Logged[]) => logs.filter((l) => l.level === 'warn' && l.message.includes('keyframe'));
  const blind = recorder('no-keyframes');
  const fine = recorder('with-keyframes');
  for (let second = 0; second < 90; second++) {
    blind.feed(stream('h264', { gops: 1, firstGop: second, keyframes: false }));
    fine.feed(stream('h264', { gops: 1, firstGop: second, seiBytes: 200 }));
    if (second === 29) assert.equal(warnings(blind.logs).length, 0, 'half a minute without a keyframe is not reported yet');
    clock += 1000;
  }
  assert.equal(warnings(blind.logs).length, 1, `video without keyframes is reported, once: ${JSON.stringify(warnings(blind.logs))}`);
  assert.match(warnings(blind.logs)[0].message, /\[no-keyframes\/high\]/);
  assert.equal(blind.rec.isRecording, false);
  assert.equal(warnings(fine.logs).length, 0, 'a stream with keyframes is never reported');
  assert.equal(fine.rec.isRecording, true);
  await blind.rec.stop();
  await fine.rec.stop();
  // the file closed at the 60 s rollover finishes on its own: its index is written before the database goes
  await settle();
  assert.deepEqual(
    fine.logs.filter((l) => l.level === 'error'),
    [],
  );
  assert.equal(fine.store.segments('with-keyframes', 'high', 0, Number.MAX_SAFE_INTEGER).length, 2, 'a minute and a half is two files');
  blind.store.close();
  fine.store.close();
}

// ------------------------------------------- 3. a failing index database

/** A real store whose segment writes can be made to fail the way a full disk makes them fail. */
function breakable(name: string): { store: Store; state: { fail: boolean } } {
  const store = new Store(join(dir, `${name}.db`));
  const state = { fail: false };
  for (const method of ['addSegment', 'updateSegment', 'deleteSegment'] as const) {
    const real = (store[method] as (...args: unknown[]) => unknown).bind(store);
    (store as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
      if (state.fail) throw new Error('database or disk is full');
      return real(...args);
    };
  }
  return { store, state };
}
const indexErrors = (logs: Logged[]) => logs.filter((l) => l.level === 'error' && l.message.includes('index'));
const filesUnder = (path: string): string[] => (existsSync(path) ? readdirSync(path, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name) : []);

{
  // the periodic flush runs inside the stream handler: it must not throw there, and it catches up when the database is back
  const { store, state } = breakable('flush');
  const { rec, logs, feed } = recorder('flush', { store });
  feed(stream('h264', { gops: 2 }));
  assert.equal(rec.isRecording, true);
  state.fail = true;
  clock += 5000;
  assert.doesNotThrow(() => feed(stream('h264', { gops: 1, firstGop: 2 })), 'a failed index write must not throw out of the stream handler');
  assert.equal(rec.isRecording, true, 'the file keeps recording');
  assert.equal(indexErrors(logs).length, 1, 'the failure is reported');
  clock += 5000;
  feed(stream('h264', { gops: 1, firstGop: 3 }));
  assert.equal(indexErrors(logs).length, 1, 'once, not at every flush');
  assert.equal(parseKeyframes(store.segments('flush', 'high', 0, Number.MAX_SAFE_INTEGER)[0].keyframes).length, 1, 'the row is as old as the last good write');
  state.fail = false;
  clock += 5000;
  feed(stream('h264', { gops: 1, firstGop: 4 }));
  assert.equal(parseKeyframes(store.segments('flush', 'high', 0, Number.MAX_SAFE_INTEGER)[0].keyframes).length, 5, 'the next flush writes everything recorded meanwhile');

  // closing with a failing database: awaited (stop) and not awaited (stream end) alike
  state.fail = true;
  (rec as unknown as { onStreamEnd(reason: string, startedAt: number): void }).onStreamEnd('spec', clock);
  await settle();
  assert.deepEqual(unhandled, [], 'a close nobody awaits must not reject unhandled');
  assert.equal(indexErrors(logs).length, 2, 'the lost index of the file is reported');
  assert.equal(rec.isRecording, false);
  await rec.stop();
  store.close();
}
{
  const { store, state } = breakable('stop');
  const { rec, logs, feed } = recorder('stop', { store });
  feed(stream('h264', { gops: 2 }));
  state.fail = true;
  await assert.doesNotReject(rec.stop(), 'stop() with a failing database');
  assert.equal(indexErrors(logs).length, 1);
  store.close();
}
{
  // whatever else fails in a close nobody awaits is logged, never left as an unhandled rejection
  const { rec, store, logs, feed } = recorder('callback', {
    onState: (recording) => {
      if (!recording) throw new Error('listener failed');
    },
  });
  feed(stream('h264', { gops: 2 }));
  (rec as unknown as { onStreamEnd(reason: string, startedAt: number): void }).onStreamEnd('spec', clock);
  await settle();
  assert.deepEqual(unhandled, []);
  assert.ok(
    logs.some((l) => l.level === 'error' && l.message.includes('listener failed')),
    'the failure is in the log',
  );
  await rec.stop().catch(noop);
  store.close();
}
{
  // a segment that cannot be put into the index leaves no open file behind, and recording starts when the database is back
  const { store, state } = breakable('insert');
  const { rec, logs, feed } = recorder('insert', { store });
  state.fail = true;
  assert.doesNotThrow(() => feed(stream('h264', { gops: 3 })));
  assert.equal(rec.isRecording, false);
  assert.equal(logs.filter((l) => l.level === 'error' && l.message.includes('cannot open a segment')).length, 3, 'every attempt is reported');
  await settle();
  assert.deepEqual(filesUnder(join(dir, 'insert')), [], 'no file stays for a segment that has no row');
  state.fail = false;
  feed(stream('h264', { gops: 2, firstGop: 3 }));
  assert.equal(rec.isRecording, true, 'recording starts at the next keyframe once the database works');
  await rec.stop();
  assert.equal(filesUnder(join(dir, 'insert')).length, 1);
  store.close();
}

{
  // the disk fails under the open file while the database fails too: the lost index of the file is said, once
  const { store, state } = breakable('broken-file');
  const { rec, logs, feed } = recorder('broken-file', { store });
  feed(stream('h264', { gops: 2 }));
  state.fail = true;
  (rec as unknown as { segment: { stream: { destroy(error: Error): void } } }).segment.stream.destroy(new Error('ENOSPC: no space left on device'));
  await settle();
  assert.equal(rec.isRecording, false, 'the broken file is given up');
  assert.equal(logs.filter((l) => l.level === 'error' && l.message.includes('write failed')).length, 1);
  assert.equal(indexErrors(logs).length, 1, `the index that could not be written for the broken file is reported: ${JSON.stringify(logs)}`);
  await rec.stop();
  store.close();
}
{
  // the flush before it has reported the failing database already: one report for the run of failures of a file
  const { store, state } = breakable('broken-file-again');
  const { rec, logs, feed } = recorder('broken-file-again', { store });
  feed(stream('h264', { gops: 2 }));
  state.fail = true;
  clock += 5000;
  feed(stream('h264', { gops: 1, firstGop: 2 }));
  assert.equal(indexErrors(logs).length, 1, 'the failed flush is reported');
  (rec as unknown as { segment: { stream: { destroy(error: Error): void } } }).segment.stream.destroy(new Error('ENOSPC: no space left on device'));
  await settle();
  assert.equal(rec.isRecording, false);
  assert.equal(indexErrors(logs).length, 1, 'and not a second time when the file breaks');
  await rec.stop();
  store.close();
}

// ------------------------------------------- 4. stop() waits for a file that is still closing

{
  const { rec, store, logs, feed } = recorder('rollover');
  const second = (n: number) => {
    feed(stream('h264', { gops: 1, firstGop: n }));
    clock += 1000;
  };
  for (let n = 0; n < 59; n++) second(n);
  // a busy disk: the last bytes of the first file are written 300 ms after it is cut at its length
  const first = (rec as unknown as { segment: { id: number; path: string; stream: { end(done: () => void): void } } }).segment;
  const end = first.stream.end.bind(first.stream);
  first.stream.end = (done) => void setTimeout(() => end(done), 300);
  for (let n = 59; n < 62; n++) second(n);
  assert.notEqual(rec.liveSegmentId, first.id, 'the first file was cut after a minute');
  await rec.stop();
  // the plugin closes the database as soon as its recorders have stopped
  const row = store.segment(first.id)!;
  assert.equal(parseKeyframes(row.keyframes).length, 60, 'stop() waited for the file that was still closing: its index is complete');
  assert.equal(row.bytes, statSync(first.path).size, 'with the size of the file');
  store.close();
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(
    logs.filter((l) => l.level === 'error'),
    [],
    'nothing is written to the index after the database was closed',
  );
  assert.deepEqual(unhandled, []);
}

// ------------------------------------------- 5. the time of a frame

const US = 1_000_000;
/** The time the index has for every keyframe of a camera, in microseconds after `t0` (a clock value in ms), in the order recorded. */
const keyframeTimes = (store: Store, camera: string, t0: number) =>
  store
    .segments(camera, 'high', 0, Number.MAX_SAFE_INTEGER)
    .flatMap((segment) => parseKeyframes(segment.keyframes))
    .map((keyframe) => keyframe.tsUs - t0 * 1000);
/** Records a stream of one-second GOPs: GOP `n` is fed when the clock is `t0 + arrival(n)` ms. */
async function timesOf(name: string, gops: number, arrival: (n: number) => number, ptsOffset: (n: number) => number = () => 0): Promise<number[]> {
  const t0 = clock;
  const { rec, store, feed } = recorder(name);
  for (let n = 0; n < gops; n++) {
    clock = t0 + arrival(n);
    feed(stream('h264', { gops: 1, firstGop: n, ptsOffset: ptsOffset(n) }));
  }
  await rec.stop();
  const times = keyframeTimes(store, name, t0);
  store.close();
  clock = t0 + arrival(gops - 1) + 1000;
  return times;
}
const seconds = (count: number, from = 0) => Array.from({ length: count }, (_, n) => (from + n) * US);

// 5a. what does not change: every case here is stamped by the recorder exactly as it was before frames kept their
// spacing over a stall, to the microsecond
{
  // a healthy stream: a second of video every second, some of it up to three seconds late
  const lateMs = [0, 300, 1200, 2100, 3000, 2000, 1000, 0, 800, 1700, 2600, 1600];
  assert.deepEqual(await timesOf('time-healthy', 12, (n) => n * 1000 + lateMs[n]), seconds(12), 'a frame is stamped by the arrival of the first one plus the clock of the stream');
  // the 33-bit clock of the stream wraps around (every 26.5 hours): nothing to see in the times
  assert.deepEqual(await timesOf('time-wrap', 12, (n) => n * 1000, () => 2 ** 33 - 4 * 90_000), seconds(12), 'over the wrap of the PTS');
  // the camera restarts its clock, forward or back by two hours: the new clock starts at the moment its first frame arrives
  const restarted = (n: number) => (n < 5 ? 2 * 3600 * 90_000 : 0);
  assert.deepEqual(await timesOf('time-pts-back', 10, (n) => n * 1000, restarted), seconds(10), 'the PTS jumps back');
  assert.deepEqual(await timesOf('time-pts-forward', 10, (n) => n * 1000, (n) => 2 * 3600 * 90_000 - restarted(n)), seconds(10), 'the PTS jumps forward');
  // eight seconds of video come at once when the connection is made (the cache of the restreamer), the rest as it
  // is filmed: a frame more than 5 s ahead of the wall clock takes the wall clock, and the stream goes on from there
  assert.deepEqual(
    await timesOf('time-cache', 12, (n) => Math.max(0, n - 7) * 1000),
    [...seconds(6), ...seconds(6).map((us) => us + 900_000)],
    'video ahead of the wall clock',
  );
  // the clock of the server is set back by an hour: the next frame takes the new time
  assert.deepEqual(await timesOf('time-clock-back', 10, (n) => (n < 5 ? n * 1000 : n * 1000 - 3600_000)), [...seconds(5), ...seconds(5, 5).map((us) => us - 3600 * US)], 'the wall clock set back');
}
{
  // fourteen hours of one connection, a keyframe every 4.9 s: longer than half of what 33 bits of PTS can tell apart
  const t0 = clock;
  const { rec, store, feed } = recorder('time-day', { mode: 'event' });
  const counter = { value: 0 };
  const stepTicks = 441_000;
  const picture = Buffer.concat([...CODECS.h264.header, nal('65', filler(40))]);
  const wrong: string[] = [];
  for (let n = 0; n < 10_300 && wrong.length < 3; n++) {
    clock = t0 + n * 4900;
    feed(Buffer.concat([pat(), pmt(CODECS.h264.streamType), ...pes(90_000 + n * stepTicks, picture, counter)]));
    const tsUs = (rec as unknown as { gop?: { tsUs: number } }).gop?.tsUs;
    if (tsUs !== clock * 1000) wrong.push(`keyframe ${n} (${((n * 4.9) / 3600).toFixed(2)} h): ${tsUs === undefined ? 'none' : (tsUs - clock * 1000) / US} s off`);
  }
  assert.deepEqual(wrong, [], 'every keyframe of a long connection has the time of its arrival');
  await rec.stop();
  store.close();
  clock = t0 + 15 * 3600_000;
}

// 5b. what changes: frames that arrive late keep the spacing the camera gave them
{
  // the process is busy for 30 s (a statistics query, a re-index): what the camera sent meanwhile waits in the socket
  // and comes at once, with the second that is filmed just then; after that the stream is on time again
  const stalled = await timesOf('time-stall', 45, (n) => (n < 5 ? n : Math.max(n, 35)) * 1000);
  assert.deepEqual(stalled, seconds(45), 'video that waited through a stall is stamped by the clock of the stream, not moved by the length of the stall');
}
{
  // two stalls with a part of the waiting video read between them, 30 s and 60 s: no frame of it is on time for
  // more than a minute, and still it is a stall, not a camera clock that runs slow
  const arrival = (n: number) => (n < 5 ? n : n < 10 ? 35 : Math.max(n, 95)) * 1000;
  assert.deepEqual(await timesOf('time-stalls', 100, arrival), seconds(100), 'two stalls in a row move nothing either');
}
{
  // the clock of the camera runs 5 % slow: a second of its video takes 1.05 s. The recorded time falls behind the
  // wall clock; once every frame has been more than 5 s late for a minute it is brought back by the smallest lag
  const slow = await timesOf('time-drift', 240, (n) => n * 1050);
  const lags = slow.map((us, n) => n * 1_050_000 - us);
  assert.ok(Math.max(...lags) <= 9 * US, `the recorded time stays near the wall clock: at most ${Math.max(...lags) / US} s behind`);
  const steps = slow.slice(1).map((us, i) => us - slow[i]);
  const corrected = steps.flatMap((step, i) => (step === US ? [] : [{ keyframe: i + 1, step }]));
  assert.deepEqual(corrected, [{ keyframe: 177, step: 6_050_000 }], 'one correction, after a minute of frames more than 5 s late, by the smallest lag of that minute');
  assert.equal(lags[177], 3_800_000);
}
{
  // the clock of the server is set forward by an hour (the first time sync after a start without one): every frame
  // is an hour late from then on, which is not a stall, and the recorded time follows within a minute
  const set = await timesOf('time-clock-forward', 80, (n) => (n < 5 ? n * 1000 : n * 1000 + 3600_000));
  assert.deepEqual(set.slice(0, 65), seconds(65), 'for a minute the frames keep the clock they were anchored to');
  assert.deepEqual(set.slice(65), seconds(15, 65).map((us) => us + 3600 * US - 900_000), 'then the new time, to the frame that is least late');
}

Date.now = realNow;

// ------------------------------------------- 9. sound on: where the stream comes from

{
  const ts = 'https://127.0.0.1:2000/api/stream.ts?src=cam+a&video=all';
  const probe = new URL(probeUrlOf(ts)!);
  assert.equal(probe.pathname, '/api/streams');
  assert.equal(probe.searchParams.get('src'), 'cam a');
  assert.equal(probe.searchParams.get('audio'), 'all');
  assert.equal(probeUrlOf('rtsp://127.0.0.1:2001/cam'), undefined, 'not go2rtc MPEG-TS: nothing to ask');

  // what go2rtc answered for the bench's cameras: a Xiaomi sends Opus and has a talk channel, a Dahua sends no sound
  assert.equal(sendsAudio({ producers: [{ medias: ['video, recvonly, H265', 'audio, recvonly, OPUS/48000/2', 'audio, sendonly, OPUS/48000/2'] }] }), true);
  assert.equal(sendsAudio({ producers: [{ medias: ['video, recvonly, H264'] }, {}] }), false);
  assert.equal(sendsAudio({ producers: [{ medias: ['video, recvonly, H264', 'audio, sendonly, PCMA/8000'] }] }), false, 'a talk channel is no sound of the camera');
  for (const nothing of [undefined, null, 'x', { producers: 'x' }]) assert.equal(sendsAudio(nothing), false);

  const both = ffmpegArgs({ rtspUrl: 'rtsp://r', tsUrl: ts, audioUrl: 'rtsp://a?audio', audio: true }, true);
  assert.deepEqual(both.filter((_, i) => both[i - 1] === '-i'), [ts, 'rtsp://a?audio'], 'the video of the MPEG-TS, the sound of RTSP');
  assert.ok(both.join(' ').includes('-map 0:v:0 -map 1:a:0? -c:v copy -c:a aac'), both.join(' '));
  const plain = ffmpegArgs({ rtspUrl: 'rtsp://r', audio: false }, false);
  assert.ok(plain.join(' ').includes('-i rtsp://r -map 0:v:0 -c copy -an'), plain.join(' '));
}
{
  // a go2rtc of three cameras: one with sound, one without, one whose probe fails
  const seen: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    const src = url.searchParams.get('src') ?? '';
    seen.push(`${url.pathname} ${src}`);
    if (url.pathname === '/api/streams') {
      if (src === 'broken') {
        res.writeHead(500).end();
        return;
      }
      const medias = src === 'xiaomi' ? ['video, recvonly, H265', 'audio, recvonly, OPUS/48000/2'] : ['video, recvonly, H264'];
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ producers: [{ medias }] }));
      return;
    }
    // the MPEG-TS stays open, as go2rtc's does
    res.writeHead(200, { 'content-type': 'video/mp2t' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const waitFor = async (what: () => boolean) => {
    for (let i = 0; i < 60 && !what(); i++) await new Promise((r) => setTimeout(r, 50));
    return what();
  };
  const start = (name: string, audio: boolean) => {
    const logs: Logged[] = [];
    const rec = new Recorder({
      cameraId: name,
      role: 'high',
      rtspUrl: `rtsp://127.0.0.1:1/${name}`,
      tsUrl: `http://127.0.0.1:${port}/api/stream.ts?src=${name}&video=all`,
      audioUrl: audio ? `rtsp://127.0.0.1:1/${name}?audio` : undefined,
      audio,
      // no ffmpeg here: starting it is seen as its failure to start
      ffmpegPath: join(dir, 'no-ffmpeg'),
      dir: join(dir, `sound-${name}`),
      store: new Store(join(dir, `sound-${name}.db`)),
      mode: 'continuous',
      preBufferSec: 0,
      postBufferSec: 0,
      segmentSec: 60,
      log: (level, message) => logs.push({ level, message }),
      onStateChange: noop,
      onSegment: noop,
    });
    rec.start();
    return { rec, logs, ffmpeg: () => logs.some((l) => l.message.includes('ffmpeg')) };
  };

  // without sound in the stream the MPEG-TS is read as without the setting: no ffmpeg (a Dahua with sound on recorded
  // nothing through ffmpeg's copy before)
  const dahua = start('dahua', true);
  assert.ok(await waitFor(() => seen.includes('/api/stream.ts dahua')), seen.join(', '));
  assert.ok(seen.includes('/api/streams dahua'), 'go2rtc was asked first');
  assert.equal(dahua.ffmpeg(), false);
  // with sound ffmpeg takes the MPEG-TS and the sound; the recorder itself does not read the MPEG-TS
  const xiaomi = start('xiaomi', true);
  assert.ok(await waitFor(xiaomi.ffmpeg), JSON.stringify(xiaomi.logs));
  assert.ok(!seen.includes('/api/stream.ts xiaomi'), seen.join(', '));
  // go2rtc does not say: the video is recorded, without sound
  const broken = start('broken', true);
  assert.ok(await waitFor(() => seen.includes('/api/stream.ts broken')), seen.join(', '));
  assert.equal(broken.ffmpeg(), false);
  // sound off: no question at all
  const quiet = start('quiet', false);
  assert.ok(await waitFor(() => seen.includes('/api/stream.ts quiet')));
  assert.ok(!seen.includes('/api/streams quiet'));

  await Promise.all([dahua, xiaomi, broken, quiet].map((r) => r.rec.stop()));
  server.closeAllConnections();
  server.close();
}

console.log(
  'recorder.spec: keyframes behind parameter sets and a long SEI (H.264, HEVC), no-keyframe warning, failing index database, broken file, stop() waits for a closing file, frame times (healthy stream as before, stalls, drift), sound on: the MPEG-TS video with the sound of the camera, the MPEG-TS alone without sound — ok',
);
process.exit(0);
