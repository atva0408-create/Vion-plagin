// The recording of an H.265 camera as H.264, made while a client watches it: a browser that cannot decode H.265
// (Firefox; Chrome without the hardware for it) asks for the 'low' stream, and that was an H.264 copy the server made
// and the recorder kept all day — 20.8 GB a day of the bench's Xiaomi beside 5.7 GB of the camera's own H.265, and an
// encoder busy all day for it (2026-10-17). The TS bytes of the recording go through ffmpeg from a keyframe on and come
// out as TS again for the recorder's own demuxer, their times anchored on that keyframe's. A hardware encoder makes it
// when one works on this machine (tried by an encode), else libx264.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { availableParallelism, setPriority } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

import { ptsDelta, readTimestamp, TS_PACKET, TsDemuxer } from './ts-demux.js';

import type { FileHandle } from 'node:fs/promises';
import type { Writable } from 'node:stream';
import type { Frame } from '../reader.js';
import type { Keyframe } from '../store.js';

export interface H264Encoder {
  name: string;
  /** before the input: the device of the encoder */
  input: string[];
  /** the end of the filter chain that hands the frame to the encoder */
  upload: string;
  codec: string[];
}

export const LIBX264: H264Encoder = {
  name: 'libx264',
  input: [],
  upload: '',
  codec: ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p'],
};

/** The width of the copy at most, as the copy the server made: a browser that cannot decode H.265 is often a weak one. */
export const MAX_WIDTH = 1280;
const CHUNK = 256 * 1024;
/**
 * Frames made and not yet taken that stop ffmpeg's output being read: a client that waits (a paused playback) holds
 * ffmpeg back through the pipes, which made the whole file at once into memory otherwise.
 */
const QUEUE_HIGH = 30;
const QUEUE_LOW = 10;

/**
 * How many recordings are made H.264 at once: each is a decode of the camera's picture and an encode on this machine,
 * one for every viewer without H.265 (an episode of N cameras is N). Half the machine's cores, at least two; past that
 * a viewer waits for a place instead of every viewer and the analysis slowing down.
 */
let slots = Math.max(2, Math.floor(availableParallelism() / 2));
let busy = 0;
const waiting: (() => void)[] = [];

export function h264Slots(): number {
  return slots;
}

export function setH264Slots(count: number): void {
  slots = Math.max(1, count);
  waiting.shift()?.();
}

/**
 * How long a reading may wait for its client to take a frame before its ffmpeg ends and its place is freed: a paused
 * playback, or a tab closed or a phone gone without a word, whose reading is never ended (the RPC has no timeout).
 */
let idleMs = 30_000;

export function setH264Idle(ms: number): void {
  idleMs = ms;
}

/** A place to make H.264 in, waited for; false when the client gave up meanwhile, or after `waitMs`. */
async function takeSlot(signal?: AbortSignal, waitMs?: number): Promise<boolean> {
  const until = waitMs === undefined ? undefined : Date.now() + waitMs;
  while (busy >= slots) {
    if (signal?.aborted || (until !== undefined && Date.now() >= until)) return false;
    await new Promise<void>((resolve) => {
      const go = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', go);
        const at = waiting.indexOf(go);
        if (at >= 0) waiting.splice(at, 1);
        resolve();
      };
      const timer = until === undefined ? undefined : setTimeout(go, until - Date.now());
      waiting.push(go);
      signal?.addEventListener('abort', go, { once: true });
    });
  }
  if (signal?.aborted) return false;
  busy++;
  return true;
}

/**
 * A place held across the files of one playback: it went back at every file's end, and the cameras of an episode
 * with more of them than places took turns, each standing until another's file ended. The playback releases it when
 * it ends; a reading whose client stands frees it meanwhile (idle) and takes it again when the client is back.
 */
export class H264Place {
  private held = false;

  public async take(signal?: AbortSignal, waitMs?: number): Promise<boolean> {
    if (this.held) return true;
    if (!(await takeSlot(signal, waitMs))) return false;
    this.held = true;
    return true;
  }

  public release(): void {
    if (!this.held) return;
    this.held = false;
    freeSlot();
  }
}

function freeSlot(): void {
  busy--;
  waiting.shift()?.();
}

