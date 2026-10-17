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
import { setTimeout as sleep } from 'node:timers/promises';

import VionNvr from '../src/index.js';
import { probeCodec } from '../src/media/codec.js';
import { h264Slots, LIBX264, readFramesAsH264, setH264Slots } from '../src/media/transcode.js';
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

function stream(codec: 'libx264' | 'libx265', size = '640x360', seconds = 3, keyint = 10): Buffer {
  const path = join(dir, `${codec}-${size}-${seconds}-${keyint}.ts`);
  const params = codec === 'libx265' ? ['-x265-params', `keyint=${keyint}:min-keyint=${keyint}:bframes=0:log-level=error`] : ['-g', '10', '-bf', '0'];
  const made = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=10`, '-t', String(seconds), '-c:v', codec, ...params, '-f', 'mpegts', path], {
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
for (const id of ['cam', 'old', 'subs', 'live', 'two', 'resized', 'switch', 'through', 'sparse', 'moved']) internals.cameras.set(id, { device: { id, name: id }, recorders: new Map(), subscriptions: [] });
internals.ffmpegPath = FFMPEG;
// libx264 here whatever the machine has: the hardware ones are the encoder spec's
internals.h264Encoder = Promise.resolve(LIBX264);

/** Three seconds recorded by a real recorder at `atMs`, in pieces as from a camera. */
async function record(camera: string, role: string, data: Buffer, atMs: number, seconds = 3): Promise<SegmentRow> {
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
  const pieces = seconds * 10;
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
  const row = internals.store.segments(camera, role, atMs * 1000, (atMs + seconds * 1000) * 1000).at(-1);
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
  const low = await play('cam', cam.start_us, 'h264');
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
  const coarse = await nvr.nvrScrub('cam', target, false, 'h264');
  assert.equal(coarse.videoCodec, 'h264');
  assert.match(coarse.codecString!, /^avc1\./);
  assert.equal(coarse.ts, keyframeBefore, 'the keyframe before the time');
  assert.ok(probeCodec(Buffer.from(coarse.frame!), 'h264'));
  // the frames from the keyframe to the time are decoded, not made: the frame of the time alone, made a keyframe
  const fine = await nvr.nvrScrub('cam', target, true, 'h264');
  assert.equal(fine.videoCodec, 'h264');
  assert.deepEqual(
    fine.frames!.map((frame) => [frame.ts, frame.keyframe]),
    [[target, true]],
    'the frame of the time alone',
  );
  assert.equal((await nvr.nvrScrub('cam', target, true, 'high')).videoCodec, 'h265', 'asked as it is: as it is');

  const trace = await nvr.nvrTraceFrames('cam', [{ tMs: target / 1000, src: 'h264' } as never], 'exact');
  assert.equal(trace.chains.length, 1);
  assert.equal(trace.chains[0]!.videoCodec, 'h264');
  assert.deepEqual(
    trace.chains[0]!.frames.map((frame) => frame.ts),
    [target],
  );
  assert.equal(trace.chains[0]!.keep[0]!.index, 0);
  // the strip: the ticks on one keyframe share one picture made once (a strip of 40 ticks on a Xiaomi GOP was 40
  // ffmpeg runs of the same keyframe)
  const strip3 = await nvr.nvrTraceFrames(
    'cam',
    [recorded[11]!, recorded[13]!, recorded[15]!].map((ts) => ({ tMs: ts / 1000, src: 'h264' }) as never),
    'keyframe',
  );
  assert.equal(strip3.chains.length, 1, 'one picture for the three');
  assert.deepEqual(
    strip3.chains[0]!.keep.map((keep) => [keep.target, keep.index]),
    [
      [0, 0],
      [1, 0],
      [2, 0],
    ],
  );
  assert.equal(strip3.chains[0]!.frames[0]!.ts, keyframeBefore);
  // a playback from the middle of a GOP begins with the frame of the time: the ones before it are not made and sent
  const seek = await play('cam', target, 'h264');
  assert.deepEqual([seek.frames[0]!.ts, seek.frames[0]!.keyframe], [target, true], 'from the time, a keyframe');
  assert.deepEqual(
    seek.frames.map((frame) => frame.ts),
    recorded.filter((ts) => ts >= target),
  );

  // an excerpt from the middle of a GOP begins with the frame of the event's start, the pre-roll decoded only
  const midHover = await nvr.nvrPreviewFrames('cam', target, cam.end_us, 12, 'motion', 1_000_000, true);
  assert.deepEqual([midHover.frames[0]!.ts, midHover.frames[0]!.keyframe], [target, true], 'the excerpt begins at the event');
  const hover = await nvr.nvrPreviewFrames('cam', cam.start_us, cam.end_us, 12, 'motion', 2_000_000, true);
  assert.equal(hover.videoCodec, 'h264');
  assert.ok(hover.frames.length >= 15, `hover frames ${hover.frames.length}`);
  assert.ok(hover.frames.every((frame) => recorded.includes(frame.ts)), 'at recorded times');
  assert.equal((await nvr.nvrPreviewFrames('cam', cam.start_us, cam.end_us, 12, 'motion', 2_000_000)).videoCodec, 'h265', 'a client with H.265: as it is');
  // an event whose recording begins 40 s after it (a recording made by events): the excerpt found later is made too
  const lateEvent = await nvr.nvrPreviewFrames('cam', cam.start_us - 40_000_000, cam.end_us, 12, 'motion', 2_000_000, true);
  assert.equal(lateEvent.videoCodec, 'h264', 'the excerpt of a recording that begins after the event, made H.264');
  assert.ok(lateEvent.frames.length > 0);
  // an excerpt across the end of a file goes on in the next one, made H.264 as well: it stopped at the end of the first
  const one = await record('two', 'high', hevc, at + 60_000);
  const two = await record('two', 'high', hevc, at + 63_000);
  assert.ok(two.start_us > one.start_us && one.id !== two.id, 'two files one after the other');
  // a playback keeps its place from the first file to the next: with one place, another reading waits for its end
  const machineSlots = h264Slots();
  setH264Slots(1);
  const order: string[] = [];
  const playing = play('two', one.start_us, 'h264').then(() => order.push('playback'));
  await sleep(1000);
  const reading = (async () => {
    for await (const _ of readFramesAsH264(internals.store.located(two).path, parseKeyframes(two.keyframes)[0]!, { ffmpegPath: FFMPEG, encoder: LIBX264 }));
    order.push('other');
  })();
  await Promise.all([playing, reading]);
  // a scrub picture waits 10 s for a place at most, then there is none: nobody waits for one longer
  const busyReading = readFramesAsH264(internals.store.located(two).path, parseKeyframes(two.keyframes)[0]!, { ffmpegPath: FFMPEG, encoder: LIBX264 })[
    Symbol.asyncIterator
  ]();
  await busyReading.next();
  const scrubAsked = Date.now();
  const waitedScrub = await Promise.race([nvr.nvrScrub('two', two.start_us + 500_000, false, 'h264'), sleep(20_000).then(() => undefined)]);
  assert.ok(waitedScrub?.noData, 'no picture while every place is taken');
  assert.ok(Date.now() - scrubAsked >= 9000, 'after waiting for one');
  await busyReading.return(undefined);
  setH264Slots(machineSlots);
  assert.deepEqual(order, ['playback', 'other'], 'the playback was not cut at the end of its first file');
  const across = await nvr.nvrPreviewFrames('two', one.end_us - 1_000_000, two.end_us, 12, 'motion', 3_000_000, true);
  assert.equal(across.videoCodec, 'h264');
  assert.ok(
    across.frames.some((frame) => frame.ts >= two.start_us),
    `the excerpt goes on into the next file (last ${across.frames.at(-1)?.ts}, next file from ${two.start_us})`,
  );
  // but not into a file recorded another way (the camera's picture changed size): one decoder setup for the excerpt
  const before = await record('resized', 'high', hevc, at + 70_000);
  const after = await record('resized', 'high', stream('libx265', '320x180'), at + 73_000);
  for (const h264Only of [false, true]) {
    const cut = await nvr.nvrPreviewFrames('resized', before.end_us - 1_000_000, after.end_us, 12, 'motion', 3_000_000, h264Only);
    assert.ok(cut.frames.length > 0);
    assert.ok(
      cut.frames.every((frame) => frame.ts < after.start_us),
      `${h264Only ? 'made H.264' : 'as it is'}: not into the file of another size`,
    );
  }
  const strip = await nvr.nvrPreviewFrames('cam', cam.start_us, cam.end_us, 4, 'keyframes', 4_000_000, true);
  assert.equal(strip.videoCodec, 'h264');
  assert.ok(strip.frames.length >= 2 && strip.frames.every((frame) => frame.keyframe && probeCodec(Buffer.from(frame.frame), 'h264')), 'keyframes, each H.264');

  // ---- a trim export of a browser that plays it made H.264 is H.264 too: as it is, an H.265 MP4 the player of Windows
  // does not open without a paid extension (the H.264 copy was exported before)
  const exported = async (sourceRole?: string) => {
    const result = await nvr.nvrExport('cam', cam.start_us, cam.end_us, { sourceRole });
    return readFileSync(join((internals as unknown as { dataDir: string }).dataDir, 'exports', result.filename)).toString('latin1');
  };
  const madeMp4 = await exported('h264');
  assert.ok(madeMp4.includes('avcC') && !madeMp4.includes('hvcC'), 'an H.264 MP4');
  const asIsMp4 = await exported();
  assert.ok(asIsMp4.includes('hvcC'), 'asked as it is: the H.265 recording, copied');

  // ---- 'scrub' asks for the lightest recording, not for H.264: a browser with H.265 got every scrub and every
  // picture-in-picture playback made H.264 (100 ms instead of 10 a frame). One without H.265 falls back to 'h264' itself
  // (ui/src/nvr/playback.ts recover)
  assert.equal((await nvr.nvrScrub('cam', target, false, 'scrub')).videoCodec, 'h265', 'a coarse scrub as it is');
  assert.equal((await nvr.nvrScrub('cam', target, true, 'scrub')).videoCodec, 'h265', 'a fine scrub as it is');
  assert.equal((await play('cam', cam.start_us, 'scrub')).ready[0]!.videoCodec, 'h265', 'a playback as it is');

  // ---- a time with a low recording (the archive of before, when the recorder kept the H.264 copy): that one
  const old = await record('old', 'high', hevc, at);
  const oldLow = await record('old', 'low', avc, at);
  const kept = await play('old', old.start_us, 'h264');
  assert.equal(kept.ready[0]!.role, 'low');
  assert.equal(kept.ready[0]!.codecString, oldLow.codec_string, 'the recorded copy, not one made now');
  assert.deepEqual(
    kept.frames.map((frame) => frame.ts),
    await times(oldLow),
  );

  // ---- the old low recording ends where the recorder stopped keeping the copy, the high one goes on: so does the
  // playback, made H.264. It stopped there with «no data»
  const switchHigh = await record('switch', 'high', hevc, at + 80_000);
  const switchHigh2 = await record('switch', 'high', hevc, at + 83_000);
  const switchLow = await record('switch', 'low', avc, at + 80_000);
  const crossing = await play('switch', switchLow.start_us, 'h264');
  assert.equal(crossing.ready[0]!.role, 'low', 'the recorded copy first');
  const lowEnd = (await times(switchLow)).at(-1)!;
  assert.ok(crossing.ready.some((ready) => ready.role === 'high' && ready.videoCodec === 'h264'), 'then the high one, made H.264, told as such');
  assert.equal(crossing.frames.at(-1)!.ts, (await times(switchHigh2)).at(-1), 'on to the end of the high recording');
  assert.ok(crossing.frames.filter((frame) => frame.ts > lowEnd).length >= 30, 'past the end of the low one');
  assert.equal(crossing.order.filter((step) => step === 'end').length, 1, 'no «no data» where the low one ends');
  void switchHigh;
  // the high file going on through that moment, as it does: from its keyframe before it, on to its end
  const throughHigh = await record('through', 'high', stream('libx265', '640x360', 6), at + 90_000, 6);
  const throughLow = await record('through', 'low', avc, at + 90_000);
  const throughLowEnd = (await times(throughLow)).at(-1)!;
  const through = await play('through', throughLow.start_us, 'h264');
  const throughTimes = await times(throughHigh);
  assert.equal(through.frames.at(-1)!.ts, throughTimes.at(-1), 'to the end of the high file');
  assert.deepEqual(
    through.frames.filter((frame) => frame.ts > throughLowEnd).map((frame) => frame.ts),
    throughTimes.filter((ts) => ts > throughLowEnd),
    'every frame of it past the moment, once',
  );
  const lowCount = (await times(throughLow)).length;
  const primed = through.frames.filter((frame) => frame.ts <= throughLowEnd).length - lowCount;
  assert.equal(primed, 0, 'none of the frames sent before is sent again');

  // ---- keyframes far apart (seen: 60-80 s on the Xiaomi): a fine scrub or an exact trace frame past 300 frames from
  // its keyframe gets the nearer keyframe, as the H.265 recording gives it (readExact). It got the 300th frame, 15 s
  // from the time asked for in the review, and 300 frames encoded for it
  const sparse = await record('sparse', 'high', stream('libx265', '640x360', 40, 350), at + 100_000, 40);
  const sparseKeyframes = parseKeyframes(sparse.keyframes);
  assert.equal(sparseKeyframes.length, 2, 'a keyframe at the start and one 35 s on');
  const farTarget = sparseKeyframes[0]!.tsUs + 31_000_000;
  const asIs = await nvr.nvrScrub('sparse', farTarget, true, 'high');
  const madeFar = await nvr.nvrScrub('sparse', farTarget, true, 'h264');
  assert.equal(madeFar.videoCodec, 'h264');
  assert.deepEqual(
    madeFar.frames!.map((frame) => frame.ts),
    asIs.frames!.map((frame) => frame.ts),
    'the frame the recording as it is gives',
  );
  assert.deepEqual(asIs.frames!.map((frame) => frame.ts), [sparseKeyframes[1]!.tsUs], 'the nearer keyframe, 4 s on');
  const farTrace = await nvr.nvrTraceFrames('sparse', [{ tMs: farTarget / 1000, src: 'h264' } as never], 'exact');
  assert.equal(farTrace.chains[0]!.frames.at(-1)!.ts, sparseKeyframes[1]!.tsUs, 'the trace frame too');

  // ---- the recorder moved its clock in the middle of a file (recorder.ts): playback, scrub and the hover excerpt made
  // H.264 take the times of its index from that keyframe on, as the recording as it is gives them
  const movedRow = await record('moved', 'high', hevc, at + 150_000);
  const movedIndex = parseKeyframes(movedRow.keyframes).map((kf, i) => [kf.offset, i >= 1 ? kf.tsUs + 5_000_000 : kf.tsUs]);
  internals.store.updateSegment(movedRow.id, movedRow.end_us + 5_000_000, movedRow.bytes, JSON.stringify(movedIndex));
  const movedTimes = await times(internals.store.segment(movedRow.id)!);
  assert.ok(movedTimes.at(-1)! - (await times(movedRow)).at(-1)! === 5_000_000, 'the move is in the index');
  assert.deepEqual((await play('moved', movedRow.start_us, 'h264')).frames.map((frame) => frame.ts), movedTimes, 'a playback');
  const movedTarget = movedTimes[25]!;
  const movedFine = await nvr.nvrScrub('moved', movedTarget, true, 'h264');
  assert.equal(movedFine.frames!.at(-1)!.ts, movedTarget, 'a fine scrub');
  const movedHover = await nvr.nvrPreviewFrames('moved', movedRow.start_us, movedTimes.at(-1)!, 12, 'motion', 4_000_000, true);
  assert.ok(
    movedHover.frames.every((frame) => movedTimes.includes(frame.ts)),
    'a hover excerpt',
  );

  // ---- a lighter stream recorded in H.265 too (a camera recording its high and mid streams, both H.265): that one,
  // made H.264. It went as H.265 and the player had nothing left to fall back to
  await record('subs', 'high', hevc, at);
  const subsMid = await record('subs', 'mid', hevc, at);
  const sub = await play('subs', subsMid.start_us, 'h264');
  assert.equal(sub.ready[0]!.role, 'mid', 'the lighter recording');
  assert.equal(sub.ready[0]!.videoCodec, 'h264', 'made H.264');
  assert.deepEqual(
    sub.frames.map((frame) => frame.ts),
    await times(subsMid),
  );
  assert.equal((await nvr.nvrScrub('subs', target, false, 'h264')).videoCodec, 'h264');
  assert.equal((await nvr.nvrScrub('subs', target, false, 'scrub')).videoCodec, 'h265', 'a scrub as it is');
  // 'low' is also what a camera is set to play (its playback source): the lighter recording as it is, H.265 too. It
  // had every playback and scrub of such a camera made H.264 in a browser that decodes H.265
  const lowAsSet = await play('subs', subsMid.start_us, 'low');
  assert.deepEqual([lowAsSet.ready[0]!.role, lowAsSet.ready[0]!.videoCodec], ['mid', 'h265'], 'the mid recording as it is');
  assert.equal((await nvr.nvrScrub('subs', target, true, 'low')).videoCodec, 'h265');
  assert.equal((await play('cam', cam.start_us, 'low')).ready[0]!.videoCodec, 'h265', 'an H.265 camera recorded alone: as it is');

  // ---- the newest seconds, in the file being written past what its index says yet (it is written every 4 s): made
  // H.264 too. They went as H.265, the time found in the file but not in the index
  const liveAt = realNow() - 300_000;
  const liveRec = new Recorder({
    cameraId: 'live',
    role: 'high',
    rtspUrl: 'rtsp://unused',
    ffmpegPath: FFMPEG,
    dir: join(dir, 'recordings', 'live'),
    store: internals.store,
    mode: 'continuous',
    preBufferSec: 0,
    postBufferSec: 0,
    segmentSec: 600,
    log: noop,
    onStateChange: noop,
    onSegment: noop,
  });
  const piece = Math.ceil(hevc.length / 188 / 30) * 188;
  try {
    for (let i = 0; i < 25; i++) {
      Date.now = () => liveAt + i * 100;
      (liveRec as unknown as { onData(c: Buffer): void }).onData(Buffer.from(hevc.subarray(i * piece, (i + 1) * piece)));
    }
  } finally {
    Date.now = realNow;
  }
  (internals.cameras.get('live') as { recorders: Map<string, unknown> }).recorders.set('high', liveRec);
  await sleep(300);
  const liveRow = internals.store.segment(liveRec.liveSegmentId!)!;
  const tail = liveRow.start_us + 1_200_000;
  assert.ok(liveRow.end_us < tail, 'the index of the file being written ends before the time asked for');
  assert.equal((await nvr.nvrScrub('live', tail, false, 'h264')).videoCodec, 'h264', 'the newest seconds made H.264');
  await liveRec.stop();

  console.log('playback-h264.spec: H.265 made H.264 for a low stream, told first, every frame at its time; H.265 as it is; an old copy played — ok');
  finished = true;
  process.exit(0);
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
