// Export (src/export.ts and the export calls of the plugin): a clip over a pause in the recording ends where it was
// asked to end and says how long it really is, back-to-back files still join without a seam, a timelapse shows the
// range it was asked for wherever that starts, an export that cannot fit into a ZIP is refused before anything is
// written, a failed export leaves no files on the archive disk and an expired one no empty folder.
// Needs ffmpeg with libx264 on PATH (or CAMERAUI_FFMPEG_PATH). Run: npx tsx spec/export.spec.ts
import assert from 'node:assert/strict';
import childProcess, { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clipPlan, exportClip, writeZip } from '../src/export.js';
import VionNvr from '../src/index.js';

import type { SegmentRow } from '../src/store.js';
import type { RecordedEvent } from '../src/types.js';

// a folder name with a space and an apostrophe: the list of files handed to ffmpeg has to quote it
const dir = join(mkdtempSync(join(tmpdir(), 'nvr-export-')), "archive of the owner's cameras");
mkdirSync(dir);
const FFMPEG = process.env.CAMERAUI_FFMPEG_PATH ?? 'ffmpeg';
const noop = () => undefined;
const S = 1_000_000;

const row = (path: string, startSec: number, endSec: number, bytes = 1000): SegmentRow => ({
  id: 0,
  camera_id: 'cam1',
  role: 'high',
  start_us: Math.round(startSec * S),
  end_us: Math.round(endSec * S),
  path,
  bytes,
  codec: 'h264',
  codec_string: 'avc1.640015',
  width: 320,
  height: 240,
  video_pid: 256,
  audio_pid: -1,
  keyframes: '[]',
});

// ------------------------------------------------------------------ where the range lies in the clip

{
  const plan = (segments: [number, number][], startSec: number, endSec: number) => {
    const { runs, offsetSec, durationSec } = clipPlan(
      segments.map(([from, to]) => row('x.ts', from, to)),
      startSec * S,
      endSec * S,
    );
    return { runs: runs.map((run) => run.length), offsetSec, durationSec };
  };
  // 10:00:00–10:00:30 and 10:05:00–10:05:30, asked for 10:00:10–10:05:10: twenty seconds of the first, ten of the second
  assert.deepEqual(plan([[0, 30], [300, 330]], 10, 310), { runs: [1, 1], offsetSec: 10, durationSec: 30 });
  // files written back to back are one stretch: its length is the span, as the index never agrees to the millisecond
  assert.deepEqual(plan([[0, 60.02], [60, 119.98], [120, 180]], 30, 150), { runs: [3], offsetSec: 30, durationSec: 120 });
  assert.deepEqual(plan([[0, 60], [62, 120]], 0, 120), { runs: [2], offsetSec: 0, durationSec: 120 }, 'two seconds apart is still one stretch');
  assert.deepEqual(plan([[0, 60], [62.5, 120]], 0, 120), { runs: [1, 1], offsetSec: 0, durationSec: 117.5 }, 'a longer pause is left out');
  // the range reaches past the recordings on both sides: what is recorded, no more
  assert.deepEqual(plan([[100, 130]], 0, 1000), { runs: [1], offsetSec: 0, durationSec: 30 });
  assert.deepEqual(plan([[0, 30], [300, 330], [600, 630]], 20, 610), { runs: [1, 1, 1], offsetSec: 20, durationSec: 50 });
  // the range ends in the pause: nothing of the next stretch
  assert.deepEqual(plan([[0, 30], [300, 330]], 10, 100), { runs: [1, 1], offsetSec: 10, durationSec: 20 });
}

// ------------------------------------------------------------------ the clip ffmpeg makes

/** A picture that tells its time: black at the start, 8 steps of brightness more every second. */
const RAMP = "color=c=black:s=320x240:r=10,geq=lum='clip(T*8,0,255)':cb=128:cr=128";

