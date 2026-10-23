import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';

import { LIBX264 } from './media/transcode.js';

import type { H264Encoder } from './media/transcode.js';
import type { SegmentRow } from './store.js';

/** Segments at most this far apart are one stretch of recording (the timeline joins them the same way). */
const RUN_GAP_US = 2_000_000;
/** Sizes and offsets in a ZIP written here are 32-bit and the entry count 16-bit (no ZIP64). */
export const ZIP_MAX_BYTES = 0xffff_ffff;
const ZIP_MAX_FILES = 0xffff;

/**
 * Where [startUs, endUs] lies in the clip made of `segments` (in time order). The clip holds recorded video only:
 * stretches of recording follow each other without the pauses between them, so its length is the recorded time
 * inside the range, not the span of the range, and the cut that ends it is counted the same way.
 */
/**
 * The timelapse interval of an export: a whole number of seconds, 1 to 3600, as the REST schema takes it; none for a
 * plain clip. The export over the bus took the number as it came, and a fraction (1e-6) made `setpts` and `fps`
 * write billions of frames onto the archive disk, by libx264, with no timeout (ViON audit 2026-10-23).
 */
export function timelapseOf(intervalSec: number | undefined): number {
  if (intervalSec === undefined || intervalSec === 0) return 0;
  if (!Number.isInteger(intervalSec) || intervalSec < 1 || intervalSec > 3600) {
    throw new Error('The timelapse interval must be a whole number of seconds from 1 to 3600');
  }
  return intervalSec;
}

/**
 * How many exports run at once and how many wait: ffmpeg on an hour of video is a core and a file on the archive disk,
 * and the bus had no limit on them (the REST jobs have two per user). The rest are refused at once, so the player says
 * so instead of queueing for an hour.
 */
export class ExportGate {
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly maxRunning: number,
    private readonly maxWaiting: number,
  ) {}

  public async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.running >= this.maxRunning) {
      if (this.waiting.length >= this.maxWaiting) throw new Error('Too many exports are running: try again in a minute');
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.running++;
    try {
      return await job();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }
}

export const exportGate = new ExportGate(2, 6);

export function clipPlan(segments: SegmentRow[], startUs: number, endUs: number): { runs: SegmentRow[][]; offsetSec: number; durationSec: number } {
  const runs: SegmentRow[][] = [];
  const ends: number[] = [];
  for (const segment of segments) {
    // a codec change starts a stretch too: its files joined byte by byte put the H.265 half into the H.264 track
    if (!runs.length || segment.start_us - ends[ends.length - 1] > RUN_GAP_US || segment.codec !== runs[runs.length - 1][0].codec) {
      runs.push([segment]);
      ends.push(segment.end_us);
    } else {
      runs[runs.length - 1].push(segment);
      ends[ends.length - 1] = Math.max(ends[ends.length - 1], segment.end_us);
    }
  }
  let recordedUs = 0;
  runs.forEach((run, i) => (recordedUs += Math.max(0, Math.min(endUs, ends[i]) - Math.max(startUs, run[0].start_us))));
  return { runs, offsetSec: Math.max(0, (startUs - segments[0].start_us) / 1e6), durationSec: Math.max(0.1, recordedUs / 1e6) };
}

/**
 * The input list of ffmpeg's concat demuxer, one entry per stretch of recording. Inside a stretch the files are
 * joined byte by byte (`concat:`), which is the stream as it was received. Between stretches the demuxer starts
 * the next one where the previous ended, whatever the pause or the timestamps of a new connection: `concat:` alone
 * drops a pause only when it is longer than 10 s, so where the range ended in the clip could not be known.
 */
function concatList(runs: SegmentRow[][]): string {
  // inside the quotes of a list entry only the quote itself needs care: it is closed, escaped and opened again
  const entries = runs.map((run) => `file '${concatUrl(run).replaceAll("'", "'\\''")}'`);
  return ['ffconcat version 1.0', ...entries, ''].join('\n');
}

function concatUrl(run: SegmentRow[]): string {
  return `concat:${run.map((s) => s.path).join('|')}`;
}

/**
 * Whether the clip of these segments is made H.264: asked for by a client without H.265 and some of it is H.265, or
 * more than one codec in it (a camera set from H.264 to H.265 inside the range), which one MP4 track cannot hold.
 */
export function madeH264(segments: SegmentRow[], asked: boolean): boolean {
  const codecs = new Set(segments.map((s) => s.codec));
  return codecs.size > 1 || (asked && codecs.has('h265'));
}

