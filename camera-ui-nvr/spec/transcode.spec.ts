// The recording of an H.265 camera as H.264 for a browser that cannot decode H.265 (src/media/transcode.ts): every
// frame comes out once, at the time it was recorded, as H.264 no wider than 1280; from any keyframe on; with the sound;
// a client gone stops ffmpeg; a failing ffmpeg says why. And the encoder is the first hardware one that encodes here.
// Needs ffmpeg with libx265 and libx264 on PATH (or CAMERAUI_FFMPEG_PATH). Run: npx tsx spec/transcode.spec.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { probeCodec } from '../src/media/codec.js';
import { findH264Encoder, h264Slots, LIBX264, readFramesAsH264, setH264Slots } from '../src/media/transcode.js';
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

// a wait for ffmpeg to take more of the file left a listener behind every time (11 on one socket in the review)
const warnings: string[] = [];
process.on('warning', (warning) => {
  if (warning.name === 'MaxListenersExceededWarning') warnings.push(warning.message);
});

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

  // ---- the recorder moved its clock in the middle of the file (a drift, a jump of the camera's PTS: recorder.ts):
  // the index has the new times from that keyframe on, and the frames made H.264 take them, as readFrames does. They
  // kept the time of the first keyframe for the whole file, 5 s off after the move
  const moved = keyframes.map(([offset, tsUs], i) => [offset, i >= 2 ? tsUs + 5_000_000 : tsUs] as [number, number]);
  const movedSegment = { ...segment, keyframes: JSON.stringify(moved) } as SegmentRow;
  const movedIndex = moved.map(([offset, tsUs]) => ({ offset, tsUs }));
  const asRead = video(await collect(readFrames(movedSegment, start)));
  const asMade = video(await collect(readFramesAsH264(path, start, { ffmpegPath: FFMPEG, encoder: LIBX264, keyframes: movedIndex })));
  assert.deepEqual(
    asMade.map((frame) => frame.tsUs),
    asRead.map((frame) => frame.tsUs),
    'the times readFrames gives, the move included',
  );
  assert.ok(asRead.at(-1)!.tsUs - recorded.at(-1)!.tsUs === 5_000_000, 'the move is in the times');

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

  // ---- a client that waits (a paused playback) holds ffmpeg back: it made the whole file at once into memory, a
  // process running flat out for every viewer (1199 frames / 32 MB of a 2-minute file during a 20 s pause in the review)
  const noisy = join(dir, 'noisy.ts');
  const noise = spawnSync(
    FFMPEG,
    [
      ...['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=10', '-t', '30'],
      ...['-vf', 'noise=alls=60:allf=t', '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'keyint=50:bframes=0:log-level=error'],
      ...['-f', 'mpegts', noisy],
    ],
    { encoding: 'utf8' },
  );
  assert.equal(noise.status, 0, noise.stderr);
  assert.ok(statSync(noisy).size > 4_000_000, `a file larger than the pipes hold: ${statSync(noisy).size}`);
  let fedToTheEnd = false;
  const held = readFramesAsH264(noisy, { offset: 0, tsUs: 0 }, {
    ffmpegPath: FFMPEG,
    encoder: LIBX264,
    follow: () => {
      fedToTheEnd = true;
      return false;
    },
  });
  const reading = held[Symbol.asyncIterator]();
  assert.equal((await reading.next()).done, false);
  await sleep(4000);
  assert.equal(fedToTheEnd, false, 'while the client waits the file is not read to its end');
  let heldFrames = 1;
  while (!(await reading.next()).done) heldFrames++;
  assert.equal(heldFrames, 300, 'and every frame comes when it reads on');
  assert.ok(fedToTheEnd);
  await sleep(10);
  assert.deepEqual(warnings, [], 'no listener left behind by the waits for ffmpeg');

  // ---- no more made at once than the machine has room for: the rest wait their turn. Each viewer without H.265 had
  // its own ffmpeg, an episode of N cameras N of them, with nothing to bound them on a weak machine
  assert.ok(h264Slots() >= 2, `the machine's room: ${h264Slots()}`);
  const machineSlots = h264Slots();
  setH264Slots(1);
  const running = readFramesAsH264(path, start, { ffmpegPath: FFMPEG, encoder: LIBX264 })[Symbol.asyncIterator]();
  assert.equal((await running.next()).done, false);
  const waiting = readFramesAsH264(path, start, { ffmpegPath: FFMPEG, encoder: LIBX264 })[Symbol.asyncIterator]();
  let waited = true;
  const waitingFirst = waiting.next().then((result) => {
    waited = false;
    return result;
  });
  await sleep(1500);
  assert.equal(waited, true, 'a second one waits while the first runs');
  await running.return(undefined);
  assert.equal((await waitingFirst).done, false, 'and goes once the first ends');
  await waiting.return(undefined);
  // one that waits and is given up ends without a frame, and keeps no place
  const blocker = readFramesAsH264(path, start, { ffmpegPath: FFMPEG, encoder: LIBX264 })[Symbol.asyncIterator]();
  await blocker.next();
  const given = new AbortController();
  const givenUp = collect(readFramesAsH264(path, start, { ffmpegPath: FFMPEG, encoder: LIBX264, signal: given.signal }));
  await sleep(300);
  given.abort();
  assert.deepEqual(await givenUp, []);
  await blocker.return(undefined);
  assert.ok((await collect(readFramesAsH264(path, start, { ffmpegPath: FFMPEG, encoder: LIBX264 }))).length > 0, 'the place is free again');
  // and the count is right after it: one running still makes the next wait
  const again = readFramesAsH264(path, start, { ffmpegPath: FFMPEG, encoder: LIBX264 })[Symbol.asyncIterator]();
  await again.next();
  let stillWaits = true;
  const next = readFramesAsH264(path, start, { ffmpegPath: FFMPEG, encoder: LIBX264 })[Symbol.asyncIterator]();
  const nextFirst = next.next().then(() => {
    stillWaits = false;
  });
  await sleep(1000);
  assert.equal(stillWaits, true, 'one given up while waiting leaves the count as it was');
  await again.return(undefined);
  await nextFirst;
  await next.return(undefined);
  setH264Slots(machineSlots);

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
  // a hardware encoder that fails now though it worked at the start (NVENC's sessions are counted, and go2rtc's copies
  // take some): libx264 makes it instead. libx264 failing itself is said, as above
  const failingCard = { name: 'nvenc', input: [], upload: '', codec: ['-c:v', 'no_such_encoder'] };
  const rescued = video(await collect(readFramesAsH264(path, start, { ffmpegPath: FFMPEG, encoder: failingCard })));
  assert.deepEqual(
    rescued.map((frame) => frame.tsUs),
    recorded.map((frame) => frame.tsUs),
    'every frame, made by libx264',
  );
  // a file the retention removed meanwhile ends without frames, as readFrames does: the playback goes on with the next
  assert.deepEqual(await collect(readFramesAsH264(join(dir, 'removed.ts'), start, { ffmpegPath: FFMPEG, encoder: LIBX264 })), []);

  // ---- the encoder: the first hardware one that encodes, else libx264
  const asked: string[] = [];
  const machine = (works: string[], platform: NodeJS.Platform = 'linux') => ({
    platform,
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
  // Intel graphics on Windows: Quick Sync, as the server's copies (go2rtc/hardware-transcode.ts)
  asked.length = 0;
  const quickSync = await findH264Encoder(FFMPEG, machine(['h264_qsv'], 'win32'));
  assert.equal(quickSync.name, 'qsv');
  assert.deepEqual(asked, ['h264_nvenc', 'h264_qsv'], 'NVIDIA first, then Quick Sync');
  assert.ok(quickSync.input.includes('qsv=qs') && quickSync.upload.includes('hwupload'), 'the device and the upload to it');

  console.log('transcode.spec: every frame at its time as H.264 ≤1280, from a middle keyframe, sound, abort, failures, encoder — ok');
}

// a wait nothing ends empties Node's loop and the process ended with 0 without its checks: that is a failure
let finished = false;
process.on('exit', (code) => {
  if (!finished && code === 0) {
    console.error('the spec ended before its last check: something waits for what never comes');
    process.exitCode = 1;
  }
});
main()
  .then(() => {
    finished = true;
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
