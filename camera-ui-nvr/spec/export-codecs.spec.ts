// Exports of recordings in more than one codec, and the batch export made H.264 (src/export.ts, nvrExport,
// nvrExportBatch, nvrExportEstimate). A camera set from H.264 to H.265 inside a range was cut where its codec changed:
// the files of one stretch are joined byte by byte and ffmpeg kept the first codec's stream only. A clip of more than
// one codec is made H.264 now, the stretches read one by one. The export dialog's files of an H.265 camera left as
// H.265 MP4s, which the player of Windows does not open without a paid extension: the dialog can ask for H.264, and
// the estimate tells it when the selection has H.265.
// Needs ffmpeg with libx264 and libx265 on PATH (or CAMERAUI_FFMPEG_PATH). Run: npx tsx spec/export-codecs.spec.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clipPlan, exportClip } from '../src/export.js';
import VionNvr from '../src/index.js';
import { LIBX264 } from '../src/media/transcode.js';

import type { H264Encoder } from '../src/media/transcode.js';
import type { SegmentRow } from '../src/store.js';

const dir = mkdtempSync(join(tmpdir(), 'nvr-export-codecs-'));
const FFMPEG = process.env.CAMERAUI_FFMPEG_PATH ?? 'ffmpeg';
const noop = () => undefined;
const S = 1_000_000;

type Codec = 'h264' | 'h265';
const row = (path: string, startSec: number, endSec: number, codec: Codec = 'h264', size: [number, number] = [320, 240], audio = false): SegmentRow => ({
  id: 0,
  camera_id: 'cam1',
  role: 'high',
  start_us: Math.round(startSec * S),
  end_us: Math.round(endSec * S),
  path,
  bytes: 1000,
  codec,
  codec_string: codec === 'h264' ? 'avc1.640015' : 'hvc1.1.6.L60.B0',
  width: size[0],
  height: size[1],
  video_pid: 256,
  audio_pid: audio ? 257 : -1,
  keyframes: '[]',
});