function recording(name: string, seconds: number, opts: { ptsOffsetSec?: number; segmentSec?: number; ramp?: boolean } = {}): string {
  const path = join(dir, name);
  const made = spawnSync(
    FFMPEG,
    [
      ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', opts.ramp ? RAMP : 'testsrc=size=320x240:rate=10', '-t', String(seconds)],
      ['-c:v', 'libx264', '-g', '10', '-bf', '0'],
      opts.ptsOffsetSec ? ['-output_ts_offset', String(opts.ptsOffsetSec)] : [],
      opts.segmentSec ? ['-f', 'segment', '-segment_time', String(opts.segmentSec), '-segment_format', 'mpegts'] : ['-f', 'mpegts'],
      [path],
    ].flat(),
    { encoding: 'utf8' },
  );
  assert.equal(made.status, 0, `ffmpeg could not make a recording: ${made.stderr}`);
  return path;
}

/** How long an MP4 really plays, from its movie header. */
function playsFor(path: string): number {
  const file = readFileSync(path);
  const at = file.indexOf('mvhd');
  assert.ok(at > 0, 'an MP4 with a movie header');
  const v1 = file[at + 4] === 1;
  const timescale = file.readUInt32BE(at + (v1 ? 24 : 16));
  const duration = v1 ? Number(file.readBigUInt64BE(at + 28)) : file.readUInt32BE(at + 20);
  return duration / timescale;
}

/** How many pictures an MP4 holds (its only track is the video): a held picture adds time but no frame. */
function framesOf(path: string): number {
  const file = readFileSync(path);
  const at = file.indexOf('stsz');
  assert.ok(at > 0, 'an MP4 with a sample table');
  return file.readUInt32BE(at + 12);
}

const first = recording('a.ts', 30);
// the same connection five minutes later (timestamps go on), a new connection (timestamps start over), a short pause
const later = recording('b-later.ts', 30, { ptsOffsetSec: 300 });
const reconnected = recording('b-reconnected.ts', 30);
const soon = recording('b-soon.ts', 30, { ptsOffsetSec: 35 });
const cut = async (name: string, segments: SegmentRow[], startSec: number, endSec: number) => {
  const clip = await exportClip({ ffmpegPath: FFMPEG, segments, startUs: startSec * S, endUs: endSec * S, outDir: join(dir, 'clips'), filename: name });
  return { said: clip.durationMs / 1000, real: playsFor(clip.path), frames: framesOf(clip.path) };
};
const near = (actual: number, expected: number, what: string) => assert.ok(Math.abs(actual - expected) <= 0.3, `${what}: ${actual} s, expected ${expected} s`);

for (const [name, second] of [
  ['later', later],
  ['reconnected', reconnected],
] as const) {
  const clip = await cut(`${name}.mp4`, [row(first, 0, 30), row(second, 300, 330)], 10, 310);
  near(clip.real, 30, `${name}: the clip ends at the end of the range, twenty seconds of the first file and ten of the second`);
  near(clip.said, clip.real, `${name}: the duration it reports is the one it has`);
  near(clip.frames / 10, 30, `${name}: all of it is video, ten frames a second`);
}
{
  // a pause of five seconds: left out like a long one, the clip is the recorded time
  const clip = await cut('soon.mp4', [row(first, 0, 30), row(soon, 35, 65)], 10, 45);
  near(clip.real, 30, 'short pause');
  near(clip.said, clip.real, 'short pause, reported');
  near(clip.frames / 10, 30, 'short pause: the ten seconds of the second file are there, not a held picture in their place');
}
{
  // files of one continuous recording: still one clip of exactly the range, joined without a seam
  recording('part-%d.ts', 30, { segmentSec: 10 });
  const parts = [0, 1, 2].map((i) => row(join(dir, `part-${i}.ts`), i * 10, (i + 1) * 10));
  const clip = await cut('continuous.mp4', parts, 5, 25);
  near(clip.real, 20, 'continuous');
  near(clip.said, 20, 'continuous, reported');
  near(clip.frames / 10, 20, 'continuous: no frame lost or doubled where the files join');
  const whole = await cut('whole.mp4', parts, 0, 30);
  near(whole.real, 30, 'the whole of three files');
  assert.deepEqual(readdirSync(join(dir, 'clips')).sort(), ['continuous.mp4', 'later.mp4', 'reconnected.mp4', 'soon.mp4', 'whole.mp4'], 'only the clips are left in the output folder');
}
{
  // one stretch in which the timestamps of the camera start over (its clock was reset, the recording went on):
  // ffmpeg mends that when it reads the stretch directly, so a single stretch is not handed over as a list
  const clip = await cut('restart.mp4', [row(first, 0, 30), row(reconnected, 30, 60)], 10, 50);
  near(clip.real, 40, 'timestamps starting over inside one stretch');
  near(clip.frames / 10, 40, 'timestamps starting over inside one stretch, frames');
}
await assert.rejects(exportClip({ ffmpegPath: FFMPEG, segments: [row(first, 0, 30)], startUs: 100 * S, endUs: 200 * S, outDir: join(dir, 'clips'), filename: 'none.mp4' }), /No recordings/);

