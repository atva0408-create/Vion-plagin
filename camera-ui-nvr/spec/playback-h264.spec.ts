// A browser that cannot decode H.265 asks for the low stream (ui/src/nvr/playback.ts falls back to it). Where the
// time has a low recording it gets that, as before; where only the H.265 recording is, it gets that made H.264 while
// it plays (src/media/transcode.ts), told as H.264 before the first frame, every frame at its recorded time. A client
// that decodes H.265 still gets the recording as it is. Real plugin class, real recorders, real time (a few seconds).
// Needs ffmpeg with libx265 and libx264 on PATH (or CAMERAUI_FFMPEG_PATH). Run: npx tsx spec/playback-h264.spec.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import VionNvr from '../src/index.js';
import { probeCodec } from '../src/media/codec.js';
import { LIBX264 } from '../src/media/transcode.js';
import { readFrames } from '../src/reader.js';
import { parseKeyframes } from '../src/store.js';
import { Recorder } from '../src/recorder.js';

import type { H264Encoder } from '../src/media/transcode.js';
import type { SegmentRow, Store } from '../src/store.js';

const disk = { blocks: 1000, bavail: 500, bsize: 4096 };
fsp.statfs = (async () => disk) as unknown as typeof fsp.statfs;
syncBuiltinESMExports();

const dir = mkdtempSync(join(tmpdir(), 'nvr-playback-h264-'));
const FFMPEG = process.env.CAMERAUI_FFMPEG_PATH ?? 'ffmpeg';
const noop = () => undefined;
const realNow = Date.now;

function stream(codec: 'libx264' | 'libx265'): Buffer {
  const path = join(dir, `${codec}.ts`);
  const params = codec === 'libx265' ? ['-x265-params', 'keyint=10:min-keyint=10:bframes=0:log-level=error'] : ['-g', '10', '-bf', '0'];
  const made = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=10', '-t', '3', '-c:v', codec, ...params, '-f', 'mpegts', path], {
    encoding: 'utf8',
  });
  assert.equal(made.status, 0, `ffmpeg could not make a stream: ${made.stderr}`);
  return readFileSync(path);
}

interface Internals {
  cameras: Map<string, unknown>;
  store: Store;
  ffmpegPath: string;
  h264Encoder?: Promise<H264Encoder>;
}
const api = {
  storagePath: dir,
  on: noop,
  once: noop,
  emit: noop,
  notificationManager: { publish: async () => undefined },
  downloadManager: { createDownload: async () => ({ url: '' }) },
  coreManager: { assistantAccess: async () => ({ allowed: false }), getFFmpegPath: () => new Promise<string>(noop), getPluginsByInterface: async () => [] },
};
const storage = { values: {} as Record<string, unknown>, getValue: async () => undefined, setValue: async () => undefined };
const nvr = new VionNvr({ log: noop, warn: noop, error: console.error, debug: noop, attention: noop, trace: noop } as never, api as never, storage as never);
const internals = nvr as unknown as Internals;
for (const id of ['cam', 'old', 'subs']) internals.cameras.set(id, { device: { id, name: id }, recorders: new Map(), subscriptions: [] });
internals.ffmpegPath = FFMPEG;
// libx264 here whatever the machine has: the hardware ones are the encoder spec's
internals.h264Encoder = Promise.resolve(LIBX264);

/** Three seconds recorded by a real recorder at `atMs`, in pieces as from a camera. */
async function record(camera: string, role: string, data: Buffer, atMs: number): Promise<SegmentRow> {
  const rec = new Recorder({
    cameraId: camera,
    role,
    rtspUrl: 'rtsp://unused',
    ffmpegPath: FFMPEG,
    dir: join(dir, 'recordings', camera),
    store: internals.store,
    mode: 'continuous',
    preBufferSec: 0,
    postBufferSec: 0,
    segmentSec: 600,
    log: noop,
    onStateChange: noop,
    onSegment: noop,
  });
  const pieces = 30;
  const size = Math.ceil(data.length / 188 / pieces) * 188;
  try {
    for (let i = 0; i < pieces; i++) {
      Date.now = () => atMs + i * 100;
      (rec as unknown as { onData(c: Buffer): void }).onData(Buffer.from(data.subarray(i * size, (i + 1) * size)));
    }
    await rec.stop();
  } finally {
    Date.now = realNow;
  }
  const row = internals.store.segments(camera, role, atMs * 1000, (atMs + 3000) * 1000).at(-1);
  assert.ok(row, `${camera} ${role} recorded`);
  return row;
}