function recording(name: string, seconds: number, codec: Codec, opts: { size?: [number, number]; audio?: boolean } = {}): string {
  const path = join(dir, name);
  const [w, h] = opts.size ?? [320, 240];
  const made = spawnSync(
    FFMPEG,
    [
      ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=${w}x${h}:rate=10`],
      opts.audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000'] : [],
      ['-t', String(seconds)],
      codec === 'h264' ? ['-c:v', 'libx264', '-g', '10', '-bf', '0'] : ['-c:v', 'libx265', '-x265-params', 'log-level=error:keyint=10:bframes=0'],
      opts.audio ? ['-c:a', 'aac'] : [],
      ['-f', 'mpegts', path],
    ].flat(),
    { encoding: 'utf8' },
  );
  assert.equal(made.status, 0, `ffmpeg could not make a recording: ${made.stderr}`);
  return path;
}

/** What an MP4 holds, from its sample descriptions. */
function tracks(path: string): { video: string; audio: boolean } {
  const file = readFileSync(path);
  const video = ['avc1', 'hvc1', 'hev1'].find((tag) => file.includes(tag)) ?? 'none';
  return { video, audio: file.includes('mp4a') };
}

function playsFor(path: string): number {
  const file = readFileSync(path);
  const at = file.indexOf('mvhd');
  assert.ok(at > 0, 'an MP4 with a movie header');
  const v1 = file[at + 4] === 1;
  const timescale = file.readUInt32BE(at + (v1 ? 24 : 16));
  const duration = v1 ? Number(file.readBigUInt64BE(at + 28)) : file.readUInt32BE(at + 20);
  return duration / timescale;
}

/**
 * The pictures of the MP4's video track that decode, and no error on the way. The old export of a codec change was
 * 40 s long all the same: its H.265 half lay in the H.264 track, 199 of 400 pictures decoded, 555 errors.
 */
function framesOf(path: string): number {
  const decoded = spawnSync(FFMPEG, ['-hide_banner', '-v', 'error', '-i', path, '-map', '0:v:0', '-f', 'null', '-progress', 'pipe:1', '-'], { encoding: 'utf8' });
  assert.equal(decoded.status, 0, `the clip does not decode: ${decoded.stderr}`);
  assert.equal(decoded.stderr.trim(), '', `the clip decodes with errors: ${decoded.stderr.slice(0, 300)}`);
  const counts = [...decoded.stdout.matchAll(/^frame=(\d+)$/gm)];
  return counts.length ? Number(counts.at(-1)![1]) : 0;
}

const near = (actual: number, expected: number, what: string, within = 0.3) => assert.ok(Math.abs(actual - expected) <= within, `${what}: ${actual}, expected ${expected}`);

const avc = recording('a-h264.ts', 30, 'h264');
const hevc = recording('b-h265.ts', 30, 'h265');
const hevcLarge = recording('c-h265-640.ts', 30, 'h265', { size: [640, 480] });
const avcSound = recording('d-h264-sound.ts', 30, 'h264', { audio: true });
const hevcSound = recording('e-h265-sound.ts', 30, 'h265', { audio: true });

// ------------------------------------------------------------------ where the range lies: a codec change is a new stretch

{
  const { runs, offsetSec, durationSec } = clipPlan([row('a', 0, 30, 'h264'), row('b', 30, 60, 'h265'), row('c', 60, 90, 'h265')], 10 * S, 80 * S);
  assert.deepEqual(
    runs.map((run) => run.map((s) => s.path)),
    [['a'], ['b', 'c']],
    'back to back, but the codec changes: two stretches',
  );
  assert.equal(offsetSec, 10);
  assert.equal(durationSec, 70, 'the recorded time is the same');
}

// ------------------------------------------------------------------ a clip over a codec change

const cut = async (name: string, segments: SegmentRow[], startSec: number, endSec: number, extra: { h264?: H264Encoder; timelapseIntervalSec?: number } = {}) => {
  const clip = await exportClip({ ffmpegPath: FFMPEG, segments, startUs: startSec * S, endUs: endSec * S, outDir: join(dir, 'clips'), filename: name, ...extra });
  return { said: clip.durationMs / 1000, real: playsFor(clip.path), frames: framesOf(clip.path), ...tracks(clip.path) };
};

{
  const clip = await cut('change.mp4', [row(avc, 0, 30, 'h264'), row(hevc, 30, 60, 'h265')], 10, 50);
  near(clip.real, 40, 'the clip goes on past the codec change');
  near(clip.said, clip.real, 'and says how long it is');
  near(clip.frames / 10, 40, 'every picture of both files, ten a second', 0.5);
  assert.equal(clip.video, 'avc1', 'one codec for the whole clip: H.264');
}
{
  // the camera was set to another size with its codec: one size for the clip, the first file's
  const clip = await cut('change-size.mp4', [row(avc, 0, 30, 'h264'), row(hevcLarge, 30, 60, 'h265', [640, 480])], 20, 60);
  near(clip.real, 40, 'a codec and a size change');
  near(clip.frames / 10, 40, 'a codec and a size change, frames', 0.5);
}
{
  // sound on both sides: it goes on too
  const clip = await cut('change-sound.mp4', [row(avcSound, 0, 30, 'h264', [320, 240], true), row(hevcSound, 30, 60, 'h265', [320, 240], true)], 0, 60);
  near(clip.real, 60, 'with sound');
  assert.equal(clip.audio, true, 'the sound is kept');
  // sound on one side only: the clip has none rather than a silent hole the player stops at
  const half = await cut('change-half-sound.mp4', [row(avcSound, 0, 30, 'h264', [320, 240], true), row(hevc, 30, 60, 'h265')], 0, 60);
  near(half.real, 60, 'sound on one side');
  assert.equal(half.video, 'avc1');
}
{
  // a timelapse over the change: a picture a second, sixty pictures
  const clip = await cut('change-lapse.mp4', [row(avc, 0, 30, 'h264'), row(hevc, 30, 60, 'h265')], 0, 60, { timelapseIntervalSec: 1 });
  near(clip.frames, 60, 'a picture a second over both codecs', 2);
}
{
  // one codec: copied as always, the H.265 stays H.265
  const clip = await cut('h265-only.mp4', [row(hevc, 0, 30, 'h265')], 5, 25);
  assert.equal(clip.video === 'hvc1' || clip.video === 'hev1', true, `copied: ${clip.video}`);
  near(clip.real, 20, 'copied, the range');
}

// ------------------------------------------------------------------ the exports of the plugin

{
  const downloads: { filePath: string; filename: string }[] = [];
  const api = {
    storagePath: join(dir, 'plugin'),
    on: noop,
    once: noop,
    emit: noop,
    notificationManager: { publish: async () => undefined },
    downloadManager: {
      createDownload: async (opts: { filePath: string; filename: string }) => {
        downloads.push(opts);
        return { url: `/download/${opts.filename}` };
      },
    },
    coreManager: { assistantAccess: async () => ({ allowed: false }), getFFmpegPath: () => new Promise<string>(noop), getPluginsByInterface: async () => [] },
  };
  mkdirSync(api.storagePath);
  const storage = { values: {} as Record<string, unknown>, getValue: async () => undefined, setValue: async () => undefined };
  const nvr = new VionNvr({ log: noop, warn: noop, error: console.error, debug: noop, attention: noop, trace: noop } as never, api as never, storage as never);
  const internals = nvr as unknown as {
    cameras: Map<string, unknown>;
    store: { addSegment(row: Omit<SegmentRow, 'id'>): number };
    ffmpegPath: string;
    h264Encoder?: Promise<H264Encoder>;
  };
  internals.ffmpegPath = FFMPEG;
  internals.h264Encoder = Promise.resolve(LIBX264);
  for (const id of ['xiaomi', 'door', 'changed']) internals.cameras.set(id, { device: { id, name: id }, recorders: new Map(), subscriptions: [] });
  const add = (camera: string, segment: SegmentRow) => internals.store.addSegment({ ...segment, camera_id: camera });
  add('xiaomi', row(hevc, 0, 30, 'h265'));
  add('door', row(avc, 0, 30, 'h264'));
  add('changed', row(avc, 0, 30, 'h264'));
  add('changed', row(hevc, 30, 60, 'h265'));
  const slices = [{ day: 'one', startUs: 0, endUs: 30 * S }];
  const last = () => tracks(downloads.at(-1)!.filePath);

  // the estimate tells the dialog whether to offer H.264
  assert.equal((await nvr.nvrExportEstimate({ cameras: ['xiaomi'], slices })).h265, true, 'an H.265 camera');
  assert.equal((await nvr.nvrExportEstimate({ cameras: ['door'], slices })).h265, undefined, 'H.264 only: nothing to offer');
  assert.equal((await nvr.nvrExportEstimate({ cameras: ['door', 'xiaomi'], slices })).h265, true, 'one of them is enough');

  // the batch export: copied unless asked
  await nvr.nvrExportBatch({ cameras: ['xiaomi'], slices });
  assert.notEqual(last().video, 'avc1', 'not asked: the recording as it is');
  await nvr.nvrExportBatch({ cameras: ['xiaomi'], slices, h264: true });
  assert.equal(last().video, 'avc1', 'asked: made H.264');
  await nvr.nvrExportBatch({ cameras: ['door'], slices, h264: true });
  assert.equal(last().video, 'avc1', 'an H.264 camera stays H.264');

  // the trim export of a camera whose codec changed inside the range: all of it, H.264
  const changed = await nvr.nvrExport('changed', 10 * S, 50 * S);
  near(changed.durationMs / 1000, 40, 'trim over the change, reported');
  near(playsFor(downloads.at(-1)!.filePath), 40, 'trim over the change');
  assert.equal(last().video, 'avc1');
  // and the batch export of it
  await nvr.nvrExportBatch({ cameras: ['changed'], slices: [{ day: 'one', startUs: 0, endUs: 60 * S }] });
  near(playsFor(downloads.at(-1)!.filePath), 60, 'batch over the change');
}

console.log('export-codecs.spec: a codec change inside a clip (stretches, size, sound, timelapse), batch export made H.264 when asked, the estimate tells of H.265 — ok');
process.exit(0);