// ------------------------------------------------------------------ a timelapse of a part of the recordings

{
  const ramp = recording('ramp.ts', 30, { ramp: true });
  /** The second of the recording each picture of an MP4 was taken at, read from its brightness. */
  const shows = (path: string): number[] => {
    const raw = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', path, '-vf', 'scale=2:2', '-pix_fmt', 'yuv420p', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
    assert.equal(raw.status, 0, `the timelapse has no picture ffmpeg can decode: ${raw.stderr.toString()}`);
    // a 2x2 picture is four bytes of brightness and two of colour
    return Array.from({ length: raw.stdout.length / 6 }, (_, i) => raw.stdout[i * 6] / 8);
  };
  const lapse = async (name: string, segments: SegmentRow[], startSec: number, endSec: number, intervalSec: number) => {
    const clip = await exportClip({
      ffmpegPath: FFMPEG,
      segments,
      startUs: startSec * S,
      endUs: endSec * S,
      outDir: join(dir, 'lapses'),
      filename: name,
      timelapseIntervalSec: intervalSec,
    });
    return { said: clip.durationMs / 1000, real: playsFor(clip.path), shows: shows(clip.path) };
  };
  const rising = (seconds: number[]) => seconds.every((s, i) => i === 0 || s > seconds[i - 1]);
  const within = (actual: number, from: number, to: number, what: string) => assert.ok(actual >= from && actual <= to, `${what}: ${actual}, expected ${from}…${to}`);

  // ten seconds into a file, a picture a second: fifteen pictures, of the seconds 10…25, half a second of video
  const part = await lapse('part.mp4', [row(ramp, 0, 30)], 10, 25, 1);
  assert.equal(part.shows.length, 15, `a range starting inside a file has its pictures: ${JSON.stringify(part.shows)}`);
  within(part.shows[0], 9.5, 11, 'the first picture is the start of the range');
  within(part.shows.at(-1)!, 23.5, 25, 'the last picture is the end of the range');
  assert.ok(rising(part.shows), `every picture is a later one, none is held: ${JSON.stringify(part.shows)}`);
  within(part.real, 0.49, 0.51, 'fifteen pictures at 30 a second');
  within(part.said, part.real - 0.01, part.real + 0.01, 'the duration it reports is the one it plays for, not the length of the range');

  // from the start of the file the range still ends where it was asked to
  const head = await lapse('head.mp4', [row(ramp, 0, 30)], 0, 15, 1);
  assert.equal(head.shows.length, 15, `the first half of the file, not all of it: ${JSON.stringify(head.shows)}`);
  within(head.shows[0], 0, 1, 'from the start');
  within(head.shows.at(-1)!, 13.5, 15, 'to the middle');
  assert.ok(rising(head.shows));

  // over a pause: the last ten seconds of one recording, the first ten of the next (the same file, black again)
  const pause = await lapse('pause.mp4', [row(ramp, 0, 30), row(ramp, 300, 330)], 20, 310, 2);
  assert.equal(pause.shows.length, 10, `ten seconds of each side of the pause, a picture every two: ${JSON.stringify(pause.shows)}`);
  assert.ok(rising(pause.shows.slice(0, 5)) && rising(pause.shows.slice(5)));
  within(pause.shows[0], 19.5, 22, 'starts in the first recording');
  within(pause.shows[4], 27, 30, 'to its end');
  within(pause.shows[5], 0, 2, 'goes on with the start of the second');
  within(pause.shows[9], 7, 10, 'and ends ten seconds into it');
  within(pause.said, pause.real - 0.01, pause.real + 0.01, 'over a pause, reported');

  // a range shorter than the interval is one picture of it, not an empty file
  const short = await lapse('short.mp4', [row(ramp, 0, 30)], 10, 13, 10);
  assert.equal(short.shows.length, 1);
  within(short.shows[0], 10, 13, 'the picture of a range shorter than the interval');
  assert.ok(short.said > 0 && short.said < 0.1, 'one picture is a thirtieth of a second');

  // the index says the file is a minute long and it holds half of that: no picture in 40…50 s, said instead of an empty file
  await assert.rejects(lapse('none.mp4', [row(ramp, 0, 60)], 40, 50, 1), /No video in the selected range/);
  assert.deepEqual(readdirSync(join(dir, 'lapses')).sort(), ['head.mp4', 'part.mp4', 'pause.mp4', 'short.mp4'], 'the empty file does not stay');
}

