import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';

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
export function clipPlan(segments: SegmentRow[], startUs: number, endUs: number): { runs: SegmentRow[][]; offsetSec: number; durationSec: number } {
  const runs: SegmentRow[][] = [];
  const ends: number[] = [];
  for (const segment of segments) {
    if (!runs.length || segment.start_us - ends[ends.length - 1] > RUN_GAP_US) {
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
}): Promise<{ path: string; size: number; durationMs: number }> {
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
  const args = ['-hide_banner', '-loglevel', 'error', '-y', ...input];
  const timelapse = opts.timelapseIntervalSec && opts.timelapseIntervalSec > 0 ? opts.timelapseIntervalSec : 0;
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
  }
  args.push('-movflags', '+faststart', out);

  try {
    if (runs.length > 1) await writeFile(list, concatList(runs));
    await run(opts.ffmpegPath, args);
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
