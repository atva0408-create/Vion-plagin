// The recording of an H.265 camera as H.264, made while a client watches it: a browser that cannot decode H.265
// (Firefox; Chrome without the hardware for it) asks for the 'low' stream, and that was an H.264 copy the server made
// and the recorder kept all day — 20.8 GB a day of the bench's Xiaomi beside 5.7 GB of the camera's own H.265, and an
// encoder busy all day for it (2026-10-17). The TS bytes of the recording go through ffmpeg from a keyframe on and come
// out as TS again for the recorder's own demuxer, their times anchored on that keyframe's. A hardware encoder makes it
// when one works on this machine (tried by an encode), else libx264.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

import { ptsDelta, TS_PACKET, TsDemuxer } from './ts-demux.js';

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

/** The file from a keyframe on into ffmpeg's input, at its pace; the end of the file ends it unless it is followed. */
async function feed(fh: FileHandle, from: Keyframe, input: Writable, opts: H264ReadOptions): Promise<void> {
  let position = from.offset;
  if (position > 0) for (const table of await streamTables(fh)) input.write(table);
  const buf = Buffer.alloc(CHUNK);
  for (;;) {
    if (opts.signal?.aborted || input.destroyed) return;
    const { bytesRead } = await fh.read(buf, 0, CHUNK, position);
    if (bytesRead === 0) {
      if (opts.follow?.()) {
        await sleep(250);
        continue;
      }
      input.end();
      return;
    }
    position += bytesRead;
    if (!input.write(Buffer.from(buf.subarray(0, bytesRead)))) {
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
  let fh: FileHandle;
  try {
    fh = await open(path, 'r');
  } catch (error) {
    // removed by the retention between the index lookup and the read: no frames, as readFrames says, and the playback
    // goes on with the next file instead of failing
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  try {
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
  } finally {
    await fh.close();
  }
}

async function *framesOf(fh: FileHandle, path: string, from: Keyframe, opts: H264ReadOptions): AsyncGenerator<Frame> {
  const width = opts.maxWidth ?? MAX_WIDTH;
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
      '-f',
      'mpegts',
      '-i',
      'pipe:0',
      '-map',
      '0:v:0',
      ...(opts.audio ? ['-map', '0:a:0?', '-c:a', 'copy'] : ['-an']),
      '-vf',
      `scale='min(${width},iw)':-2:flags=fast_bilinear${opts.encoder.upload}`,
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
  const queue: Frame[] = [];
  let stderr = '';
  let ended = false;
  let failure: Error | undefined;
  let wake: (() => void) | undefined;
  const notify = () => {
    wake?.();
    wake = undefined;
  };
  // the first frame out is the keyframe the file was read from: its time anchors the rest
  let base: { pts: number; us: number } | undefined;
  const at = (pts: number) => base!.us + Math.round((ptsDelta(base!.pts, pts) / 90) * 1000);
  const demux = new TsDemuxer(
    (au) => {
      base ??= { pts: au.pts, us: from.tsUs };
      queue.push({ data: au.data, tsUs: at(au.pts), keyframe: au.keyframe });
    },
    undefined,
    opts.audio
      ? (au) => {
          if (!base) return;
          const tsUs = at(au.pts);
          if (tsUs >= from.tsUs) queue.push({ data: au.data, tsUs, keyframe: false, audio: true });
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
    if (code !== 0 && !opts.signal?.aborted && !failure) failure = new Error(`ffmpeg made no H.264 of ${path} (${code}): ${stderr.trim().split('\n').pop() ?? ''}`);
    ended = true;
    notify();
  });
  // a client gone, or ffmpeg gone, ends the feeding: its failure is ffmpeg's, said when the frames end
  proc.stdin.on('error', () => {});
  const feeding = feed(fh, from, proc.stdin, opts).catch((error: unknown) => {
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