// ------------------------------------------------------------------ what a ZIP can hold

// files that are as large as the spec says without being written
const pretend = new Map<string, number>();
const stat = fsp.stat.bind(fsp);
fsp.stat = (async (path: string, ...rest: unknown[]) => {
  const real = await (stat as (...args: unknown[]) => Promise<{ size: number }>)(path, ...rest);
  return pretend.has(path) ? Object.assign(real, { size: pretend.get(path) }) : real;
}) as unknown as typeof fsp.stat;
syncBuiltinESMExports();
const GB = 1024 ** 3;

{
  const one = join(dir, 'one.bin');
  const two = join(dir, 'two.bin');
  writeFileSync(one, 'first file');
  writeFileSync(two, 'second');
  const target = join(dir, 'small.zip');
  const size = await writeZip(target, [
    { path: one, name: 'one.bin' },
    { path: two, name: 'two.bin' },
  ]);
  assert.equal(size, statSync(target).size);
  assert.equal(readFileSync(target).readUInt16LE(size - 22 + 10), 2, 'two entries in the archive');

  // 2 + 2.5 GiB: the offsets of a ZIP end at 4 GiB
  pretend.set(one, 2 * GB);
  pretend.set(two, 2.5 * GB);
  const big = join(dir, 'big.zip');
  await assert.rejects(
    writeZip(big, [
      { path: one, name: 'one.bin' },
      { path: two, name: 'two.bin' },
    ]),
    /too large for a ZIP archive: 4\.8 GB, a ZIP holds up to 4\.3 GB/,
    'said with the sizes',
  );
  assert.equal(existsSync(big), false, 'refused before a byte of the archive is written');
  // under the limit it is written (the files of the spec are small, whatever their pretended size)
  pretend.set(two, 1.9 * GB);
  await writeZip(big, [
    { path: one, name: 'one.bin' },
    { path: two, name: 'two.bin' },
  ]);
  assert.equal(existsSync(big), true);
  pretend.clear();
  await assert.rejects(writeZip(join(dir, 'many.zip'), Array.from({ length: 65_535 }, (_, i) => ({ path: one, name: `${i}.bin` }))), /65535 files/);
  assert.equal(existsSync(join(dir, 'many.zip')), false);
}

