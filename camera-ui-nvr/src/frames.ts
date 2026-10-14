// Pictures read out of the recording by ffmpeg for gone.ts and place.ts: a whole frame at a time (JPEG, for the text
// finder and the pictures shown), the small gray patch of a region, of one picture or of every half second of a
// stretch (compared with how the region looked), and a look at one keyframe (the patch and the whole picture small).
// A file of the recording is MPEG-TS from its keyframe on; a time in it is its offset from the file's start, as the
// export cuts a clip (export.ts clipPlan).

import { spawn } from 'node:child_process';

import { PATCH } from './gone.js';
import { OVERVIEW_H, OVERVIEW_W } from './place.js';

import type { Place } from './gone.js';
import type { SegmentRow } from './store.js';

/** A whole frame is made at most this wide: the finder works on 768 px, a small thing needs some of them. */
const FRAME_MAX_WIDTH = 1280;

/** Runs ffmpeg and gives what it wrote; `input` is written to it first. */
function capture(bin: string, args: string[], input?: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => out.push(d));
    proc.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg exited with ${code}: ${stderr.trim().split('\n').pop() ?? ''}`))));
    if (input && proc.stdin) {
      // a picture the ffmpeg did not need to read whole (it stopped at its first frame) breaks the pipe: not a failure
      proc.stdin.on('error', () => undefined);
      proc.stdin.end(Buffer.from(input));
    }
  });
}

/** The crop of a region as ffmpeg's filter: shares of the picture, whole even pixels. */
function cropOf(region: Place): string {
  const share = (v: number) => Math.max(0, Math.min(1, v)).toFixed(4);
  return `crop=trunc(iw*${share(region.width)}/2)*2:trunc(ih*${share(region.height)}/2)*2:trunc(iw*${share(region.x)}):trunc(ih*${share(region.y)})`;
}

const PATCH_FILTER = (region: Place) => `${cropOf(region)},scale=${PATCH}:${PATCH}:flags=area,format=gray`;

/** The privacy zones of the camera (privacy.ts) first, before anything of the picture is cut or made smaller. */
const masked = (mask: string | undefined, filter: string) => (mask ? `${mask},${filter}` : filter);

/** The last half second of a file is not asked for: its last frames may be cut, ffmpeg then writes nothing. */
const FILE_END_US = 500_000;

/**
 * The whole picture of a file of the recording at a time in it (µs), as JPEG; undefined when there is none. `mask`:
 * the camera's privacy zones as ffmpeg's filter (privacyFilter), black in the picture.
 */
export async function frameAt(
  ffmpegPath: string,
  segment: Pick<SegmentRow, 'path' | 'start_us' | 'end_us'>,
  atUs: number,
  mask?: string,
): Promise<Uint8Array | undefined> {
  const offset = Math.max(0, (Math.min(atUs, segment.end_us - FILE_END_US) - segment.start_us) / 1e6);
  const jpeg = await capture(ffmpegPath, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    offset.toFixed(3),
    '-i',
    segment.path,
    '-frames:v',
    '1',
    '-vf',
    masked(mask, `scale='min(${FRAME_MAX_WIDTH},iw)':-2`),
    '-f',
    'image2pipe',
    '-c:v',
    'mjpeg',
    '-q:v',
    '3',
    'pipe:1',
  ]).catch((error: Error) => {
    // a time past the frames of the file (it ends early): no picture there, not a failure of the search
    if (/Nothing was written|no packets|Output file is empty/i.test(error.message)) return Buffer.alloc(0);
    throw error;
  });
  return jpeg.length ? new Uint8Array(jpeg) : undefined;
}

/** A region of a picture (JPEG) as a JPEG of its own, at most `maxWidth` wide. */
export async function cropOfPicture(ffmpegPath: string, picture: Uint8Array, region: Place, maxWidth = 640): Promise<Uint8Array | undefined> {
  const jpeg = await capture(
    ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'image2pipe',
      '-i',
      'pipe:0',
      '-frames:v',
      '1',
      '-vf',
      `${cropOf(region)},scale='min(${maxWidth},iw)':-2`,
      '-f',
      'image2pipe',
      '-c:v',
      'mjpeg',
      '-q:v',
      '3',
      'pipe:1',
    ],
    picture,
  );
  return jpeg.length ? new Uint8Array(jpeg) : undefined;
}

/** The gray patch of a region of a picture (JPEG). */
export async function patchOfPicture(ffmpegPath: string, picture: Uint8Array, region: Place): Promise<Uint8Array | undefined> {
  const raw = await capture(
    ffmpegPath,
    ['-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-i', 'pipe:0', '-frames:v', '1', '-vf', PATCH_FILTER(region), '-f', 'rawvideo', 'pipe:1'],
    picture,
  );
  return raw.length >= PATCH * PATCH ? new Uint8Array(raw.subarray(0, PATCH * PATCH)) : undefined;
}

/** Seeking a keyframe a little past its time: ffmpeg's fast seek lands on the keyframe at or before (a frame is 40 ms+). */
const KEYFRAME_PAST_S = 0.02;

/**
 * A look at one keyframe of a file of the recording (place.ts): the gray patch of a region, the whole picture small
 * and how coloured it is. Only the keyframe is decoded (0.15-0.2 s on the bench against 0.2-0.45 s for an exact time,
 * measured 2026-10-14): one ffmpeg makes both pictures, stacked in one frame of planar YUV 4:4:4, whose chroma tells a
 * night picture (gray, chroma at 128) from a day one.
 */
export async function lookOf(
  ffmpegPath: string,
  segment: Pick<SegmentRow, 'path' | 'start_us' | 'end_us'>,
  keyframeUs: number,
  region: Place,
  mask?: string,
): Promise<{ patch: Uint8Array; overview: Uint8Array; colour: number } | undefined> {
  const width = Math.max(PATCH, OVERVIEW_W);
  const height = PATCH + OVERVIEW_H;
  const raw = await capture(ffmpegPath, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-noaccurate_seek',
    '-skip_frame',
    'nokey',
    '-ss',
    ((keyframeUs - segment.start_us) / 1e6 + KEYFRAME_PAST_S).toFixed(3),
    '-i',
    segment.path,
    '-frames:v',
    '1',
    '-filter_complex',
    [
      `[0:v]${masked(mask, 'split=2')}[a][b];[a]${cropOf(region)},scale=${PATCH}:${PATCH}:flags=area,format=yuv444p,pad=${width}:${PATCH}:0:0[p]`,
      `[b]scale=${OVERVIEW_W}:${OVERVIEW_H}:flags=area,format=yuv444p,pad=${width}:${OVERVIEW_H}:0:0[o]`,
      '[p][o]vstack=inputs=2[out]',
    ].join(';'),
    '-map',
    '[out]',
    '-f',
    'rawvideo',
    'pipe:1',
  ]).catch((error: Error) => {
    // a keyframe past the frames of the file (it ends early): no look there, not a failure of the search
    if (/Nothing was written|no packets|Output file is empty/i.test(error.message)) return Buffer.alloc(0);
    throw error;
  });
  const plane = width * height;
  if (raw.length < 3 * plane) return undefined;
  const patch = new Uint8Array(PATCH * PATCH);
  for (let y = 0; y < PATCH; y++) patch.set(raw.subarray(y * width, y * width + PATCH), y * PATCH);
  const overview = new Uint8Array(OVERVIEW_W * OVERVIEW_H);
  let chroma = 0;
  for (let y = 0; y < OVERVIEW_H; y++) {
    const row = (PATCH + y) * width;
    overview.set(raw.subarray(row, row + OVERVIEW_W), y * OVERVIEW_W);
    for (let x = 0; x < OVERVIEW_W; x++) chroma += Math.abs(raw[plane + row + x] - 128) + Math.abs(raw[2 * plane + row + x] - 128);
  }
  return { patch, overview, colour: chroma / (OVERVIEW_W * OVERVIEW_H) };
}

/**
 * The gray patches of a region every `stepMs` from one time to another (µs), out of the files of the recording that
 * cover it (in time order), each with its time.
 */
export async function patchesOf(
  ffmpegPath: string,
  segments: Pick<SegmentRow, 'path' | 'start_us' | 'end_us'>[],
  fromUs: number,
  toUs: number,
  region: Place,
  stepMs: number,
  mask?: string,
): Promise<{ atMs: number; pixels: Uint8Array }[]> {
  const out: { atMs: number; pixels: Uint8Array }[] = [];
  const size = PATCH * PATCH;
  for (const segment of segments) {
    const startUs = Math.max(fromUs, segment.start_us);
    const endUs = Math.min(toUs, segment.end_us);
    if (endUs <= startUs) continue;
    const raw = await capture(ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      ((startUs - segment.start_us) / 1e6).toFixed(3),
      '-i',
      segment.path,
      '-t',
      ((endUs - startUs) / 1e6).toFixed(3),
      '-vf',
      masked(mask, `fps=${(1000 / stepMs).toFixed(3)},${PATCH_FILTER(region)}`),
      '-f',
      'rawvideo',
      'pipe:1',
    ]);
    for (let i = 0; (i + 1) * size <= raw.length; i++) {
      const atMs = Math.round(startUs / 1000 + i * stepMs);
      if (out.length && atMs <= out[out.length - 1].atMs) continue;
      out.push({ atMs, pixels: new Uint8Array(raw.subarray(i * size, (i + 1) * size)) });
    }
  }
  return out;
}