/**
 * The stretches of a clip of more than one codec, each its own input with its own decoder, joined by the concat
 * filter into one picture of the first file's size (the camera may have changed its size with its codec). Sound only
 * when every stretch has it: a stretch without would leave the filter waiting for its sound.
 */
function joinedInputs(runs: SegmentRow[][], made: H264Encoder): { input: string[]; graph: string; audio: boolean } {
  const { width, height } = runs[0][0];
  const audio = runs.every((run) => run.every((s) => s.audio_pid >= 0));
  const fit = width > 0 && height > 0 ? `scale=${width}:${height},` : '';
  const parts = runs.map((_, i) => `[${i}:v:0]${fit}setsar=1,format=yuv420p[v${i}]`);
  const joined = runs.map((_, i) => `[v${i}]${audio ? `[${i}:a:0]` : ''}`).join('');
  return {
    input: [...made.input, ...runs.flatMap((run) => ['-i', concatUrl(run)])],
    graph: [...parts, `${joined}concat=n=${runs.length}:v=1:a=${audio ? 1 : 0}[joined]${audio ? '[sound]' : ''}`].join(';'),
    audio,
  };
}

export function zipTooLarge(bytes: number): Error {
  const gb = (n: number) => (n / 1e9).toFixed(1);
  return new Error(`Export too large for a ZIP archive: ${gb(bytes)} GB, a ZIP holds up to ${gb(ZIP_MAX_BYTES)} GB. Export a shorter period or fewer cameras at a time.`);
}