function candidates(platform: NodeJS.Platform, nodes: string[]): H264Encoder[] {
  const list: H264Encoder[] = [{ name: 'nvenc', input: [], upload: '', codec: ['-c:v', 'h264_nvenc', '-preset', 'p2', '-tune', 'll'] }];
  if (platform === 'linux') {
    for (const device of nodes) {
      list.push({
        name: `vaapi ${device}`,
        input: ['-init_hw_device', `vaapi=va:${device}`, '-filter_hw_device', 'va'],
        upload: ',format=nv12,hwupload',
        codec: ['-c:v', 'h264_vaapi'],
      });
    }
  }
  // Intel graphics without VA-API (Windows): Quick Sync, last, as the server's copies (go2rtc/hardware-transcode.ts)
  if (platform !== 'darwin') {
    list.push({
      name: 'qsv',
      input: ['-init_hw_device', 'qsv=qs', '-filter_hw_device', 'qs'],
      upload: ',format=nv12,hwupload=extra_hw_frames=64',
      codec: ['-c:v', 'h264_qsv'],
    });
  }
  if (platform === 'darwin') list.unshift({ name: 'videotoolbox', input: [], upload: '', codec: ['-c:v', 'h264_videotoolbox', '-realtime', '1'] });
  return list;
}

export function renderNodes(): string[] {
  try {
    return existsSync('/dev/dri')
      ? readdirSync('/dev/dri')
          .filter((name) => name.startsWith('renderD'))
          .sort()
          .map((name) => `/dev/dri/${name}`)
      : [];
  } catch {
    // a container without the device: no VA-API, which is what an empty list says
    return [];
  }
}

