// The recording of an H.265 camera as H.264 for a browser that cannot decode H.265 (src/media/transcode.ts): every
// frame comes out once, at the time it was recorded, as H.264 no wider than 1280; from any keyframe on; with the sound;
// a client gone stops ffmpeg; a failing ffmpeg says why. And the encoder is the first hardware one that encodes here.
// Needs ffmpeg with libx265 and libx264 on PATH (or CAMERAUI_FFMPEG_PATH). Run: npx tsx spec/transcode.spec.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { probeCodec } from '../src/media/codec.js';
import { findH264Encoder, H264Place, h264Slots, LIBX264, readFramesAsH264, setH264Idle, setH264Slots } from '../src/media/transcode.js';
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

  // ---- from a time in the middle of a GOP: the frames before it are decoded, not made, and none is given; the first is
  // the frame of the time, made a keyframe. A seek 80 s into a Xiaomi GOP had 1600 frames made first
  const seekTo = recorded[25]!.tsUs;
  const fromTime = video(await collect(readFramesAsH264(path, start, { ffmpegPath: FFMPEG, encoder: LIBX264, startUs: seekTo })));
  assert.deepEqual([fromTime[0]!.tsUs, fromTime[0]!.keyframe], [seekTo, true]);
  assert.deepEqual(
    fromTime.map((frame) => frame.tsUs),
    recorded.filter((frame) => frame.tsUs >= seekTo).map((frame) => frame.tsUs),
  );
  // more frames before it than the caller would decode: none, the caller takes a nearer keyframe
  assert.deepEqual(await collect(readFramesAsH264(path, start, { ffmpegPath: FFMPEG, encoder: LIBX264, startUs: seekTo, maxBefore: 10 })), []);
  assert.equal(video(await collect(readFramesAsH264(path, start, { ffmpegPath: FFMPEG, encoder: LIBX264, startUs: seekTo, maxBefore: 30 })))[0]!.tsUs, seekTo);

  // ---- a seek into the GOP over the wrap of the 33-bit PTS (every 26.5 h of a camera's clock): the frame of the time
  // and on, at their times. ffmpeg makes the PTS before the wrap negative: the frame looked for by its PTS was never
  // found (no frames) or the start was not looked for at all (every frame from the keyframe, all late)
  const wrapPath = join(dir, 'wrap.ts');
  const wrapMade = spawnSync(
    FFMPEG,
    [
      ...['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=10', '-t', '4', '-c:v', 'libx265'],
      ...['-x265-params', 'keyint=10:min-keyint=10:bframes=0:log-level=error', '-output_ts_offset', String(2 ** 33 / 90_000 - 2.9), '-f', 'mpegts', wrapPath],
    ],
    { encoding: 'utf8' },
  );
  assert.equal(wrapMade.status, 0, wrapMade.stderr);
  const wrapIndex: [number, number][] = [];
  let wrapFirst: number | undefined;
  let wrapped = false;
  const wrapScan = new TsDemuxer((au) => {
    if (wrapFirst !== undefined && au.pts < wrapFirst) wrapped = true;
    wrapFirst ??= au.pts;
    if (au.keyframe) wrapIndex.push([au.offset, Math.round((ptsDelta(wrapFirst, au.pts) / 90) * 1000)]);
  });
  wrapScan.push(readFileSync(wrapPath), 0);
  wrapScan.flush();
  assert.ok(wrapped, 'the PTS wrap inside the file');
  const wrapSegment = { path: wrapPath, codec: 'h265', video_pid: wrapScan.videoPid, audio_pid: -1, keyframes: JSON.stringify(wrapIndex) } as unknown as SegmentRow;
  // the keyframe 1 s in, the wrap 1.5 s in
  const wrapKeyframe = { offset: wrapIndex[1]![0], tsUs: wrapIndex[1]![1] };
  const wrapTimes = video(await collect(readFrames(wrapSegment, wrapKeyframe))).map((frame) => frame.tsUs);
  for (const seekTo of [wrapTimes[3]!, wrapTimes[7]!]) {
    const fromSeek = video(await collect(readFramesAsH264(wrapPath, wrapKeyframe, { ffmpegPath: FFMPEG, encoder: LIBX264, startUs: seekTo }))).map((frame) => frame.tsUs);
    assert.deepEqual(fromSeek, wrapTimes.filter((ts) => ts >= seekTo), `a seek ${seekTo - wrapKeyframe.tsUs} us into the GOP over the wrap`);
  }

  // ---- a camera that sends B-frames: a seek inside a GOP begins with the frame of the time, the times those of the
  // recording. The first frame after the time in the order they are sent was taken for it, not the first shown, and
  // every time after was off by the reorder
  const bPath = join(dir, 'bframes.ts');
  const bMade = spawnSync(
    FFMPEG,
    [
      ...['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=10', '-t', '4', '-c:v', 'libx265'],
      ...['-x265-params', 'keyint=20:min-keyint=20:bframes=2:b-adapt=0:open-gop=0:log-level=error', '-f', 'mpegts', bPath],
    ],
    { encoding: 'utf8' },
  );
  assert.equal(bMade.status, 0, bMade.stderr);
  const bIndex: [number, number][] = [];
  let bFirst: number | undefined;
  let reordered = false;
  let bLast: number | undefined;
  const bScan = new TsDemuxer((au) => {
    if (bLast !== undefined && au.pts < bLast) reordered = true;
    bLast = au.pts;
    bFirst ??= au.pts;
    if (au.keyframe) bIndex.push([au.offset, Math.round((ptsDelta(bFirst, au.pts) / 90) * 1000)]);
  });
  bScan.push(readFileSync(bPath), 0);
  bScan.flush();
  assert.ok(reordered, 'frames sent in another order than shown');
  const bSegment = { path: bPath, codec: 'h265', video_pid: bScan.videoPid, audio_pid: -1, keyframes: JSON.stringify(bIndex) } as unknown as SegmentRow;
  const bStart = { offset: bIndex[0]![0], tsUs: bIndex[0]![1] };
  const bTimes = video(await collect(readFrames(bSegment, bStart)))
    .map((frame) => frame.tsUs)
    .sort((a, b) => a - b);
  // a B-frame of the time (sent after the P-frame shown later)
  for (const bSeek of [bTimes[13]!, bTimes[14]!]) {
    const bMadeTimes = video(await collect(readFramesAsH264(bPath, bStart, { ffmpegPath: FFMPEG, encoder: LIBX264, startUs: bSeek }))).map((frame) => frame.tsUs);
    assert.deepEqual(bMadeTimes, bTimes.filter((ts) => ts >= bSeek), `from the frame of ${bSeek}, at the times of the recording`);
  }

  // ---- leading pictures shown before their keyframe (RADL): a seek begins with the frame of the time, the times those
  // of the recording. Looked for by the distance from the first frame decoded (a leading one), it began 0.2 s early
  const radlPath = join(dir, 'radl.ts');
  const radlMade = spawnSync(
    FFMPEG,
    [
      ...['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=10', '-t', '4', '-c:v', 'libx265'],
      ...['-x265-params', 'keyint=10:min-keyint=10:bframes=3:b-adapt=0:open-gop=0:radl=2:log-level=error', '-f', 'mpegts', radlPath],
    ],
    { encoding: 'utf8' },
  );
  assert.equal(radlMade.status, 0, radlMade.stderr);
  const radlIndex: [number, number][] = [];
  let radlFirst: number | undefined;
  const radlScan = new TsDemuxer((au) => {
    radlFirst ??= au.pts;
    if (au.keyframe) radlIndex.push([au.offset, Math.round((ptsDelta(radlFirst, au.pts) / 90) * 1000)]);
  });
  radlScan.push(readFileSync(radlPath), 0);
  radlScan.flush();
  const radlSegment = { path: radlPath, codec: 'h265', video_pid: radlScan.videoPid, audio_pid: -1, keyframes: JSON.stringify(radlIndex) } as unknown as SegmentRow;
  const radlKeyframe = { offset: radlIndex[1]![0], tsUs: radlIndex[1]![1] };
  const radlTimes = video(await collect(readFrames(radlSegment, radlKeyframe)))
    .map((frame) => frame.tsUs)
    .sort((a, b) => a - b);
  const radlSeek = radlKeyframe.tsUs + 200_000;
  assert.deepEqual(
    video(await collect(readFramesAsH264(radlPath, radlKeyframe, { ffmpegPath: FFMPEG, encoder: LIBX264, startUs: radlSeek }))).map((frame) => frame.tsUs),
    radlTimes.filter((ts) => ts >= radlSeek),
    'with leading pictures: from the frame of the time',
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

  // ---- the camera's clock jumped inside the file (it restarted behind go2rtc): the recorder takes a new anchor where
  // the PTS break by more than 5 s (recorder.ts frameTime) and the time goes on. Frames made H.264 take those times as
  // readFrames does, backwards and forwards: after a jump back they were 93 s late in the review, and the playback
  // waited that long
  const part = (offsetS: number) => {
    const partPath = join(dir, `part-${offsetS}.ts`);
    const madePart = spawnSync(
      FFMPEG,
      [
        ...['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=10', '-t', '3', '-c:v', 'libx265'],
        ...['-x265-params', 'keyint=10:min-keyint=10:bframes=0:log-level=error', '-output_ts_offset', String(offsetS), '-f', 'mpegts', partPath],
      ],
      { encoding: 'utf8' },
    );
    assert.equal(madePart.status, 0, madePart.stderr);
    return readFileSync(partPath);
  };
  // the last: a jump back and, later in the same file, the recorder's clock moved by 5 s on a drift
  for (const [before, after, movedAfter] of [
    [100, 10, false],
    [10, 100, false],
    [100, 10, true],
  ] as const) {
    const joined = Buffer.concat([part(before), part(after)]);
    const kept: Buffer[] = [];
    let tablesKept = 0;
    for (let at = 0; at + 188 <= joined.length; at += 188) {
      const packet = joined.subarray(at, at + 188);
      const pid = ((packet[1]! & 0x1f) << 8) | packet[2]!;
      if ((pid === 0 || pid === 0x1000) && tablesKept++ >= 2) continue;
      kept.push(packet);
    }
    const jumpPath = join(dir, `jump-${before}-${after}.ts`);
    writeFileSync(jumpPath, Buffer.concat(kept));
    // the index as the recorder makes it
    const jumpIndex: [number, number][] = [];
    let anchor: { pts: number; us: number } | undefined;
    let last: { pts: number; us: number } | undefined;
    const jumpScan = new TsDemuxer((au) => {
      if (last && Math.abs(ptsDelta(last.pts, au.pts)) > 5 * 90_000) anchor = { pts: au.pts, us: last.us + 100_000 };
      anchor ??= { pts: au.pts, us: 0 };
      const us = anchor.us + Math.round((ptsDelta(anchor.pts, au.pts) / 90) * 1000);
      last = { pts: au.pts, us };
      if (au.keyframe) jumpIndex.push([au.offset, us]);
    });
    jumpScan.push(readFileSync(jumpPath), 0);
    jumpScan.flush();
    if (movedAfter) for (let i = 4; i < jumpIndex.length; i++) jumpIndex[i]![1] += 5_000_000;
    const jumpSegment = { path: jumpPath, codec: 'h265', video_pid: jumpScan.videoPid, audio_pid: -1, keyframes: JSON.stringify(jumpIndex) } as unknown as SegmentRow;
    const jumpStart = { offset: jumpIndex[0]![0], tsUs: jumpIndex[0]![1] };
    const read = video(await collect(readFrames(jumpSegment, jumpStart))).map((frame) => frame.tsUs);
    const madeTimes = video(
      await collect(readFramesAsH264(jumpPath, jumpStart, { ffmpegPath: FFMPEG, encoder: LIBX264, keyframes: jumpIndex.map(([offset, tsUs]) => ({ offset, tsUs })) })),
    ).map((frame) => frame.tsUs);
    assert.equal(read.length, 60);
    assert.deepEqual(madeTimes, read, `a jump of the camera's clock from ${before} s to ${after} s${movedAfter ? ', then a move' : ''}: the times readFrames gives`);
  }

  // ---- the file being written, from a keyframe in its middle, as the recorder lays it out: the first frame comes at
  // once. Without the tables ffmpeg looked through 5 MB for the streams first: about a minute of a camera's recording
  // at the live tip (39 s at 1.1 Mbit/s in the review)
  // followed for 10 s: without the tables the first frame came only when the following ended
  const followUntil = Date.now() + 10_000;
  const askedAt = Date.now();
  let firstAfter: number | undefined;
  const live: Frame[] = [];
  for await (const frame of readFramesAsH264(recorderPath, recorderKeyframes[2]!, { ffmpegPath: FFMPEG, encoder: LIBX264, follow: () => Date.now() < followUntil })) {
    firstAfter ??= Date.now() - askedAt;
    live.push(frame);
  }
  assert.ok(firstAfter !== undefined && firstAfter < 5000, `the first frame of the file being written after ${firstAfter} ms`);
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
  assert.equal(h264Slots(), Math.max(2, Math.floor(availableParallelism() / 2)), 'half the cores of the machine, at least two');
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

  // ---- a client that takes no frame for a while (a paused playback; a tab closed without a word, whose reading is
  // never ended) leaves its place to others: its ffmpeg ends. Back, it goes on where it was, every frame once
  setH264Slots(1);
  setH264Idle(200);
  const index = keyframes.map(([offset, tsUs]) => ({ offset, tsUs }));
  const pausing = readFramesAsH264(path, start, { ffmpegPath: FFMPEG, encoder: LIBX264, keyframes: index })[Symbol.asyncIterator]();
  const pausedTimes: number[] = [];
  for (let i = 0; i < 25; i++) pausedTimes.push(((await pausing.next()).value as Frame).tsUs);
  await sleep(600);
  const meanwhile = await Promise.race([
    collect(readFramesAsH264(path, start, { ffmpegPath: FFMPEG, encoder: LIBX264 })).then((frames) => frames.length),
    sleep(15_000).then(() => -1),
  ]);
  assert.ok(meanwhile > 0, 'another reads while the paused one waits');
  for (;;) {
    const step = await pausing.next();
    if (step.done) break;
    pausedTimes.push((step.value as Frame).tsUs);
  }
  assert.deepEqual(
    pausedTimes,
    recorded.map((frame) => frame.tsUs),
    'back, every frame once, at its time',
  );
  // with the sound: every sound frame once too (the sound runs behind the picture in the output, and the part between
  // the last sound given and the last picture was lost)
  const allSound = (await collect(readFramesAsH264(path, start, { ffmpegPath: FFMPEG, encoder: LIBX264, audio: true, keyframes: index })))
    .filter((frame) => frame.audio)
    .map((frame) => frame.tsUs);
  // paused before any sound was taken, in the middle of a GOP, and right on a keyframe (the sound taken last is before
  // it): every sound frame once all the same. The sound that came out of ffmpeg before the first picture was dropped
  for (const pausedAt of [3, 13, 20, 27]) {
    const pausingSound = readFramesAsH264(path, start, { ffmpegPath: FFMPEG, encoder: LIBX264, audio: true, keyframes: index })[Symbol.asyncIterator]();
    const soundTimes: number[] = [];
    const pictureTimes: number[] = [];
    const take = (frame: Frame) => (frame.audio ? soundTimes : pictureTimes).push(frame.tsUs);
    while (pictureTimes.length < pausedAt) take((await pausingSound.next()).value as Frame);
    await sleep(600);
    for (;;) {
      const step = await pausingSound.next();
      if (step.done) break;
      take(step.value as Frame);
    }
    assert.deepEqual(soundTimes, allSound, `paused after ${pausedAt} pictures: back, every sound frame once`);
    assert.deepEqual(pictureTimes, recorded.map((frame) => frame.tsUs), `paused after ${pausedAt} pictures: every picture once`);
  }
  // a camera of 25 fps and 48 kHz sound: the sound comes out of ffmpeg ahead of the first new picture after a pause,
  // and was dropped there (8 frames, 170 ms)
  const sound25 = join(dir, 'sound25.ts');
  const sound25Made = spawnSync(
    FFMPEG,
    [
      ...['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'],
      ...['-t', '5', '-c:v', 'libx265', '-x265-params', 'keyint=25:min-keyint=25:bframes=0:log-level=error', '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-f', 'mpegts', sound25],
    ],
    { encoding: 'utf8' },
  );
  assert.equal(sound25Made.status, 0, sound25Made.stderr);
  const index25: { offset: number; tsUs: number }[] = [];
  let first25: number | undefined;
  const scan25 = new TsDemuxer((au) => {
    first25 ??= au.pts;
    if (au.keyframe) index25.push({ offset: au.offset, tsUs: Math.round((ptsDelta(first25, au.pts) / 90) * 1000) });
  });
  scan25.push(readFileSync(sound25), 0);
  scan25.flush();
  const read25 = (signal?: AbortSignal) => readFramesAsH264(sound25, index25[0]!, { ffmpegPath: FFMPEG, encoder: LIBX264, audio: true, keyframes: index25, signal });
  const all25 = (await collect(read25())).filter((frame) => frame.audio).map((frame) => frame.tsUs);
  const paused25 = read25()[Symbol.asyncIterator]();
  const sound25Times: number[] = [];
  let pictures25 = 0;
  while (pictures25 < 37) {
    const frame = (await paused25.next()).value as Frame;
    if (frame.audio) sound25Times.push(frame.tsUs);
    else pictures25++;
  }
  await sleep(600);
  for (;;) {
    const step = await paused25.next();
    if (step.done) break;
    if ((step.value as Frame).audio) sound25Times.push((step.value as Frame).tsUs);
  }
  assert.deepEqual(sound25Times, all25, '25 fps, 48 kHz: back, every sound frame once');
  // one never taken again keeps no place
  const abandoned = readFramesAsH264(path, start, { ffmpegPath: FFMPEG, encoder: LIBX264 })[Symbol.asyncIterator]();
  await abandoned.next();
  await sleep(600);
  assert.ok((await collect(readFramesAsH264(path, start, { ffmpegPath: FFMPEG, encoder: LIBX264 }))).length > 0, 'a reading left for good keeps no place');
  // a playback keeps its place from one file to the next: the cameras of an episode took turns at every file's end
  const place = new H264Place();
  assert.ok((await collect(readFramesAsH264(path, start, { ffmpegPath: FFMPEG, encoder: LIBX264, place }))).length > 0, 'one file of a playback');
  let otherWaits = true;
  const other = collect(readFramesAsH264(path, start, { ffmpegPath: FFMPEG, encoder: LIBX264 })).then((frames) => {
    otherWaits = false;
    return frames;
  });
  await sleep(300);
  const nextFile = await Promise.race([collect(readFramesAsH264(path, start, { ffmpegPath: FFMPEG, encoder: LIBX264, place })).then((frames) => frames.length), sleep(10_000).then(() => -1)]);
  assert.ok(nextFile > 0, 'its next file goes on in the place it has');
  assert.equal(otherWaits, true, 'while another waits');
  place.release();
  assert.ok((await other).length > 0, 'the place is the other one’s once the playback ends');
  // a short read (a scrub, a trace picture, a hover excerpt) waits 10 s at most, then gives no frames: a hover asked
  // again every 10 s piled up readings nobody wanted any more
  setH264Idle(30_000);
  const holder = readFramesAsH264(path, start, { ffmpegPath: FFMPEG, encoder: LIBX264 })[Symbol.asyncIterator]();
  await holder.next();
  const waitedAt = Date.now();
  assert.equal((await collect(readFramesAsH264(path, start, { ffmpegPath: FFMPEG, encoder: LIBX264, waitMs: 300 }))).length, 0);
  assert.ok(Date.now() - waitedAt < 5000, 'given up after its wait');
  await holder.return(undefined);
  setH264Slots(machineSlots);

  // ---- a client that stops while the file is being read (a slow disk): it ends, and its place is free. The feeding
  // wrote into ffmpeg's closed input and waited for a 'drain' that never came: the read never ended and kept its place
  // (2 of 8 on a disk taking 10 ms a read, 4 of 4 at 40 ms, in the review), and a few took every place
  const probe = await open(noisy, 'r');
  const fileHandle = Object.getPrototypeOf(probe) as { read: (...args: unknown[]) => Promise<unknown> };
  await probe.close();
  const realRead = fileHandle.read;
  fileHandle.read = async function (this: unknown, ...args: unknown[]) {
    await sleep(40);
    return realRead.apply(this, args);
  };
  try {
    for (let i = 0; i < h264Slots() + 2; i++) {
      const stopped = readFramesAsH264(noisy, { offset: 0, tsUs: 0 }, { ffmpegPath: FFMPEG, encoder: LIBX264 })[Symbol.asyncIterator]();
      assert.equal((await stopped.next()).done, false);
      const ended = await Promise.race([stopped.return(undefined).then(() => 'ended'), sleep(10_000).then(() => 'hung')]);
      assert.equal(ended, 'ended', `a read stopped while the file is read ends (${i})`);
    }
  } finally {
    fileHandle.read = realRead;
  }

  // ---- a reading its client ends (a seek, a scrub that moved on, a playback the RPC cancels as its tab closed): its
  // ffmpeg ends with it. The reading closed its file and freed its place but left ffmpeg held on its full output, the
  // feeding waiting for a 'drain' that never came: a process for good for every seek of a viewer without H.265 (one
  // still there minutes after the tab was closed, bench)
  const processes = () => process.getActiveResourcesInfo().filter((resource) => resource === 'ProcessWrap').length;
  // the readings stopped above end their ffmpeg as their feeding finds the file closed: after a while
  for (const until = Date.now() + 10_000; processes() > 0 && Date.now() < until; ) await sleep(50);
  const runningBefore = processes();
  for (const [name, options] of [
    ['a short read', {}],
    ['a playback, its place kept for its next file', { place: new H264Place() }],
  ] as const) {
    const ended = readFramesAsH264(noisy, { offset: 0, tsUs: 0 }, { ffmpegPath: FFMPEG, encoder: LIBX264, ...options })[Symbol.asyncIterator]();
    for (let i = 0; i < 3; i++) assert.equal((await ended.next()).done, false);
    // ffmpeg fills what the reading holds and is held
    await sleep(1500);
    assert.equal(processes(), runningBefore + 1, `${name}: its ffmpeg runs`);
    await ended.return(undefined);
    let running = processes();
    for (const until = Date.now() + 5000; running > runningBefore && Date.now() < until; running = processes()) await sleep(50);
    assert.equal(running, runningBefore, `${name}: its ffmpeg ended with it`);
    options.place?.release();
  }

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