/** Cuts [startUs, endUs] out of consecutive TS segments into an MP4 without re-encoding. */
export async function exportClip(opts: {
  ffmpegPath: string;
  segments: SegmentRow[];
  startUs: number;
  endUs: number;
  outDir: string;
  filename: string;
  timelapseIntervalSec?: number;
  /**
   * The video made H.264 by this encoder instead of copied: the export of a browser that played the H.265 recording
   * made H.264 (an H.265 MP4 does not open in the player of Windows without a paid extension)
   */
  h264?: H264Encoder;
}): Promise<{ path: string; size: number; durationMs: number }> {
  // checked before anything is written: a wrong interval refused here, not after a folder was made
  const timelapse = timelapseOf(opts.timelapseIntervalSec);
  const segments = opts.segments.filter((s) => s.end_us > opts.startUs && s.start_us < opts.endUs);
  if (!segments.length) throw new Error('No recordings in the selected range');
  await mkdir(opts.outDir, { recursive: true });
  const out = join(opts.outDir, opts.filename);

  const { runs, offsetSec, durationSec } = clipPlan(segments, opts.startUs, opts.endUs);
  const listDir = await mkdtemp(join(tmpdir(), 'nvr-export-'));
  const list = join(listDir, 'segments.txt');

  // one stretch of recording is read directly, as it always was: ffmpeg then also mends a jump of the timestamps
  // inside it (it does that for MPEG-TS, not for a list). The whitelist lets the list name `concat:` inputs (a list
  // read from a file may open only files by default).
  const input = runs.length === 1 ? ['-i', concatUrl(runs[0])] : ['-protocol_whitelist', 'file,concat', '-f', 'concat', '-safe', '0', '-i', list];
  // more than one codec cannot be copied into one track (madeH264): made H.264, by libx264 when nobody said by what
  const mixed = new Set(segments.map((s) => s.codec)).size > 1;
  const madeBy = !timelapse ? (opts.h264 ?? (mixed ? LIBX264 : undefined)) : undefined;
  const joinedArgs = (made: H264Encoder) => {
    const joined = joinedInputs(runs, timelapse ? LIBX264 : made);
    const args = ['-hide_banner', '-loglevel', 'error', '-y', ...joined.input];
    if (timelapse) {
      const range = `trim=start=${offsetSec.toFixed(3)}:duration=${durationSec.toFixed(3)}`;
      const lapse = `[joined]${range},setpts=(PTS-STARTPTS)/${30 * timelapse},fps=30:eof_action=pass[out]`;
      args.push('-filter_complex', `${joined.graph};${lapse}`, '-map', '[out]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-an');
    } else {
      // the stretches start one after the other from 0, so the range is cut where it is in the plan
      const upload = made.upload.replace(/^,/, '') || 'null';
      args.push('-filter_complex', `${joined.graph};[joined]${upload}[out]`, '-map', '[out]', ...(joined.audio ? ['-map', '[sound]', '-c:a', 'aac'] : ['-an']));
      args.push('-ss', offsetSec.toFixed(3), '-t', durationSec.toFixed(3), '-fps_mode', 'passthrough', ...made.codec);
    }
    args.push('-movflags', '+faststart', out);
    return args;
  };
  const argsWith = (made: H264Encoder | undefined) => {
    if (mixed) return joinedArgs(made ?? LIBX264);
    const args = ['-hide_banner', '-loglevel', 'error', '-y', ...(made?.input ?? []), ...input];
    if (timelapse) {
      // One frame per interval, played at 30 fps: the time is compressed and `fps` keeps a frame for every thirtieth
      // of a second of what is left. The range is cut by `trim`, in front of that: `-ss`/`-t` of the output count the
      // compressed time, so a range starting 10 s into a file skipped the first 10 s of the timelapse (all of it, for
      // a short one) and no range ended where it was asked to. `eof_action=pass`: a range shorter than the interval
      // still gives its one picture.
      const range = `trim=start=${offsetSec.toFixed(3)}:duration=${durationSec.toFixed(3)}`;
      args.push('-vf', `${range},setpts=(PTS-STARTPTS)/${30 * timelapse},fps=30:eof_action=pass`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-an');
    } else {
      // sound is copied when the segments have it; `?` keeps the clip valid for older recordings without any
      args.push('-ss', offsetSec.toFixed(3), '-t', durationSec.toFixed(3), '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy');
      // made H.264 at the size it was recorded, the frames at their times
      if (made) args.push(...(made.upload ? ['-vf', made.upload.replace(/^,/, '')] : []), '-fps_mode', 'passthrough', ...made.codec);
    }
    args.push('-movflags', '+faststart', out);
    return args;
  };

  try {
    if (runs.length > 1 && !mixed) await writeFile(list, concatList(runs));
    try {
      await exportGate.run(() => run(opts.ffmpegPath, argsWith(madeBy)));
    } catch (error) {
      // a hardware encoder that worked at the start can fail now (NVENC counts its sessions): libx264 makes it. Only a
      // failure before much was written: one later (a full disk, a file the retention removed) would fail again after
      // as long, and what the hardware encoder said is kept with what libx264 says
      const written = await stat(out).then(
        (file) => file.size,
        () => 0,
      );
      if (!madeBy || madeBy.name === LIBX264.name || written > 1024 * 1024) throw error;
      try {
        await exportGate.run(() => run(opts.ffmpegPath, argsWith(LIBX264)));
      } catch (again) {
        throw new Error(`${(again as Error).message} (${madeBy.name} first: ${(error as Error).message})`);
      }
    }
  } catch (error) {
    // what ffmpeg wrote before it failed (an empty file when it could not start the MP4) is not a clip, and nothing
    // removes it later: the download that cleans up an export is only made for a finished one
    await rm(out, { force: true }).catch((e: Error) => ((error as Error).message += ` (the unfinished file stays: ${e.message})`));
    throw error;
  } finally {
    await rm(listDir, { recursive: true, force: true });
  }
  const { size } = await stat(out);
  if (!timelapse) return { path: out, size, durationMs: Math.round(durationSec * 1000) };
  // a timelapse plays as long as its pictures at 30 a second, not as long as the range they are taken from
  const durationMs = await mp4DurationMs(out);
  if (!durationMs) {
    // ffmpeg ends well with an MP4 without a frame when the range has no picture it could decode
    await rm(out, { force: true });
    throw new Error('No video in the selected range for a timelapse');
  }
  return { path: out, size, durationMs };
}

/** How long an MP4 plays, from its movie header; 0 when it has none or the movie is empty. */
async function mp4DurationMs(path: string): Promise<number> {
  const file = await open(path, 'r');
  try {
    const box = Buffer.alloc(48);
    for (let at = 0; ;) {
      const { bytesRead } = await file.read(box, 0, box.length, at);
      if (bytesRead < 8) return 0;
      const large = box.readUInt32BE(0) === 1;
      const header = large ? 16 : 8;
      const size = large ? Number(box.readBigUInt64BE(8)) : box.readUInt32BE(0);
      const type = box.toString('latin1', 4, 8);
      if (type === 'mvhd' && bytesRead === box.length) {
        const v1 = box[header] === 1;
        const timescale = box.readUInt32BE(header + (v1 ? 20 : 12));
        const duration = v1 ? Number(box.readBigUInt64BE(header + 24)) : box.readUInt32BE(header + 16);
        return timescale ? Math.round((duration / timescale) * 1000) : 0;
      }
      // the movie header is the first box inside `moov`; any other box is stepped over (size 0: it runs to the end)
      if (type === 'moov') at += header;
      else if (size < header) return 0;
      else at += size;
    }
  } finally {
    await file.close();
  }
}

const TILE_W = 480;
const TILE_H = 270;

/**
 * One JPEG of up to four pictures: two side by side, three or four in a 2×2 grid (an empty cell stays black).
 * Each picture keeps its proportions inside its cell. A single picture is returned as it is.
 */
export async function mosaic(ffmpegPath: string, pictures: Uint8Array[]): Promise<Uint8Array> {
  const used = pictures.slice(0, 4);
  if (used.length === 0) throw new Error('No pictures for a mosaic');
  if (used.length === 1) return used[0];
  const dir = await mkdtemp(join(tmpdir(), 'nvr-mosaic-'));
  try {
    const inputs: string[] = [];
    for (const [i, picture] of used.entries()) {
      const path = join(dir, `${i}.jpg`);
      await writeFile(path, picture);
      inputs.push('-i', path);
    }
    const fit = `scale=${TILE_W}:${TILE_H}:force_original_aspect_ratio=decrease,pad=${TILE_W}:${TILE_H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
    const cells = used.map((_, i) => `[${i}:v]${fit}[c${i}]`);
    let layout: string;
    if (used.length === 2) {
      layout = '[c0][c1]hstack=inputs=2[out]';
    } else {
      if (used.length === 3) cells.push(`color=c=black:s=${TILE_W}x${TILE_H}:d=1,setsar=1[c3]`);
      layout = '[c0][c1]hstack=inputs=2[top];[c2][c3]hstack=inputs=2[bottom];[top][bottom]vstack=inputs=2[out]';
    }
    const out = join(dir, 'mosaic.jpg');
    await run(ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      ...inputs,
      '-filter_complex',
      [...cells, layout].join(';'),
      '-map',
      '[out]',
      '-frames:v',
      '1',
      '-q:v',
      '4',
      out,
    ]);
    return new Uint8Array(await readFile(out));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}: ${stderr.trim().split('\n').pop() ?? ''}`))));
  });
}

