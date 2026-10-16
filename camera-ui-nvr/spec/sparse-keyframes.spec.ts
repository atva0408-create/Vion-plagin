// A file of the recording whose keyframes are minutes apart (a Xiaomi file of 42 minutes had two, 2026-10-15). The
// exact picture of a time in it is decoded from the keyframe before, and that is bounded (300 frames): far from both
// keyframes the frames read stopped short of the time and were given as its picture.
// Needs ffmpeg with libx264 on PATH (or CAMERAUI_FFMPEG_PATH). Run: npx tsx spec/sparse-keyframes.spec.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

// 150 s at 10 fps with keyframes at 0 and 120 s only: two keyframes two minutes apart in one file
const file = join(dir, 'stream.ts');
const made = spawnSync(
  FFMPEG,
  ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10', '-t', '150', '-c:v', 'libx264', '-x264-params', 'keyint=10000:min-keyint=10000:scenecut=0', '-force_key_frames', '0,120', '-bf', '0', '-f', 'mpegts', file],
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
const logged: string[] = [];
const nvr = new VionNvr({ log: (m: string) => void logged.push(m), warn: (m: string) => void logged.push(m), error: console.error, debug: noop, attention: noop, trace: noop } as never, api as never, storage as never);
const internals = nvr as unknown as { cameras: Map<string, unknown>; store: Store; ready: Promise<void>; stop(): Promise<void>; endSegmentsAtLastFrame(): Promise<void> };
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
  // a stretch that starts between two frames: the steps from its first frame, each patch the look of its time (they
  // were counted from the keyframe's clock: up to a step late, and the last one lost)
  const between = await patchesOf(FFMPEG, [file_], k0 + 13.27 * S, k0 + 15.27 * S, lower, 500);
  assert.deepEqual(
    between.map((p) => Math.round((p.atMs * 1000 - k0) / 1000) / 1000),
    [13.27, 13.77, 14.27, 14.77],
  );
  const near = await Promise.all([13.3, 13.5, 13.8, 14, 14.3, 14.5, 14.8, 15].map(async (t) => (await patchOfPicture(FFMPEG, exactJpeg(k0 + t * S), lower))!));
  for (const [i, patch] of between.entries()) {
    const diffs = near.map((look) => patchDiff(patch.pixels, look));
    assert.equal(diffs.indexOf(Math.min(...diffs)), 2 * i, `patch at ${13.27 + i / 2}: the look of its first frame (${diffs.map((d) => d.toFixed(3)).join(', ')})`);
  }
  // a stretch that ends right after a keyframe (the next file of a run that begins as the asked time ends): its
  // keyframe, not the whole file and no failure
  for (const endsAfter of [0.0005, 0.001, 0.002]) {
    const one = await patchesOf(FFMPEG, [file_], k0 - S, k0 + endsAfter * S, lower, 500);
    assert.deepEqual(one.map((p) => Math.round((p.atMs * 1000 - k0) / 1000)), [0], `a stretch ending ${endsAfter * 1000} ms after the keyframe`);
  }
}
// far from both keyframes: the nearest one, with its own time, not frames short of the time; ffmpeg's picture is the
// keyframe after when it is as near as the frames it decodes to, else none (not a picture of another minute)
for (const [what, at, nearest, picture] of [
  ['nearer the one before', k0 + 50 * S, k0, undefined],
  ['nearer the one after', k0 + 100 * S, k1, k1],
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

  const jpeg = await frameAt(FFMPEG, file_, at);
  if (picture === undefined) assert.equal(jpeg, undefined, `${what}: no picture from ffmpeg`);
  else assert.ok(same(jpeg, exactJpeg(picture)), `${what}: ffmpeg's picture is the keyframe after`);
}
// a stretch far from the keyframe before: its patches from the next keyframe on, with their times
{
  const patches = await patchesOf(FFMPEG, [file_], k0 + 100 * S, k0 + 122 * S, { x: 0, y: 0, width: 1, height: 1 }, 500);
  assert.deepEqual(
    patches.map((p) => Math.round((p.atMs * 1000 - k1) / 1000) / 1000),
    [0, 0.5, 1, 1.5],
  );
}

// files an older version closed by the clock: the row of this one as it would have been after a stream that stopped
// with its connection open (42 minutes), and one of a file that is gone. Once, at the start: the first ends at its
// last frame again, the second is left as it is
{
  const ended = segment.end_us;
  assert.ok(ended - k0 > 149 * S && ended - k0 < 150 * S, `the file ends with its last frame: ${(ended - k0) / S}`);
  const sql = internals.store.sql;
  sql.prepare('UPDATE segments SET end_us = ? WHERE id = ?').run(segment.start_us + 42 * 60 * S, segment.id);
  // in its hole, before it is ended at its last frame: no picture (not the last keyframe, 40 s before)
  assert.equal(await frameAt(FFMPEG, internals.store.located(internals.store.segment(segment.id)!), k1 + 40 * S), undefined, 'no picture in the hole');
  const { id: _id, ...row } = segment;
  // two hundred files that end with their frames (a portion), then the same file once more as an older version left it
  for (let n = 0; n < 200; n++) internals.store.addSegment(row);
  // a file that cannot be read (a directory here) before it: left as it is, and the pass goes on
  const unreadable = join(dir, 'unreadable');
  mkdirSync(unreadable);
  const broken = internals.store.addSegment({ ...row, path: unreadable, end_us: segment.start_us + 42 * 60 * S });
  const later = internals.store.addSegment({ ...row, end_us: segment.start_us + 42 * 60 * S });
  // and one with a hole: three seconds more of video 2.5 hours on by the camera's clock, past its last keyframe
  const tail = join(dir, 'tail.ts');
  const madeTail = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10', '-t', '3', '-c:v', 'libx264', '-bf', '0', '-output_ts_offset', '9000', '-f', 'mpegts', tail]);
  assert.equal(madeTail.status, 0, madeTail.stderr?.toString());
  const holed = join(dir, 'holed.ts');
  writeFileSync(holed, Buffer.concat([readFileSync(file_.path), readFileSync(tail)]));
  const withHole = internals.store.addSegment({ ...row, path: holed, end_us: segment.start_us + 9200 * S });
  const gone = internals.store.addSegment({ ...row, path: join(dir, 'gone.ts'), start_us: segment.start_us + 3600 * S, end_us: segment.start_us + 3600 * S + 42 * 60 * S, keyframes: JSON.stringify([[0, segment.start_us + 3600 * S]]) });
  // read in portions: the late rows of each
  const first = internals.store.endingLate(0, 60 * S, 201);
  const second = internals.store.endingLate(first.next!, 60 * S, 201);
  assert.deepEqual([first.rows.map((r) => r.id), second.rows.map((r) => r.id)], [[segment.id], [broken, later, withHole, gone]]);
  assert.equal(second.next, undefined);
  // a file still being written is left to its recorder, which ends it at its last frame itself
  const recorders = internals.cameras.get('cam') as { recorders: Map<string, unknown> };
  recorders.recorders.set('high', { liveSegmentId: segment.id });
  await internals.endSegmentsAtLastFrame();
  assert.equal(internals.store.segment(segment.id)!.end_us, segment.start_us + 42 * 60 * S, 'the open file is not read');
  recorders.recorders.clear();
  internals.store.setMeta('segment_ends_before_holes', '');
  await internals.endSegmentsAtLastFrame();
  assert.equal(internals.store.segment(segment.id)!.end_us, ended, 'the file ends at its last frame');
  assert.equal(internals.store.segment(later)!.end_us, ended, 'and so does the row after the first portion');
  assert.equal(internals.store.segment(withHole)!.end_us, ended, 'the file with a hole ends before it');
  assert.equal(internals.store.segment(gone)!.end_us, segment.start_us + 3600 * S + 42 * 60 * S, 'a file that is gone is left as it is');
  assert.equal(internals.store.segment(broken)!.end_us, segment.start_us + 42 * 60 * S, 'a file that cannot be read too');
  assert.ok(logged.some((m) => /^1 recorded file\(s\) could not be read for their last frame and keep their end: /.test(m)), logged.join(' | '));
  assert.equal(internals.store.meta('segment_ends_before_holes'), 'done');
  // a row its recorder wrote since it was read keeps what the recorder wrote
  assert.equal(internals.store.endSegmentAt(later, segment.start_us, segment.start_us + 42 * 60 * S), false);
  assert.equal(internals.store.segment(later)!.end_us, ended);
  // the row after the first portion in the pass that left the open file, the file itself in the next one
  assert.deepEqual(
    logged.filter((m) => m.includes('closed by the clock')),
    ['2 recorded files closed by the clock end at their last frame now', '1 recorded files closed by the clock end at their last frame now'],
  );
  // done once: not read again at the next start
  sql.prepare('UPDATE segments SET end_us = ? WHERE id = ?').run(segment.start_us + 42 * 60 * S, segment.id);
  await internals.endSegmentsAtLastFrame();
  assert.equal(internals.store.segment(segment.id)!.end_us, segment.start_us + 42 * 60 * S);
}

// a file still being written is not deleted with a range, though its end is minutes back (its video stopped)
{
  const { id: _id, ...row } = segment;
  const old = internals.store.addSegment({ ...row, path: join(dir, 'old.ts'), start_us: segment.start_us - 7200 * S, end_us: segment.start_us - 7100 * S });
  const recorders = internals.cameras.get('cam') as { recorders: Map<string, unknown> };
  recorders.recorders.set('high', { liveSegmentId: old });
  await nvr.nvrDeleteRange('cam', segment.start_us - 7300 * S, segment.start_us - 7000 * S);
  assert.ok(internals.store.segment(old), 'the file being written stays');
  recorders.recorders.clear();
  await nvr.nvrDeleteRange('cam', segment.start_us - 7300 * S, segment.start_us - 7000 * S);
  assert.equal(internals.store.segment(old), undefined, 'and goes once it is closed');
}

await internals.stop();
console.log('sparse-keyframes.spec: a time is decoded from the keyframe before it; far from it, the nearest keyframe is its picture; files closed by the clock end at their last frame — ok');
process.exit(0);
