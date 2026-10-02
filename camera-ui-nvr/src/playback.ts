import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { keyframeAtOrBefore, readFrames } from './reader.js';

import type { Store } from './store.js';
import type { NvrPlaybackCallbacks } from './types.js';

/** Frames may be sent this far ahead of real time; the browser pipeline buffers and paces them. */
const LEAD_US = 1_500_000;
/** A jump larger than this between segments is reported as a gap. */
const GAP_US = 3_000_000;
/**
 * Playback asked for a moment just before the recording (an event that starts while the camera is
 * still connecting, a long keyframe interval) starts at the first recorded frame instead.
 */
const START_GAP_US = 30_000_000;
const YIELD_EVERY = 8;

interface Session {
  paused: boolean;
  speed: number;
  /**
   * Where the player is: at `tsUs` of what is played, at the wall-clock moment `wallUs`; from there it moves on at
   * `speed`, or stands while paused. Set when the first frame to show is sent.
   */
  clock: { wallUs: number; tsUs: number } | undefined;
  /** The holes of the archive the player has jumped over so far: its position counts what is played, not these. */
  skippedUs: number;
  abort: AbortController;
}

/** Where the player of a session is at `nowUs`, 0 before its first frame. */
function position(session: Session, nowUs: number): number {
  const clock = session.clock;
  if (!clock) return 0;
  return session.paused ? clock.tsUs : clock.tsUs + (nowUs - clock.wallUs) * session.speed;
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
    // The player goes on from where it is: its position is brought to this moment at the pace it had, and the new
    // pace counts from there. The pacing used to start anew at the next frame to send, which is a whole lead ahead
    // of the player: every pause, resume or change of speed sent another 1.5 s × speed of frames on top of those
    // the player had not shown yet, and after a few of them it held many seconds of video it could only store.
    const now = Date.now() * 1000;
    if (s.clock) s.clock = { wallUs: now, tsUs: position(s, now) };
    if (cmd.cmd === 'pause') s.paused = true;
    else if (cmd.cmd === 'resume') s.paused = false;
    else if (cmd.cmd === 'speed' && cmd.speed && cmd.speed > 0) s.speed = Math.min(cmd.speed, 64);
  }

  /** Holds a frame back until the player is no more than the lead away from it, whatever becomes of the pace meanwhile. */
  private async pace(session: Session, playedUs: number): Promise<void> {
    while (!session.abort.signal.aborted) {
      if (session.paused) {
        await sleep(100);
        continue;
      }
      const now = Date.now() * 1000;
      session.clock ??= { wallUs: now, tsUs: playedUs };
      const waitUs = (playedUs - position(session, now)) / session.speed - LEAD_US;
      if (waitUs <= 0) return;
      // in short waits: a command may change the pace at any moment
      await sleep(Math.min(waitUs / 1000, 100));
    }
  }

  public stopAll(): void {
    for (const s of this.sessions.values()) s.abort.abort();
    this.sessions.clear();
  }

  public async *play(cameraId: string, tsUs: number, role: string, cb: NvrPlaybackCallbacks, opts: { audio?: boolean } = {}): AsyncGenerator<void> {
    const sessionId = randomUUID();
    const session: Session = { paused: false, speed: 1, clock: undefined, skippedUs: 0, abort: new AbortController() };
    this.sessions.set(sessionId, session);
    const call = <K extends 'onReady' | 'onVideo' | 'onAudio' | 'onNoData'>(method: K, payload: Parameters<NonNullable<NvrPlaybackCallbacks[K]>>[0]) => {
      try {
        // onAudio is optional: a client without sound support simply gets none
        (cb[method] as ((p: typeof payload) => void) | undefined)?.(payload);
      } catch {
        session.abort.abort();
      }
    };

    try {
      let segment = this.store.segmentAt(cameraId, role, tsUs);
      if (!segment || segment.start_us - tsUs > START_GAP_US) {
        call('onNoData', { ts: tsUs });
        return;
      }

      let readyKey = '';
      let sent = 0;
      let lastTs = tsUs;
      let from = keyframeAtOrBefore(segment, tsUs);

      while (segment && from && !session.abort.signal.aborted) {
        // `recorded` tells the client the archive has sound (so it can offer the switch); the frames themselves
        // go only to a client that asked for them, a wall of cameras would throw them away
        const recorded = segment.audio_pid >= 0;
        const sendAudio = recorded && opts.audio !== false;
        const key = `${segment.codec_string}|${segment.width}x${segment.height}|${recorded}`;
        if (key !== readyKey) {
          readyKey = key;
          call('onReady', {
            sessionId,
            videoCodec: segment.codec,
            codecString: segment.codec_string,
            width: segment.width,
            height: segment.height,
            role,
            audio: recorded,
          });
        }

        const current = segment;
        const file = this.store.located(current);
        for await (const frame of readFrames(file, from, { follow: () => this.isLive(current.id), signal: session.abort.signal, audio: sendAudio })) {
          // frames before the target only prime the decoder: send them without pacing
          if (frame.tsUs >= tsUs) await this.pace(session, frame.tsUs - session.skippedUs);
          if (session.abort.signal.aborted) return;
          if (frame.audio) {
            call('onAudio', { frame: frame.data, ts: frame.tsUs });
            continue;
          }
          call('onVideo', { frame: frame.data, ts: frame.tsUs, keyframe: frame.keyframe });
          lastTs = Math.max(lastTs, frame.tsUs);
          if (++sent % YIELD_EVERY === 0) yield;
        }

        const next = this.store.nextSegment(cameraId, role, current.id, current.start_us);
        if (!next) break;
        if (next.start_us - lastTs > GAP_US) call('onNoData', { ts: lastTs });
        segment = next;
        from = keyframeAtOrBefore(next, next.start_us);
        // The player does not walk through a hole of the archive: when it gets there it goes on with the next
        // recording (a hole it would need more than 3 s for at its speed). Its position leaves the hole out the
        // same way, so the frames behind it are sent as far ahead as any other; starting the pacing anew at the
        // first of them, as before, added a lead with every hole.
        const holeUs = (from?.tsUs ?? next.start_us) - lastTs;
        if (holeUs > GAP_US * session.speed) session.skippedUs += holeUs;
      }
      call('onNoData', { ts: lastTs });
    } finally {
      session.abort.abort();
      this.sessions.delete(sessionId);
    }
  }
}
