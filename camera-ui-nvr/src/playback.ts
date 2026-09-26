import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { keyframeAtOrBefore, readFrames } from './reader.js';

import type { Store } from './store.js';
import type { NvrPlaybackCallbacks } from './types.js';

/** Frames may be sent this far ahead of real time; the browser pipeline buffers and paces them. */
const LEAD_US = 1_500_000;
/** A jump larger than this between segments is reported as a gap. */
const GAP_US = 3_000_000;
const YIELD_EVERY = 8;

interface Session {
  paused: boolean;
  speed: number;
  /** Changing either resets the pacing anchor. */
  epoch: number;
  abort: AbortController;
}

export class PlaybackManager {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly store: Store,
    private readonly isLive: (segmentId: number) => boolean,
  ) {}

  public command(sessionId: string, cmd: { cmd: 'pause' | 'resume' | 'speed'; speed?: number }): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (cmd.cmd === 'pause') s.paused = true;
    else if (cmd.cmd === 'resume') s.paused = false;
    else if (cmd.cmd === 'speed' && cmd.speed && cmd.speed > 0) s.speed = Math.min(cmd.speed, 64);
    s.epoch++;
  }

  public stopAll(): void {
    for (const s of this.sessions.values()) s.abort.abort();
    this.sessions.clear();
  }

  public async *play(cameraId: string, tsUs: number, role: string, cb: NvrPlaybackCallbacks): AsyncGenerator<void> {
    const sessionId = randomUUID();
    const session: Session = { paused: false, speed: 1, epoch: 0, abort: new AbortController() };
    this.sessions.set(sessionId, session);
    const call = <K extends 'onReady' | 'onVideo' | 'onNoData'>(method: K, payload: Parameters<NvrPlaybackCallbacks[K]>[0]) => {
      try {
        (cb[method] as (p: typeof payload) => void)(payload);
      } catch {
        session.abort.abort();
      }
    };

    try {
      let segment = this.store.segmentAt(cameraId, role, tsUs);
      if (!segment || segment.start_us - tsUs > GAP_US) {
        call('onNoData', { ts: tsUs });
        return;
      }

      let readyKey = '';
      let anchor: { wallUs: number; tsUs: number; epoch: number } | undefined;
      let sent = 0;
      let lastTs = tsUs;
      let from = keyframeAtOrBefore(segment, tsUs);

      while (segment && from && !session.abort.signal.aborted) {
        const key = `${segment.codec_string}|${segment.width}x${segment.height}`;
        if (key !== readyKey) {
          readyKey = key;
          call('onReady', { sessionId, videoCodec: segment.codec, codecString: segment.codec_string, width: segment.width, height: segment.height, role });
        }

        const current = segment;
        for await (const frame of readFrames(current, from, { follow: () => this.isLive(current.id), signal: session.abort.signal })) {
          // frames before the target only prime the decoder: send them without pacing
          if (frame.tsUs >= tsUs) {
            while (session.paused && !session.abort.signal.aborted) {
              await sleep(100);
              anchor = undefined;
            }
            if (anchor?.epoch !== session.epoch) anchor = { wallUs: Date.now() * 1000, tsUs: frame.tsUs, epoch: session.epoch };
            const dueUs = anchor.wallUs + (frame.tsUs - anchor.tsUs) / session.speed;
            const aheadUs = dueUs - Date.now() * 1000;
            if (aheadUs > LEAD_US) await sleep((aheadUs - LEAD_US) / 1000);
          }
          if (session.abort.signal.aborted) return;
          call('onVideo', { frame: frame.data, ts: frame.tsUs, keyframe: frame.keyframe });
          lastTs = Math.max(lastTs, frame.tsUs);
          if (++sent % YIELD_EVERY === 0) yield;
        }

        const next = this.store.nextSegment(cameraId, role, current.id, current.start_us);
        if (!next) break;
        if (next.start_us - lastTs > GAP_US) {
          call('onNoData', { ts: lastTs });
          anchor = undefined;
        }
        segment = next;
        from = keyframeAtOrBefore(next, next.start_us);
      }
      call('onNoData', { ts: lastTs });
    } finally {
      session.abort.abort();
      this.sessions.delete(sessionId);
    }
  }
}