/** Runs ffmpeg; true when it ended well within `timeoutMs`. */
export function ranWell(ffmpegPath: string, args: string[], timeoutMs = 15_000): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, args, { stdio: 'ignore' });
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
    proc.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    proc.once('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

/** The first hardware H.264 encoder that encodes a second of a test picture here, else libx264. */
export async function findH264Encoder(
  ffmpegPath: string,
  deps: { platform?: NodeJS.Platform; nodes?: () => string[]; run?: (args: string[]) => Promise<boolean> } = {},
): Promise<H264Encoder> {
  const run = deps.run ?? ((args) => ranWell(ffmpegPath, args));
  for (const encoder of candidates(deps.platform ?? process.platform, (deps.nodes ?? renderNodes)())) {
    const args = [
      '-hide_banner',
      '-v',
      'error',
      ...encoder.input,
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=10',
      '-t',
      '1',
      '-vf',
      `scale=320:180${encoder.upload}`,
      ...encoder.codec,
      '-f',
      'null',
      '-',
    ];
    if (await run(args)) return encoder;
  }
  return LIBX264;
}

export interface H264ReadOptions {
  ffmpegPath: string;
  encoder: H264Encoder;
  /** keeps tailing the file while it is written (the live tip) */
  follow?: () => boolean;
  signal?: AbortSignal;
  audio?: boolean;
  maxWidth?: number;
  /** the file's keyframe index: the times of its frames are anchored on each entry, as readFrames does */
  keyframes?: Keyframe[];
  /**
   * The frames before this time are decoded, not made, and none is given: the first is the frame of the time, made a
   * keyframe. A seek far into a GOP had every frame from its keyframe made first (1600 for 80 s of a Xiaomi GOP).
   */
  startUs?: number;
  /** more frames than this before `startUs`: no frames at all (the caller takes a nearer keyframe, as readExact does) */
  maxBefore?: number;
  /** the place of a playback, kept from one of its files to the next; without it the reading takes its own */
  place?: H264Place;
  /** how long to wait for a place at most (a short read nobody waits for long); no frames past it */
  waitMs?: number;
}

/**
 * The stream tables (PAT and PMT) at the start of a recorded file: the recorder writes them only there (recorder.ts),
 * and ffmpeg fed from a keyframe further on looked through 5 MB for the streams without them, a minute of a camera's
 * recording at the live tip.
 */
async function streamTables(fh: FileHandle): Promise<Buffer[]> {
  const head = Buffer.alloc(TS_PACKET * 8);
  const { bytesRead } = await fh.read(head, 0, head.length, 0);
  const packets: Buffer[] = [];
  let pmtPid = -1;
  for (let at = 0; at + TS_PACKET <= bytesRead && packets.length < 2; at += TS_PACKET) {
    const packet = head.subarray(at, at + TS_PACKET);
    if (packet[0] !== 0x47) break;
    const pid = ((packet[1] & 0x1f) << 8) | packet[2];
    if (pid === 0 && pmtPid < 0) {
      const section = 4 + 1 + packet[4];
      pmtPid = ((packet[section + 10] & 0x1f) << 8) | packet[section + 11];
      packets.push(Buffer.from(packet));
    } else if (pid === pmtPid) {
      packets.push(Buffer.from(packet));
    }
  }
  return packets.length === 2 ? packets : [];
}

/** The PTS of the access unit that begins at `offset` (a keyframe of the index), read from its PES header. */
async function ptsAt(fh: FileHandle, offset: number): Promise<number | undefined> {
  const packet = Buffer.alloc(TS_PACKET);
  const { bytesRead } = await fh.read(packet, 0, TS_PACKET, offset);
  if (bytesRead < TS_PACKET || packet[0] !== 0x47 || !(packet[1] & 0x40)) return undefined;
  const at = 4 + (packet[3] & 0x20 ? 1 + packet[4] : 0);
  if (at + 14 > TS_PACKET || packet[at] !== 0 || packet[at + 1] !== 0 || packet[at + 2] !== 1 || !(packet[at + 7] & 0x80)) return undefined;
  return readTimestamp(packet, at + 9);
}

/** The file from a keyframe on into ffmpeg's input, at its pace; the end of the file ends it unless it is followed. */
async function feed(fh: FileHandle, from: Keyframe, input: Writable, opts: H264ReadOptions, tap?: TsDemuxer): Promise<void> {
  let position = from.offset;
  if (position > 0) {
    const tables = await streamTables(fh);
    for (const table of tables) input.write(table);
    if (tables.length) tap?.push(Buffer.concat(tables), 0);
  }
  let first = true;
  const buf = Buffer.alloc(CHUNK);
  for (;;) {
    if (opts.signal?.aborted || input.destroyed) return;
    const { bytesRead } = await fh.read(buf, 0, CHUNK, position);
    // the client stopped while the file was read: ffmpeg's input is closed, and a write to it would wait for a 'drain'
    // or a 'close' that never comes again (the read never ended and kept its place)
    if (input.destroyed || input.writableEnded) return;
    if (bytesRead === 0) {
      if (opts.follow?.()) {
        await sleep(250);
        continue;
      }
      tap?.flush();
      input.end();
      return;
    }
    const chunk = Buffer.from(buf.subarray(0, bytesRead));
    tap?.push(chunk, first ? position : undefined);
    first = false;
    position += bytesRead;
    if (!input.write(chunk)) {
      await new Promise<void>((resolve) => {
        // whichever comes, the other is taken off: a wait for each chunk ffmpeg holds back left one behind
        const done = () => {
          input.off('drain', done);
          input.off('close', done);
          resolve();
        };
        input.once('drain', done);
        input.once('close', done);
      });
    }
  }
}

/**
 * The frames of a recorded file from `from` on as H.264, the times those of the recording: what `readFrames` gives,
 * made decodable for a client without H.265.
 */
export async function *readFramesAsH264(path: string, from: Keyframe, opts: H264ReadOptions): AsyncGenerator<Frame> {
  let start = from;
  let startUs = opts.startUs;
  let lastVideo: number | undefined;
  for (;;) {
    let fh: FileHandle;
    try {
      fh = await open(path, 'r');
    } catch (error) {
      // removed by the retention between the index lookup and the read: no frames, as readFrames says, and the playback
      // goes on with the next file instead of failing
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const place = opts.place ?? new H264Place();
    if (!(await place.take(opts.signal, opts.waitMs))) {
      await fh.close();
      return;
    }
    let held = true;
    // the reading's own place goes back when it ends; a playback's is kept for its next file
    const release = async (idleToo = false) => {
      if (!held) return;
      held = false;
      if (idleToo || !opts.place) place.release();
      await fh.close();
    };
    let idle = false;
    try {
      const frames = madeFrames(fh, path, start, { ...opts, startUs })[Symbol.asyncIterator]();
      for (;;) {
        const step = await frames.next();
        if (step.done) return;
        // no frame taken for a while: ffmpeg ends and the place and the file are freed while the client waits
        const timer = setTimeout(() => {
          idle = true;
          void frames.return(undefined).finally(() => release(true));
        }, idleMs);
        try {
          yield step.value;
        } finally {
          clearTimeout(timer);
        }
        if (!step.value.audio) lastVideo = step.value.tsUs;
        if (idle) break;
      }
    } finally {
      await release();
    }
    // the client is back: on from the keyframe before the last frame it took, the ones before decoded only (a
    // millisecond on: the start is found to half of one, and frames are further apart than that)
    if (lastVideo === undefined) {
      startUs = opts.startUs;
      continue;
    }
    start = (opts.keyframes ?? []).filter((kf) => kf.tsUs <= lastVideo!).at(-1) ?? from;
    startUs = lastVideo + 1000;
  }
}

/** The frames made H.264 by the encoder found, or by libx264 where that one fails before its first frame. */
async function *madeFrames(fh: FileHandle, path: string, from: Keyframe, opts: H264ReadOptions): AsyncGenerator<Frame> {
  let made = false;
  try {
    for await (const frame of framesOf(fh, path, from, opts)) {
      made = true;
      yield frame;
    }
  } catch (error) {
    // a hardware encoder that worked at the start can fail later (NVENC counts its sessions, and go2rtc's copies take
    // some): before its first frame, libx264 makes it instead. Past it the client has frames of that one already
    if (made || opts.encoder.name === LIBX264.name || opts.signal?.aborted) throw error;
    yield* framesOf(fh, path, from, { ...opts, encoder: LIBX264 });
  }
}

async function *framesOf(fh: FileHandle, path: string, from: Keyframe, opts: H264ReadOptions): AsyncGenerator<Frame> {
  const width = opts.maxWidth ?? MAX_WIDTH;
  // the PTS of the frame to begin with: the frames before it go through the decoder only (ffmpeg's select drops them)
  const fromPts = opts.startUs !== undefined && opts.startUs > from.tsUs ? await ptsAt(fh, from.offset) : undefined;
  const startPts = fromPts === undefined ? undefined : fromPts + Math.round(((opts.startUs! - from.tsUs) * 90) / 1000);
  // half a millisecond short of it: the time of a frame is its PTS rounded to the microsecond
  const select = startPts !== undefined && startPts - 45 < 2 ** 33 ? `select=gte(pts\\,${startPts - 45}),` : '';
  const proc = spawn(
    opts.ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      ...opts.encoder.input,
      // the streams are told by the tables fed first (streamTables); ffmpeg's 5 s of looking at them is then only a wait
      // at the live tip, where the file grows as the camera sends it (0 would be its default, not none)
      '-analyzeduration',
      '500000',
      // the input's PTS kept in the output (moved by the muxer's delay): the keyframes of the index are met by them
      '-copyts',
      '-f',
      'mpegts',
      '-i',
      'pipe:0',
      '-map',
      '0:v:0',
      ...(opts.audio ? ['-map', '0:a:0?', '-c:a', 'copy'] : ['-an']),
      '-vf',
      `${select}scale='min(${width},iw)':-2:flags=fast_bilinear${opts.encoder.upload}`,
      // the frames as they come: one out for every one in, at its own time
      '-fps_mode',
      'passthrough',
      ...opts.encoder.codec,
      '-g',
      '50',
      '-bf',
      '0',
      '-f',
      'mpegts',
      'pipe:1',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  // below the recording and the analysis: under load a viewer's picture waits, not the archive or a detection
  if (proc.pid !== undefined) {
    try {
      setPriority(proc.pid, 10);
    } catch {
      // a system that refuses it (or a process already gone) runs it at the normal priority, as it ran before
    }
  }
  const queue: Frame[] = [];
  let stderr = '';
  let ended = false;
  let failure: Error | undefined;
  let wake: (() => void) | undefined;
  const notify = () => {
    wake?.();
    wake = undefined;
  };
  // the first frame out is the keyframe the file was read from: its time anchors the rest, and every keyframe of the
  // index after it anchors the frames from it on, as readFrames does. The recorder moves its clock in the middle of a
  // file on a drift or a jump of the camera's PTS (recorder.ts), and frames made H.264 kept the first time for the whole
  // file. The keyframes are found in what is fed, by their offsets, and met in the output in their order by their PTS:
  // with -copyts those are the input's moved by the muxer's delay, a jump of the camera's clock included (a few ms off
  // after a jump back), while ffmpeg's own correction of a jump made them continuous and no longer theirs
  const index = new Map((opts.keyframes ?? []).map((kf) => [kf.offset, kf.tsUs]));
  // what is fed, as it is fed: the PTS of the keyframe fed first, of the frame given first (the one of `startUs`), the
  // keyframes of the index with their times, and how many of them came up to the frame given first
  let fedFirst: number | undefined;
  let startIn: number | undefined;
  const anchors: { pts: number; us: number }[] = [];
  let passed = 0;
  let before = 0;
  let tooFar = false;
  const tap = new TsDemuxer((au) => {
    if (fedFirst === undefined) {
      if (!au.keyframe) return;
      fedFirst = au.pts;
    }
    const us = au.keyframe ? index.get(au.offset) : undefined;
    if (us !== undefined) anchors.push({ pts: au.pts, us });
    if (startIn !== undefined) return;
    if (startPts === undefined || ptsDelta(startPts - 45, au.pts) >= 0) {
      startIn = au.pts;
      passed = anchors.length;
    } else if (opts.maxBefore !== undefined && ++before > opts.maxBefore) {
      tooFar = true;
      proc.kill('SIGKILL');
    }
  });
  // The time of a frame is that of the keyframe it was decoded from, the one fed first or a later keyframe of the
  // index, and its PTS distance from it, as readFrames does. The recorder moves its clock in the middle of a file on a
  // drift or a jump of the camera's PTS (recorder.ts), and frames made H.264 kept the first time for the whole file.
  // The keyframes are met in the output in their order by their PTS: with -copyts those are the input's moved by the
  // muxer's delay, a jump of the camera's clock included (a few ms off after a jump back), while ffmpeg's own
  // correction of a jump made them continuous and no longer theirs.
  let anchor: { pts: number; us: number } | undefined;
  // the output PTS less the input's, the next keyframe of the index to meet, the PTS of the frame before and the
  // distance between two frames (not over a jump of the clock)
  let shift: number | undefined;
  let next = 0;
  let previous: number | undefined;
  let interval = 0;
  const at = (pts: number) => anchor!.us + Math.round((ptsDelta(anchor!.pts, pts - shift!) / 90) * 1000);
  const demux = new TsDemuxer(
    (au) => {
      if (shift === undefined) {
        const first = startIn ?? fedFirst ?? au.pts;
        shift = au.pts - first;
        next = passed;
        anchor = passed > 0 ? anchors[passed - 1] : { pts: fedFirst ?? au.pts, us: from.tsUs };
      } else {
        // within half a frame: a keyframe is met where it is, not at a neighbour. 20 ms at least: after a jump of the
        // camera's clock back ffmpeg moves the PTS by 18 ms (1592 of 90 kHz) all the same
        const step = ptsDelta(previous ?? au.pts, au.pts);
        if (step > 0 && step <= 2 * 90_000) interval = step;
        const near = Math.max(1800, interval / 2);
        while (next < anchors.length && Math.abs(ptsDelta(anchors[next].pts + shift, au.pts)) <= near) {
          anchor = anchors[next];
          shift = au.pts - anchors[next].pts;
          next++;
        }
      }
      previous = au.pts;
      queue.push({ data: au.data, tsUs: at(au.pts), keyframe: au.keyframe });
    },
    undefined,
    opts.audio
      ? (au) => {
          if (shift === undefined) return;
          const tsUs = at(au.pts);
          if (tsUs >= (opts.startUs ?? from.tsUs)) queue.push({ data: au.data, tsUs, keyframe: false, audio: true });
        }
      : undefined,
  );
  proc.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-2000);
  });
  let held = false;
  proc.stdout.on('data', (chunk: Buffer) => {
    demux.push(chunk);
    if (queue.length >= QUEUE_HIGH && !held) {
      held = true;
      proc.stdout.pause();
    }
    notify();
  });
  proc.once('error', (error) => {
    failure = error;
    ended = true;
    notify();
  });
  proc.once('close', (code) => {
    demux.flush();
    // too far from the keyframe: ended here on purpose, no frames and no failure
    if (code !== 0 && !opts.signal?.aborted && !failure && !tooFar) {
      failure = new Error(`ffmpeg made no H.264 of ${path} (${code}): ${stderr.trim().split('\n').pop() ?? ''}`);
    }
    ended = true;
    notify();
  });
  // a client gone, or ffmpeg gone, ends the feeding: its failure is ffmpeg's, said when the frames end
  proc.stdin.on('error', () => {});
  const feeding = feed(fh, from, proc.stdin, opts, tap).catch((error: unknown) => {
    failure ??= error instanceof Error ? error : new Error(String(error));
    proc.kill('SIGKILL');
  });
  const stop = () => notify();
  opts.signal?.addEventListener('abort', stop, { once: true });
  try {
    for (;;) {
      const next = queue.shift();
      if (next) {
        if (held && queue.length <= QUEUE_LOW) {
          held = false;
          proc.stdout.resume();
        }
        yield next;
        continue;
      }
      if (ended || opts.signal?.aborted) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    if (failure && !opts.signal?.aborted) throw failure;
  } finally {
    opts.signal?.removeEventListener('abort', stop);
    if (proc.exitCode === null) proc.kill('SIGKILL');
    proc.stdin.destroy();
    await feeding;
  }
}
