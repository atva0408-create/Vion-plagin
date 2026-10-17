// The recording of an H.265 camera as H.264 for a browser that cannot decode H.265 (src/media/transcode.ts): every
// frame comes out once, at the time it was recorded, as H.264 no wider than 1280; from any keyframe on; with the sound;
// a client gone stops ffmpeg; a failing ffmpeg says why. And the encoder is the first hardware one that encodes here.
// Needs ffmpeg with libx265 and libx264 on PATH (or CAMERAUI_FFMPEG_PATH). Run: npx tsx spec/transcode.spec.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { probeCodec } from '../src/media/codec.js';
import { findH264Encoder, LIBX264, readFramesAsH264 } from '../src/media/transcode.js';
import { ptsDelta, TsDemuxer } from '../src/media/ts-demux.js';
import { readFrames } from '../src/reader.js';

import type { Frame } from '../src/reader.js';
import type { SegmentRow } from '../src/store.js';

const FFMPEG = process.env.CAMERAUI_FFMPEG_PATH ?? 'ffmpeg';
const dir = mkdtempSync(join(tmpdir(), 'nvr-transcode-'));
const path = join(dir, 'hevc.ts');

// 4 s of an H.265 camera, 1920x1080 at 10 fps, a keyframe a second, with AAC sound
const made = spawnSync(
  FFMPEG,
  [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=1920x1080:rate=10',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=16000',
    '-t',
    '4',
    '-c:v',
    'libx265',
    '-x265-params',
    'keyint=10:min-keyint=10:bframes=0:log-level=error',
    '-c:a',
    'aac',
    '-f',
    'mpegts',
    path,
  ],
  { encoding: 'utf8' },
);
assert.equal(made.status, 0, `ffmpeg could not make an H.265 recording: ${made.stderr}`);

// the segment as the recorder indexes it: the keyframes' offsets and times
const keyframes: [number, number][] = [];
let first: number | undefined;
const scan = new TsDemuxer((au) => {
  first ??= au.pts;
  if (au.keyframe) keyframes.push([au.offset, Math.round((ptsDelta(first, au.pts) / 90) * 1000)]);
});
scan.push(readFileSync(path), 0);
scan.flush();
const segment = { path, codec: 'h265', video_pid: scan.videoPid, audio_pid: scan.audioPid, keyframes: JSON.stringify(keyframes) } as unknown as SegmentRow;
assert.equal(scan.codec, 'h265');
assert.ok(keyframes.length >= 4, `keyframes ${keyframes.length}`);

// the same as the recorder lays it out: the stream tables (PAT, PMT) once at the start of the file, not before every
// keyframe as ffmpeg writes them (recorder.ts writes them when it opens a file)
const recorderPath = join(dir, 'recorder-layout.ts');
const packets: Buffer[] = [];
let tables = 0;
const whole = readFileSync(path);
for (let at = 0; at + 188 <= whole.length; at += 188) {
  const packet = whole.subarray(at, at + 188);
  const pid = ((packet[1]! & 0x1f) << 8) | packet[2]!;
  // PID 0 is the PAT; the PMT is the other table ffmpeg writes, 0x1000
  if (pid === 0 || pid === 0x1000) {
    if (tables++ >= 2) continue;
  }
  packets.push(packet);
}
writeFileSync(recorderPath, Buffer.concat(packets));
const recorderKeyframes: { offset: number; tsUs: number }[] = [];
const recorderScan = new TsDemuxer((au) => {
  if (au.keyframe) recorderKeyframes.push({ offset: au.offset, tsUs: keyframes[recorderKeyframes.length]![1] });
});
recorderScan.push(readFileSync(recorderPath), 0);
recorderScan.flush();
assert.equal(recorderKeyframes.length, keyframes.length);
assert.ok(tables > 4, 'ffmpeg wrote the tables again in the file, the test file has them once');

const collect = async (frames: AsyncIterable<Frame>) => {
  const out: Frame[] = [];
  for await (const frame of frames) out.push(frame);
  return out;
};
const start = { offset: keyframes[0]![0], tsUs: keyframes[0]![1] };
const video = (list: Frame[]) => list.filter((frame) => !frame.audio);

