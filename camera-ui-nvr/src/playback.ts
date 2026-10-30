import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { probeCodec } from './media/codec.js';
import { H264Place, readFramesAsH264 } from './media/transcode.js';
import { keyframeAtOrBefore, readFrames } from './reader.js';
import { parseKeyframes } from './store.js';

import type { H264Encoder } from './media/transcode.js';
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
export const START_GAP_US = 30_000_000;
const YIELD_EVERY = 8;

/** A client that pulls nothing for this long is gone: its playback ends. */
let clientGoneMs = 5 * 60 * 1000;

/**
 * A paused playback whose player said nothing for this long is gone: its playback ends. A paused player pulls once and
 * waits in the pace, so no pull tells whether it is still there; a tab closed while paused held its file and buffers
 * until the plugin restarted. A player resumed after that opens its playback again where it stands (ui playback.ts).
 */
let pausedGoneMs = 10 * 60 * 1000;

/** For the tests: how long a playback waits for its client's next pull. */
export function setPlaybackClientGone(ms: number): void {
  clientGoneMs = ms;
}

/** For the tests: how long a paused playback waits for a word from its player. */
export function setPlaybackPausedGone(ms: number): void {
  pausedGoneMs = ms;
}

/**
 * The playback as its client pulls it, ended when the client pulls nothing for clientGoneMs. The RPC never tells the
 * plugin that a browser went away (a closed tab, a killed app, a lost network): the playback waited for the next pull
 * for good, its recording open (on the bench 25 minutes after the tab was closed). A paused player still pulls: its
 * playback waits in the pace, not here, and ends there (pausedGoneMs).
 */
async function *untilClientGone<T>(inner: AsyncGenerator<T>): AsyncGenerator<T> {
  try {
    for (;;) {
      // ended meanwhile, the playback is done for a client that pulls again after all
      const step = await inner.next();
      if (step.done) return;
      const timer = setTimeout(() => void inner.return(undefined), clientGoneMs);
      try {
        yield step.value;
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    await inner.return(undefined);
  }
}

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
  /** When the player last said anything (the start, a command): a paused playback is gone after pausedGoneMs of none. */
  heardMs: number;
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
    /** ffmpeg and the H.264 encoder of this machine, for a client that cannot decode H.265 (media/transcode.ts) */
    private readonly h264?: () => Promise<{ ffmpegPath: string; encoder: H264Encoder }>,
  ) {}

  public command(sessionId: string, cmd: { cmd: 'pause' | 'resume' | 'speed'; speed?: number }): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    // The player goes on from where it is: its position is brought to this moment at the pace it had, and the new
    // pace counts from there. The pacing used to start anew at the next frame to send, which is a whole lead ahead
    // of the player: every pause, resume or change of speed sent another 1.5 s × speed of frames on top of those
    // the player had not shown yet, and after a few of them it held many seconds of video it could only store.
    const now = Date.now() * 1000;
    s.heardMs = now / 1000;
    if (s.clock) s.clock = { wallUs: now, tsUs: position(s, now) };
    if (cmd.cmd === 'pause') s.paused = true;
    else if (cmd.cmd === 'resume') s.paused = false;
    else if (cmd.cmd === 'speed' && cmd.speed && cmd.speed > 0) s.speed = Math.min(cmd.speed, 64);
  }

  /** Holds a frame back until the player is no more than the lead away from it, whatever becomes of the pace meanwhile. */
  private async pace(session: Session, playedUs: number): Promise<void> {
    while (!session.abort.signal.aborted) {
      if (session.paused) {
        if (Date.now() - session.heardMs > pausedGoneMs) {
          session.abort.abort();
          return;
        }
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

  /**
   * `asH264`: the H.265 recordings go out as H.264, made while they are played (a client that cannot decode H.265).
   * `then`: the stream to go on with where the recordings of `role` end and it goes on (a lighter recording of before,
   * whose recorder stopped keeping it: the H.264 copy of an H.265 camera).
   */
  public play(
    cameraId: string,
    tsUs: number,
    role: string,
    cb: NvrPlaybackCallbacks,
    opts: { audio?: boolean; asH264?: boolean; then?: { role: string; asH264: boolean } } = {},
  ): AsyncGenerator<void> {
    return untilClientGone(this.stream(cameraId, tsUs, role, cb, opts));
  }

  private async *stream(
    cameraId: string,
    tsUs: number,
    role: string,
    cb: NvrPlaybackCallbacks,
    opts: { audio?: boolean; asH264?: boolean; then?: { role: string; asH264: boolean } },
  ): AsyncGenerator<void> {
    let asH264 = opts.asH264;
    let then = opts.then;
    const sessionId = randomUUID();
    const session: Session = { paused: false, speed: 1, clock: undefined, skippedUs: 0, heardMs: Date.now(), abort: new AbortController() };
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
      // made H.264, the frames before it are decoded, not made: the time asked for, then where the stream recorded now
      // goes on past the last frame sent
      let startUs: number | undefined = tsUs;
      // one place to make H.264 in for the whole playback, kept from one file to the next
      const place = new H264Place();
      session.abort.signal.addEventListener('abort', () => place.release(), { once: true });

      while (segment && from && !session.abort.signal.aborted) {
        // `recorded` tells the client the archive has sound (so it can offer the switch); the frames themselves
        // go only to a client that asked for them, a wall of cameras would throw them away
        const recorded = segment.audio_pid >= 0;
        const sendAudio = recorded && opts.audio !== false;
        const ready = (meta: { videoCodec: string; codecString: string; width: number; height: number }) => {
          const key = `${meta.codecString}|${meta.width}x${meta.height}|${recorded}`;
          if (key === readyKey) return;
          readyKey = key;
          call('onReady', { sessionId, ...meta, role, audio: recorded });
        };

        const current = segment;
        const file = this.store.located(current);
        const reading = { follow: () => this.isLive(current.id), signal: session.abort.signal, audio: sendAudio };
        const made = asH264 && current.codec === 'h265' && this.h264 ? await this.h264() : undefined;
        // an H.264 recording is told as it is; one made H.264 by what its first keyframe says, as it comes
        if (!made) ready({ videoCodec: current.codec, codecString: current.codec_string, width: current.width, height: current.height });
        const frames = made
          ? readFramesAsH264(file.path, from, { ...made, ...reading, keyframes: parseKeyframes(current.keyframes), startUs, place })
          : readFrames(file, from, reading);
        for await (const frame of frames) {
          if (made && frame.keyframe && !frame.audio) {
            const info = probeCodec(frame.data, 'h264');
            if (info) ready({ videoCodec: 'h264', codecString: info.codecString, width: info.width, height: info.height });
          }
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

        let next = this.store.nextSegment(cameraId, role, current.id, current.start_us);
        let fromUs = next?.start_us;
        startUs = undefined;
        if (!next && then) {
          // on with the stream recorded now where it has more than was sent, from its keyframe before the last frame
          // sent: the player shows the newest frame up to its position, so the ones before it only prime its decoder
          next = this.store.segmentAt(cameraId, then.role, lastTs + 1);
          fromUs = next ? Math.max(next.start_us, lastTs) : undefined;
          // a millisecond on: the start is found to half of one, and frames are further apart than that
          startUs = lastTs + 1000;
          ({ role, asH264 } = then);
          then = undefined;
        }
        if (!next) break;
        if (next.start_us - lastTs > GAP_US) call('onNoData', { ts: lastTs });
        segment = next;
        from = keyframeAtOrBefore(next, fromUs!);
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
