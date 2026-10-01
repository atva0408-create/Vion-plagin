// The recorder against a synthetic MPEG-TS, without a camera and without ffmpeg: a keyframe whose picture starts
// after the first TS packet (parameter sets and a long SEI in front of it) is found and indexed where the reader
// looks for it, video without keyframes is reported once, and a failing index database neither throws out of the
// stream handler nor rejects unhandled (either one ends the plugin process and with it the recording of every camera).
// Run: npx tsx spec/recorder.spec.ts
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { nalType, nalUnits } from '../src/media/ts-demux.js';
import { readKeyframe } from '../src/reader.js';
import { Recorder } from '../src/recorder.js';
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
 * keyframe at all.
 */
function stream(codec: VideoCodec, opts: { gops: number; seiBytes?: number; keyframes?: boolean; firstGop?: number }): Buffer {
  const c = CODECS[codec];
  const counter = { value: 0 };
  const out: Buffer[] = [];
  for (let gop = opts.firstGop ?? 0; gop < (opts.firstGop ?? 0) + opts.gops; gop++) {
    for (let frame = 0; frame < 10; frame++) {
      const pts = 90_000 + (gop * 10 + frame) * 9000;
      if (frame === 0) out.push(pat(), pmt(c.streamType));
      const key = frame === 0 && opts.keyframes !== false;
      const es = key ? Buffer.concat([...c.header, ...(opts.seiBytes ? [c.sei(opts.seiBytes)] : []), c.key(gop + 1)]) : c.delta();
      out.push(...pes(pts, es, counter));
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

Date.now = realNow;
console.log('recorder.spec: keyframes behind parameter sets and a long SEI (H.264, HEVC), no-keyframe warning, failing index database — ok');
process.exit(0);