/** Writes an uncompressed (store) ZIP of the given files; MP4 does not compress further. */
export async function writeZip(target: string, files: { path: string; name: string }[]): Promise<number> {
  // checked before the first byte: the 32-bit offsets used to overflow in the central directory, after gigabytes were written
  if (files.length >= ZIP_MAX_FILES) throw new Error(`Export too large for a ZIP archive: ${files.length} files, a ZIP holds up to ${ZIP_MAX_FILES - 1}.`);
  let bytes = 0;
  for (const file of files) bytes += 30 + Buffer.byteLength(file.name, 'utf8') + (await stat(file.path)).size + 16;
  if (bytes >= ZIP_MAX_BYTES) throw zipTooLarge(bytes);

  const out = createWriteStream(target);
  const central: Buffer[] = [];
  let offset = 0;
  const write = (b: Buffer) =>
    new Promise<void>((resolve, reject) => {
      out.write(b, (err) => (err ? reject(err) : resolve()));
      offset += b.length;
    });

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const localOffset = offset;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0808, 6); // data descriptor + UTF-8 names
    header.writeUInt16LE(0, 8); // store
    header.writeUInt32LE(dosTime(), 10);
    header.writeUInt16LE(name.length, 26);
    await write(Buffer.concat([header, name]));

    let crc = 0;
    let size = 0;
    for await (const chunk of createReadStream(file.path)) {
      const b = chunk as Buffer;
      crc = crc32(b, crc);
      size += b.length;
      await write(b);
    }
    if (size >= 0xffffffff) throw new Error('Export too large for a ZIP archive');

    const desc = Buffer.alloc(16);
    desc.writeUInt32LE(0x08074b50, 0);
    desc.writeUInt32LE(crc >>> 0, 4);
    desc.writeUInt32LE(size, 8);
    desc.writeUInt32LE(size, 12);
    await write(desc);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0808, 8);
    entry.writeUInt16LE(0, 10);
    entry.writeUInt32LE(dosTime(), 12);
    entry.writeUInt32LE(crc >>> 0, 16);
    entry.writeUInt32LE(size, 20);
    entry.writeUInt32LE(size, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(localOffset, 42);
    central.push(Buffer.concat([entry, name]));
  }

  const cd = Buffer.concat(central);
  const cdOffset = offset;
  await write(cd);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(cdOffset, 16);
  await write(end);
  await new Promise<void>((resolve) => out.end(resolve));
  return offset;
}

function dosTime(d = new Date()): number {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return ((date << 16) | time) >>> 0;
}
