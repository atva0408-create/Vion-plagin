// A file of the recording whose keyframes are minutes apart (a Xiaomi file of 42 minutes had two, 2026-10-15). The
// exact picture of a time in it is decoded from the keyframe before, and that is bounded (300 frames): far from both
// keyframes the frames read stopped short of the time and were given as its picture.
// Needs ffmpeg with libx264 on PATH (or CAMERAUI_FFMPEG_PATH). Run: npx tsx spec/sparse-keyframes.spec.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { frameAt, patchesOf, patchOfPicture } from '../src/frames.js';
import { patchDiff } from '../src/gone.js';
import VionNvr from '../src/index.js';
import { Recorder } from '../src/recorder.js';
import { parseKeyframes } from '../src/store.js';

import type { Store } from '../src/store.js';

fsp.statfs = (async () => ({ blocks: 1000, bavail: 500, bsize: 4096 })) as unknown as typeof fsp.statfs;
syncBuiltinESMExports();

const dir = mkdtempSync(join(tmpdir(), 'nvr-sparse-'));
const FFMPEG = process.env.CAMERAUI_FFMPEG_PATH ?? 'ffmpeg';
const FFPROBE = FFMPEG.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
const noop = () => undefined;
const realNow = Date.now;
const S = 1_000_000;

// 160 s at 10 fps with keyframes at 0, 10 and 130 s only: the recorder starts its file at the second one (the first
// comes before it knows the codec), so the file has two keyframes two minutes apart
const file = join(dir, 'stream.ts');
const made = spawnSync(
  FFMPEG,
  ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10', '-t', '160', '-c:v', 'libx264', '-x264-params', 'keyint=10000:min-keyint=10000:scenecut=0', '-force_key_frames', '0,10,130', '-bf', '0', '-f', 'mpegts', file],
  { encoding: 'utf8' },
);
assert.equal(made.status, 0, `ffmpeg could not make a stream: ${made.stderr}`);
const stream = readFileSync(file);
// where each frame of it lies and its time, to give it to the recorder as a camera would, frame after frame
const probed = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pos,pts_time', '-of', 'csv=p=0', file], { encoding: 'utf8' });
assert.equal(probed.status, 0, probed.stderr);
const packets = probed.stdout
  .trim()
  .split(/\r?\n/)
  .map((line) => line.split(',').map(Number) as [number, number])
  .map(([ptsTime, pos]) => ({ ptsTime, pos }))
  .sort((a, b) => a.pos - b.pos);

const storagePath = join(dir, 'storage');
const api = {
  storagePath,
  on: noop,
  once: noop,
  emit: noop,
  notificationManager: { publish: async () => undefined },
  coreManager: { assistantAccess: async () => ({ allowed: false }), getFFmpegPath: () => new Promise<string>(noop), getPluginsByInterface: async () => [] },
};
const storage = { values: {} as Record<string, unknown>, getValue: async () => undefined, setValue: async () => undefined };
const nvr = new VionNvr({ log: noop, warn: noop, error: console.error, debug: noop, attention: noop, trace: noop } as never, api as never, storage as never);
const internals = nvr as unknown as { cameras: Map<string, unknown>; store: Store; ready: Promise<void>; stop(): Promise<void> };
await internals.ready;
internals.cameras.set('cam', { device: { id: 'cam', name: 'cam' }, recorders: new Map(), subscriptions: [] });

const atMs = realNow() - 3600_000;
const rec = new Recorder({
  cameraId: 'cam',
  role: 'high',
  rtspUrl: 'rtsp://unused',
  ffmpegPath: FFMPEG,
  dir: join(storagePath, 'recordings', 'cam'),
  store: internals.store,
  mode: 'continuous',
  preBufferSec: 0,
  postBufferSec: 0,
  segmentSec: 600,
  log: noop,
  onStateChange: noop,
  onSegment: noop,
});
try {
  const start = packets[0].ptsTime;
  for (const [i, packet] of packets.entries()) {
    Date.now = () => atMs + Math.round((packet.ptsTime - start) * 1000);
    (rec as unknown as { onData(c: Buffer): void }).onData(stream.subarray(i ? packet.pos : 0, packets[i + 1]?.pos ?? stream.length));
  }
  await rec.stop();
} finally {
  Date.now = realNow;
}
const [segment] = internals.store.segments('cam', 'high', atMs * 1000 - S, atMs * 1000 + 200 * S);
assert.ok(segment, 'recorded');
const keyframes = parseKeyframes(segment.keyframes).map((kf) => kf.tsUs);
assert.equal(keyframes.length, 2, `two keyframes in the file: ${keyframes.map((t) => (t - segment.start_us) / S).join(', ')}`);
const [k0, k1] = keyframes;
assert.ok(Math.abs(k1 - k0 - 120 * S) < 0.2 * S, `the second keyframe two minutes on: ${(k1 - k0) / S} s`);