// ------------------------------------------------------------------ exports of the plugin

{
  const downloads: { filePath: string; filename: string }[] = [];
  const host = { refuses: false };
  const api = {
    storagePath: join(dir, 'plugin'),
    on: noop,
    once: noop,
    emit: noop,
    notificationManager: { publish: async () => undefined },
    downloadManager: {
      createDownload: async (opts: { filePath: string; filename: string }) => {
        if (host.refuses) throw new Error('download refused');
        downloads.push(opts);
        return { url: `/download/${opts.filename}` };
      },
    },
    coreManager: { assistantAccess: async () => ({ allowed: false }), getFFmpegPath: () => new Promise<string>(noop), getPluginsByInterface: async () => [] },
  };
  mkdirSync(api.storagePath);
  const storage = { values: {} as Record<string, unknown>, getValue: async () => undefined, setValue: async () => undefined };
  const nvr = new VionNvr({ log: noop, warn: (...a: unknown[]) => console.warn('[warn]', ...a), error: console.error, debug: noop, attention: noop, trace: noop } as never, api as never, storage as never);
  const internals = nvr as unknown as {
    cameras: Map<string, unknown>;
    store: { addSegment(row: Omit<SegmentRow, 'id'>): number };
    removeEmptyExportDirs(): Promise<void>;
  };
  for (const id of ['gate', 'door', 'yard', 'huge-1', 'huge-2', 'huge-3']) internals.cameras.set(id, { device: { id, name: id }, recorders: new Map(), subscriptions: [] });
  const exportsDir = join(api.storagePath, 'exports');
  const leftovers = () => (existsSync(exportsDir) ? readdirSync(exportsDir) : []);
  const add = (camera: string, path: string, startSec: number, endSec: number, bytes = 1000) => internals.store.addSegment({ ...row(path, startSec, endSec, bytes), camera_id: camera });

  // a single clip. The file of the yard broke off before its first picture (a power cut): ffmpeg opens the MP4 and
  // fails on its header, which left an empty file that no download ever cleaned up
  const broken = join(dir, 'broken.ts');
  writeFileSync(broken, readFileSync(first).subarray(0, 1000));
  add('yard', broken, 0, 30);
  await assert.rejects(nvr.nvrExport('yard', 0, 30 * S), /ffmpeg/);
  assert.deepEqual(leftovers(), [], 'the file ffmpeg had opened before it failed does not stay');
  // the clip is cut and the host cannot offer it: nobody would remove it later
  add('yard', first, 100, 130);
  host.refuses = true;
  await assert.rejects(nvr.nvrExport('yard', 100 * S, 130 * S), /download refused/);
  host.refuses = false;
  assert.deepEqual(leftovers(), [], 'a clip without a download does not stay');
  // a working one arrives, and a timelapse says how long it plays (fifteen pictures of 10…25 s)
  const single = await nvr.nvrExport('yard', 100 * S, 130 * S);
  assert.equal(single.durationMs, 30_000);
  assert.equal(statSync(downloads.at(-1)!.filePath).size, single.size);
  const lapse = await nvr.nvrExport('yard', 110 * S, 125 * S, { timelapseIntervalSec: 1 });
  assert.equal(lapse.durationMs, 500, 'the duration of the timelapse, not of the range');
  for (const made of downloads.splice(0)) unlinkSync(made.filePath);
  assert.deepEqual(leftovers(), []);

  // a day with two recordings of the gate; the file of the second one is gone
  add('gate', first, 0, 30);
  add('gate', join(dir, 'missing.ts'), 1000, 1030);
  const slices = [
    { day: 'one', startUs: 0, endUs: 30 * S },
    { day: 'two', startUs: 1000 * S, endUs: 1030 * S },
  ];
  await assert.rejects(nvr.nvrExportBatch({ cameras: ['gate'], slices }), /ffmpeg/);
  assert.deepEqual(leftovers(), [], 'the clip cut before the failure does not stay on the archive disk');

  // a working export still arrives: one file as an MP4, two as a ZIP with the MP4s removed
  add('door', first, 0, 30);
  add('door', reconnected, 1000, 1030);
  assert.match((await nvr.nvrExportBatch({ cameras: ['door'], slices: slices.slice(0, 1) })).filename, /\.mp4$/);
  const zipped = await nvr.nvrExportBatch({ cameras: ['door'], slices });
  assert.match(zipped.filename, /^vion-export_.*\.zip$/);
  const zipDir = join(downloads.at(-1)!.filePath, '..');
  assert.deepEqual(readdirSync(zipDir), [zipped.filename]);

  // the download of the ZIP expires: the host removes the file, the folder made for it goes at the next cleanup;
  // the folder of the MP4 exported before it still has its download and stays
  assert.equal(leftovers().length, 2);
  await internals.removeEmptyExportDirs();
  assert.equal(leftovers().length, 2, 'a folder with a download in it is left alone');
  unlinkSync(downloads.at(-1)!.filePath);
  await internals.removeEmptyExportDirs();
  assert.equal(existsSync(zipDir), false, 'the empty folder of an expired download is removed');
  assert.equal(leftovers().length, 1);
  // an export being made has an empty folder until ffmpeg opens its first file: a cleanup at that moment leaves it
  const realSpawn = childProcess.spawn;
  const cleanups: Promise<void>[] = [];
  childProcess.spawn = ((...args: Parameters<typeof realSpawn>) => {
    cleanups.push(internals.removeEmptyExportDirs());
    return realSpawn(...args);
  }) as typeof realSpawn;
  syncBuiltinESMExports();
  const during = await nvr.nvrExportBatch({ cameras: ['door'], slices });
  childProcess.spawn = realSpawn;
  syncBuiltinESMExports();
  await Promise.all(cleanups);
  assert.equal(cleanups.length, 2, 'a cleanup ran as each of the two clips was started');
  assert.match(during.filename, /\.zip$/, 'the export went through');
  const kept = leftovers().length;

  // two cameras with 3 GiB each in the range: more than a ZIP holds, refused before any file is cut
  add('huge-1', join(dir, 'huge-1.ts'), 0, 30, 3 * GB);
  add('huge-2', join(dir, 'huge-2.ts'), 0, 30, 3 * GB);
  const hugeRequest = { cameras: ['huge-1', 'huge-2'], slices: slices.slice(0, 1) };
  await assert.rejects(nvr.nvrExportBatch(hugeRequest), /too large for a ZIP archive: 6\.4 GB/, 'the reason, not an ffmpeg error after the work');
  assert.equal(leftovers().length, kept, 'nothing was started');
  // the size the dialog shows comes from the estimate, which goes on answering and says the refusal beforehand
  const hugeEstimate = await nvr.nvrExportEstimate(hugeRequest);
  assert.equal(hugeEstimate.totalBytes, 6 * GB);
  assert.equal(hugeEstimate.files.length, 2);
  assert.deepEqual(hugeEstimate.tooLarge, { bytes: 6 * GB, limitBytes: 0xffff_ffff }, 'the estimate says that the export would be refused, with the size and the limit');
  // a timelapse of the same range is small: not refused, by the estimate either
  const lapsed = await nvr.nvrExportEstimate({ ...hugeRequest, timelapse: true });
  assert.deepEqual(lapsed, { files: hugeEstimate.files, totalBytes: 6 * GB, durationMs: hugeEstimate.durationMs }, 'nothing else in the answer depends on it');
  // an export that fits has no such field at all
  assert.deepEqual(Object.keys(await nvr.nvrExportEstimate({ cameras: ['door'], slices })).sort(), ['durationMs', 'files', 'totalBytes']);
  assert.deepEqual(Object.keys(await nvr.nvrExportEstimate({ cameras: ['nobody'], slices })).sort(), ['durationMs', 'files', 'totalBytes'], 'an empty one neither');
  // the limit itself is too much, a byte less is not; the estimate and the export agree on both sides of it
  for (const id of ['edge-1', 'edge-2', 'edge-3']) internals.cameras.set(id, { device: { id, name: id }, recorders: new Map(), subscriptions: [] });
  add('edge-1', join(dir, 'edge-1.ts'), 0, 30, 0x8000_0000);
  add('edge-2', join(dir, 'edge-2.ts'), 0, 30, 0x7fff_ffff);
  add('edge-3', join(dir, 'edge-3.ts'), 0, 30, 0x7fff_fffe);
  const atLimit = { cameras: ['edge-1', 'edge-2'], slices: slices.slice(0, 1) };
  const underLimit = { cameras: ['edge-1', 'edge-3'], slices: slices.slice(0, 1) };
  assert.deepEqual((await nvr.nvrExportEstimate(atLimit)).tooLarge, { bytes: 0xffff_ffff, limitBytes: 0xffff_ffff });
  await assert.rejects(nvr.nvrExportBatch(atLimit), /too large for a ZIP archive/);
  assert.equal((await nvr.nvrExportEstimate(underLimit)).tooLarge, undefined);
  await assert.rejects(nvr.nvrExportBatch(underLimit), /ffmpeg/, 'not refused for its size (its files are not there to be cut)');
  await assert.rejects(nvr.nvrExportBatch({ ...hugeRequest, timelapseIntervalSec: 10 }), /ffmpeg/, 'a timelapse is not judged by the size of the recordings');
  assert.equal(leftovers().length, kept);
  // one camera alone is one MP4, which has no such limit however large: it is tried (and fails here on the missing file)
  add('huge-3', join(dir, 'huge-3.ts'), 0, 30, 5 * GB);
  assert.equal((await nvr.nvrExportEstimate({ cameras: ['huge-3'], slices: slices.slice(0, 1) })).tooLarge, undefined, 'one file is not a ZIP');
  await assert.rejects(nvr.nvrExportBatch({ cameras: ['huge-3'], slices: slices.slice(0, 1) }), /ffmpeg/, 'a single MP4 is not held to the limit of a ZIP');
  assert.equal(leftovers().length, kept);

  // an episode whose second camera cannot be cut leaves nothing either
  const at = Date.now();
  const visit = (id: string, cameraId: string, startTime: number) =>
    ({
      id,
      cameraId,
      state: 'ended',
      startTime,
      endTime: startTime + 5000,
      lastUpdate: startTime + 5000,
      types: ['person'],
      triggers: [],
      segmentIndex: 0,
      segments: [{ firstSeen: startTime, lastSeen: startTime + 5000, detections: [{ label: 'person', score: 0.9 }], attributes: [] }],
    }) as unknown as RecordedEvent;
  await nvr.ingestDetectionEvent('gate', 'end' as never, visit('v-gate', 'gate', at));
  await nvr.ingestDetectionEvent('door', 'end' as never, visit('v-door', 'door', at + 10_000));
  const [episode] = (await nvr.getEpisodes({ limit: 10 })).episodes;
  assert.ok(episode, 'the visit is an episode');
  internals.store.addSegment({ ...row(first, 0, 30), camera_id: 'gate', start_us: (at - 10_000) * 1000, end_us: (at + 20_000) * 1000 });
  internals.store.addSegment({ ...row(join(dir, 'missing-too.ts'), 0, 30), camera_id: 'door', start_us: at * 1000, end_us: (at + 30_000) * 1000 });
  await assert.rejects(nvr.nvrExportEpisode(episode.id), /ffmpeg/);
  assert.equal(leftovers().length, kept, 'the first clip of the episode does not stay');
}

console.log(
  'export.spec: clip over a pause (range end, real duration), seamless join, timelapse of a range, ZIP limit before writing, failed exports leave nothing, empty export folders removed — ok',
);
process.exit(0);
