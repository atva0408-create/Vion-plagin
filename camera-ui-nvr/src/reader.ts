import { open } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

import { probeCodec, withParameterSets } from './media/codec.js';
import { ptsDelta, TsDemuxer } from './media/ts-demux.js';
import { parseKeyframes } from './store.js';

import type { FileHandle } from 'node:fs/promises';
import type { CodecInfo } from './media/codec.js';
import type { Keyframe, SegmentRow } from './store.js';

export interface Frame {
  data: Buffer;
  tsUs: number;
  keyframe: boolean;
  /** An ADTS frame of the recorded sound; only produced when `readFrames` is asked for audio. */
  audio?: boolean;
}

const CHUNK = 256 * 1024;

/** Latest keyframe at or before `tsUs` (or the first keyframe when `tsUs` precedes the segment). */
export function keyframeAtOrBefore(segment: SegmentRow, tsUs: number): Keyframe | undefined {
  const kfs = parseKeyframes(segment.keyframes);
  let found: Keyframe | undefined;
  for (const kf of kfs) {
    if (kf.tsUs <= tsUs) found = kf;
    else break;
  }
  return found ?? kfs[0];
}

/**
 * Streams the access units of a segment starting at a keyframe offset. With `follow`, keeps tailing
 * the file while it is still being written (live tip).
 */
export async function *readFrames(segment: SegmentRow, from: Keyframe, opts: { follow?: () => boolean; signal?: AbortSignal; audio?: boolean } = {}): AsyncGenerator<Frame> {
  const kfs = parseKeyframes(segment.keyframes);
  const kfByOffset = new Map(kfs.map((k) => [k.offset, k.tsUs]));
  let base: { pts: number; us: number } | undefined;
  const queue: Frame[] = [];
  let info: CodecInfo | undefined;

  const demux = new TsDemuxer(
    (au) => {
      const known = kfByOffset.get(au.offset);
      if (known !== undefined && au.keyframe) base = { pts: au.pts, us: known };
      if (!base) {
        // no index entry yet (live file ahead of the last flush): anchor on this keyframe
        if (!au.keyframe) return;
        base = { pts: au.pts, us: from.tsUs };
      }
      const tsUs = base.us + Math.round((ptsDelta(base.pts, au.pts) / 90) * 1000);
      let data = au.data;
      if (au.keyframe) {
        info ??= probeCodec(data, segment.codec);
        data = withParameterSets(data, segment.codec, info);
      }
      queue.push({ data, tsUs, keyframe: au.keyframe });
    },
    { videoPid: segment.video_pid, codec: segment.codec, audioPid: opts.audio && segment.audio_pid >= 0 ? segment.audio_pid : undefined },
    opts.audio
      ? (au) => {
          // sound before the first video frame read has no place on the timeline yet
          if (!base) return;
          const tsUs = base.us + Math.round((ptsDelta(base.pts, au.pts) / 90) * 1000);
          // and sound that belongs before the keyframe playback starts from would play ahead of the picture
          if (tsUs < from.tsUs) return;
          queue.push({ data: au.data, tsUs, keyframe: false, audio: true });
        }
      : undefined,
  );

  let fh: FileHandle;
  try {
    fh = await open(segment.path, 'r');
  } catch (error) {
    // removed by retention between the index lookup and the read: the segment is simply gone
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  try {
    let position = from.offset;
    const buf = Buffer.alloc(CHUNK);
    let first = true;
    for (;;) {
      if (opts.signal?.aborted) return;
      const { bytesRead } = await fh.read(buf, 0, CHUNK, position);
      if (bytesRead === 0) {
        if (opts.follow?.()) {
          await sleep(250);
          continue;
        }
        demux.flush();
        yield* queue.splice(0);
        return;
      }
      demux.push(Buffer.from(buf.subarray(0, bytesRead)), first ? position : undefined);
      first = false;
      position += bytesRead;
      // keep the last access unit pending: it may continue in the next chunk
      if (queue.length) yield* queue.splice(0);
    }
  } finally {
    await fh.close();
  }
}

/** Reads the keyframe access unit at an index entry. */
export async function readKeyframe(segment: SegmentRow, kf: Keyframe): Promise<Frame | undefined> {
  for await (const frame of readFrames(segment, kf)) {
    if (frame.keyframe) return frame;
  }
  return undefined;
}

/** Reads the GOP from a keyframe up to (and including) the frame at `untilUs`. */
export async function readGop(segment: SegmentRow, kf: Keyframe, untilUs: number, max = 300): Promise<Frame[]> {
  const out: Frame[] = [];
  for await (const frame of readFrames(segment, kf)) {
    if (out.length && frame.keyframe) break;
    out.push(frame);
    if (frame.tsUs >= untilUs || out.length >= max) break;
  }
  return out;
}