async function main(): Promise<void> {
  const recorded = video(await collect(readFrames(segment, start)));
  const made264 = await collect(readFramesAsH264(path, start, { ffmpegPath: FFMPEG, encoder: LIBX264, audio: true }));
  const out = video(made264);

  // ---- every frame once, at its recorded time, as H.264 no wider than 1280
  assert.equal(out.length, recorded.length, 'one frame out for every frame in');
  assert.deepEqual(
    out.map((frame) => frame.tsUs),
    recorded.map((frame) => frame.tsUs),
    'at the times they were recorded',
  );
  assert.ok(out[0]!.keyframe, 'it starts with a keyframe');
  const info = probeCodec(out[0]!.data, 'h264');
  assert.ok(info, 'the first frame carries an H.264 SPS');
  assert.match(info!.codecString, /^avc1\./);
  assert.deepEqual([info!.width, info!.height], [1280, 720], 'made no wider than 1280, the shape kept');

  // ---- with its sound, none of it before the first picture
  const sound = made264.filter((frame) => frame.audio);
  assert.ok(sound.length > 10, `sound frames: ${sound.length}`);
  assert.ok(sound.every((frame) => frame.tsUs >= start.tsUs));

  // ---- from a keyframe in the middle: the first frame is that keyframe, at its time
  const middle = { offset: keyframes[2]![0], tsUs: keyframes[2]![1] };
  const fromMiddle = video(await collect(readFramesAsH264(path, middle, { ffmpegPath: FFMPEG, encoder: LIBX264 })));
  assert.equal(fromMiddle[0]!.tsUs, middle.tsUs);
  assert.deepEqual(
    fromMiddle.map((frame) => frame.tsUs),
    recorded.filter((frame) => frame.tsUs >= middle.tsUs).map((frame) => frame.tsUs),
  );

  // ---- the file being written, from a keyframe in its middle, as the recorder lays it out: the first frame comes at
  // once. Without the tables ffmpeg looked through 5 MB for the streams first: about a minute of a camera's recording
  // at the live tip (39 s at 1.1 Mbit/s in the review)
  const followUntil = Date.now() + 4000;
  const askedAt = Date.now();
  let firstAfter: number | undefined;
  const live: Frame[] = [];
  for await (const frame of readFramesAsH264(recorderPath, recorderKeyframes[2]!, { ffmpegPath: FFMPEG, encoder: LIBX264, follow: () => Date.now() < followUntil })) {
    firstAfter ??= Date.now() - askedAt;
    live.push(frame);
  }
  assert.ok(firstAfter !== undefined && firstAfter < 2500, `the first frame of the file being written after ${firstAfter} ms`);
  assert.equal(live[0]!.tsUs, recorderKeyframes[2]!.tsUs, 'that keyframe, at its time');
  assert.deepEqual(
    video(live).map((frame) => frame.tsUs),
    recorded.filter((frame) => frame.tsUs >= recorderKeyframes[2]!.tsUs).map((frame) => frame.tsUs),
    'and every frame after it',
  );

  // ---- a client gone after a few frames: it ends at once
  const abort = new AbortController();
  const startedAt = Date.now();
  let seen = 0;
  for await (const frame of readFramesAsH264(path, start, { ffmpegPath: FFMPEG, encoder: LIBX264, signal: abort.signal })) {
    if (!frame.audio && ++seen === 5) abort.abort();
  }
  assert.ok(seen >= 5 && seen < recorded.length, `stopped after ${seen}`);
  assert.ok(Date.now() - startedAt < 10_000, 'without waiting for the rest');

  // ---- a failing ffmpeg says why
  await assert.rejects(
    collect(readFramesAsH264(path, start, { ffmpegPath: FFMPEG, encoder: { ...LIBX264, codec: ['-c:v', 'no_such_encoder'] } })),
    /ffmpeg made no H\.264 of .*hevc\.ts/,
  );
  await assert.rejects(collect(readFramesAsH264(path, start, { ffmpegPath: join(dir, 'no-ffmpeg'), encoder: LIBX264 })));

  // ---- the encoder: the first hardware one that encodes, else libx264
  const asked: string[] = [];
  const machine = (works: string[]) => ({
    platform: 'linux' as NodeJS.Platform,
    nodes: () => ['/dev/dri/renderD128'],
    run: async (args: string[]) => {
      const codec = args[args.indexOf('-c:v') + 1]!;
      asked.push(codec);
      return works.includes(codec);
    },
  });
  assert.equal((await findH264Encoder(FFMPEG, machine(['h264_vaapi']))).name, 'vaapi /dev/dri/renderD128');
  assert.deepEqual(asked, ['h264_nvenc', 'h264_vaapi']);
  assert.equal((await findH264Encoder(FFMPEG, machine(['h264_nvenc']))).name, 'nvenc');
  assert.equal(await findH264Encoder(FFMPEG, machine([])), LIBX264);

  console.log('transcode.spec: every frame at its time as H.264 ≤1280, from a middle keyframe, sound, abort, failures, encoder — ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