// the picture ffmpeg decodes of a time of the file from its start, every frame on the way: what the time shows
const file_ = internals.store.located(segment);
const exactJpeg = (atUs: number) => {
  const offset = ((atUs - segment.start_us) / S).toFixed(3);
  const out = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file_.path, '-ss', offset, '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '3', 'pipe:1']);
  assert.equal(out.status, 0, out.stderr?.toString());
  return new Uint8Array(out.stdout);
};
const same = (a: Uint8Array | undefined, b: Uint8Array) => a !== undefined && Buffer.from(a).equals(Buffer.from(b));

// near the keyframe before: decoded to the very frame, as always
{
  const at = k0 + 2.05 * S;
  const fine = await nvr.nvrScrub('cam', at, true);
  assert.equal(fine.frames?.[0]?.keyframe, true);
  assert.ok(Math.abs(fine.ts - at) <= 0.1 * S, `the frame at the time: ${(fine.ts - k0) / S}`);
  assert.equal(fine.frames?.length, 22, 'from the keyframe to the first frame at or after the time');
  // the 300th frame from the keyframe is still decoded to: all 300 frames
  const last = await nvr.nvrScrub('cam', k0 + 29.9 * S, true);
  assert.equal(last.frames?.length, 300);
  assert.ok(Math.abs(last.ts - (k0 + 29.9 * S)) < 0.01 * S, `the frame at the time: ${(last.ts - k0) / S}`);
  // ffmpeg too: the frame of the time, not the keyframe after it (asked for the time, its seek landed between keyframes
  // and the decoder dropped all up to the next one, two minutes on)
  for (const ahead of [0, 2.1, 12.3, 29.5]) {
    assert.ok(same(await frameAt(FFMPEG, file_, k0 + ahead * S), exactJpeg(k0 + ahead * S)), `the picture of ${ahead} s past the keyframe`);
  }
  assert.ok(!same(await frameAt(FFMPEG, file_, k0 + 12.3 * S), exactJpeg(k0 + 12.4 * S)), 'and not the frame after it');
  // the patches of a stretch: from the keyframe before, with their times (there were none: the stretch ended before
  // the keyframe the decoder waited for); each looks as its own time does (the gradient of the picture's lower third
  // scrolls), not as the keyframe
  const lower = { x: 0, y: 0.67, width: 1, height: 0.33 };
  const patches = await patchesOf(FFMPEG, [file_], k0 + 13 * S, k0 + 15 * S, lower, 500);
  assert.deepEqual(
    patches.map((p) => (p.atMs * 1000 - k0) / S),
    [13, 13.5, 14, 14.5],
  );
  const looks = await Promise.all([0, 13, 13.5, 14, 14.5].map(async (t) => (await patchOfPicture(FFMPEG, exactJpeg(k0 + t * S), lower))!));
  for (const [i, patch] of patches.entries()) {
    const diffs = looks.map((look) => patchDiff(patch.pixels, look));
    assert.equal(diffs.indexOf(Math.min(...diffs)), i + 1, `patch ${i}: the look of its own time (${diffs.map((d) => d.toFixed(3)).join(', ')})`);
  }
}
// far from both keyframes: the nearest one, with its own time, not frames short of the time
for (const [what, at, nearest] of [
  ['nearer the one before', k0 + 50 * S, k0],
  ['nearer the one after', k0 + 100 * S, k1],
] as const) {
  const fine = await nvr.nvrScrub('cam', at, true);
  assert.equal(fine.noData, undefined, `${what}: the scrubber has a picture`);
  assert.equal(fine.ts, nearest, `${what}: the nearest keyframe, at its time (${(fine.ts - k0) / S} s)`);
  assert.equal(fine.frames?.length, 1);
  assert.equal(fine.frames?.[0]?.keyframe, true);

  const exact = await nvr.nvrTraceFrames('cam', [{ tMs: at / 1000 }], 'exact');
  const chain = exact.chains[0];
  assert.equal(exact.missing, undefined, `${what}: the trace has a picture`);
  assert.equal(chain.frames.length, 1);
  assert.equal(chain.frames[0].ts, nearest, `${what}: the trace's picture at its time (${(chain.frames[0].ts - k0) / S} s)`);
  assert.deepEqual(chain.keep, [{ target: 0, index: 0, exact: false }]);

  assert.ok(same(await frameAt(FFMPEG, file_, at), exactJpeg(nearest)), `${what}: ffmpeg's picture is the nearest keyframe`);
}
// a stretch far from the keyframe before: its patches from the next keyframe on, with their times
{
  const patches = await patchesOf(FFMPEG, [file_], k0 + 100 * S, k0 + 122 * S, { x: 0, y: 0, width: 1, height: 1 }, 500);
  assert.deepEqual(
    patches.map((p) => Math.round((p.atMs * 1000 - k1) / 1000) / 1000),
    [0, 0.5, 1, 1.5],
  );
}

await internals.stop();
console.log('sparse-keyframes.spec: a time is decoded from the keyframe before it; far from it, the nearest keyframe is its picture — ok');
process.exit(0);