/** What a client hears of a playback, in order. */
async function play(camera: string, tsUs: number, role: string) {
  const heard: { ready: { videoCodec: string; codecString: string; width: number; role?: string }[]; frames: { frame: Uint8Array; ts: number; keyframe?: boolean }[]; order: string[] } = {
    ready: [],
    frames: [],
    order: [],
  };
  const callbacks = {
    onReady: (payload: { videoCodec: string; codecString: string; width: number; role?: string }) => {
      heard.ready.push(payload);
      heard.order.push('ready');
    },
    onVideo: (payload: { frame: Uint8Array; ts: number; keyframe?: boolean }) => {
      heard.frames.push(payload);
      heard.order.push('video');
    },
    onNoData: () => void heard.order.push('end'),
  };
  for await (const _ of nvr.nvrPlayback(camera, tsUs, true, role, callbacks as never));
  return heard;
}

const times = async (row: SegmentRow) => {
  const out: number[] = [];
  for await (const frame of readFrames(internals.store.located(row), parseKeyframes(row.keyframes)[0]!)) out.push(frame.tsUs);
  return out;
};

async function main(): Promise<void> {
  const hevc = stream('libx265');
  const avc = stream('libx264');
  const at = realNow() - 600_000;
  const cam = await record('cam', 'high', hevc, at);
  assert.equal(cam.codec, 'h265');
  const recorded = await times(cam);

  // ---- only the H.265 recording, asked for the low stream: made H.264, told so before the first frame
  const low = await play('cam', cam.start_us, 'low');
  assert.equal(low.order[0], 'ready', 'told before any frame');
  assert.equal(low.ready[0]!.videoCodec, 'h264');
  assert.match(low.ready[0]!.codecString, /^avc1\./);
  assert.equal(low.ready[0]!.width, 640);
  assert.equal(low.ready.length, 1, 'told once');
  assert.deepEqual(
    low.frames.map((frame) => frame.ts),
    recorded,
    'every recorded frame at its time',
  );
  assert.ok(probeCodec(Buffer.from(low.frames[0]!.frame), 'h264'), 'the frames are H.264');
  assert.equal(low.order.at(-1), 'end');

  // ---- a client that decodes H.265 still gets the recording as it is
  const high = await play('cam', cam.start_us, 'high');
  assert.equal(high.ready[0]!.videoCodec, 'h265');
  assert.equal(high.ready[0]!.codecString, cam.codec_string);
  assert.deepEqual(
    high.frames.map((frame) => frame.ts),
    recorded,
  );

  // ---- scrub, the trace and the hover preview of a client without H.265: made H.264 the same way
  const target = recorded[15]!;
  const keyframeBefore = parseKeyframes(cam.keyframes).filter((kf) => kf.tsUs <= target).at(-1)!.tsUs;
  const coarse = await nvr.nvrScrub('cam', target, false, 'low');
  assert.equal(coarse.videoCodec, 'h264');
  assert.match(coarse.codecString!, /^avc1\./);
  assert.equal(coarse.ts, keyframeBefore, 'the keyframe before the time');
  assert.ok(probeCodec(Buffer.from(coarse.frame!), 'h264'));
  const fine = await nvr.nvrScrub('cam', target, true, 'low');
  assert.equal(fine.videoCodec, 'h264');
  assert.deepEqual(
    fine.frames!.map((frame) => frame.ts),
    recorded.filter((ts) => ts >= keyframeBefore && ts <= target),
    'from the keyframe up to the time',
  );
  assert.equal((await nvr.nvrScrub('cam', target, true, 'high')).videoCodec, 'h265', 'asked as it is: as it is');

  const trace = await nvr.nvrTraceFrames('cam', [{ tMs: target / 1000, src: 'low' } as never], 'exact');
  assert.equal(trace.chains.length, 1);
  assert.equal(trace.chains[0]!.videoCodec, 'h264');
  assert.equal(trace.chains[0]!.frames.at(-1)!.ts, target);
  assert.equal(trace.chains[0]!.keep[0]!.index, trace.chains[0]!.frames.length - 1);

  const hover = await nvr.nvrPreviewFrames('cam', cam.start_us, cam.end_us, 12, 'motion', 2_000_000, true);
  assert.equal(hover.videoCodec, 'h264');
  assert.ok(hover.frames.length >= 15, `hover frames ${hover.frames.length}`);
  assert.ok(hover.frames.every((frame) => recorded.includes(frame.ts)), 'at recorded times');
  assert.equal((await nvr.nvrPreviewFrames('cam', cam.start_us, cam.end_us, 12, 'motion', 2_000_000)).videoCodec, 'h265', 'a client with H.265: as it is');
  const strip = await nvr.nvrPreviewFrames('cam', cam.start_us, cam.end_us, 4, 'keyframes', 4_000_000, true);
  assert.equal(strip.videoCodec, 'h264');
  assert.ok(strip.frames.length >= 2 && strip.frames.every((frame) => frame.keyframe && probeCodec(Buffer.from(frame.frame), 'h264')), 'keyframes, each H.264');

  // ---- 'scrub' asks for the lightest recording, not for H.264: a browser with H.265 got every scrub and every
  // picture-in-picture playback made H.264 (100 ms instead of 10 a frame). One without H.265 falls back to 'low' itself
  // (ui/src/nvr/playback.ts recover)
  assert.equal((await nvr.nvrScrub('cam', target, false, 'scrub')).videoCodec, 'h265', 'a coarse scrub as it is');
  assert.equal((await nvr.nvrScrub('cam', target, true, 'scrub')).videoCodec, 'h265', 'a fine scrub as it is');
  assert.equal((await play('cam', cam.start_us, 'scrub')).ready[0]!.videoCodec, 'h265', 'a playback as it is');

  // ---- a time with a low recording (the archive of before, when the recorder kept the H.264 copy): that one
  const old = await record('old', 'high', hevc, at);
  const oldLow = await record('old', 'low', avc, at);
  const kept = await play('old', old.start_us, 'low');
  assert.equal(kept.ready[0]!.role, 'low');
  assert.equal(kept.ready[0]!.codecString, oldLow.codec_string, 'the recorded copy, not one made now');
  assert.deepEqual(
    kept.frames.map((frame) => frame.ts),
    await times(oldLow),
  );

  // ---- a lighter stream recorded in H.265 too (a camera recording its high and mid streams, both H.265): that one,
  // made H.264. It went as H.265 and the player had nothing left to fall back to
  await record('subs', 'high', hevc, at);
  const subsMid = await record('subs', 'mid', hevc, at);
  const sub = await play('subs', subsMid.start_us, 'low');
  assert.equal(sub.ready[0]!.role, 'mid', 'the lighter recording');
  assert.equal(sub.ready[0]!.videoCodec, 'h264', 'made H.264');
  assert.deepEqual(
    sub.frames.map((frame) => frame.ts),
    await times(subsMid),
  );
  assert.equal((await nvr.nvrScrub('subs', target, false, 'low')).videoCodec, 'h264');
  assert.equal((await nvr.nvrScrub('subs', target, false, 'scrub')).videoCodec, 'h265', 'a scrub as it is');

  console.log('playback-h264.spec: H.265 made H.264 for a low stream, told first, every frame at its time; H.265 as it is; an old copy played — ok');
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
