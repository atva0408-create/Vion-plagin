/**
 * The camera's speaker: speech as G.711 A-law RTP into the talk channel of the camera.
 *
 * A-law at 8 kHz in 20 ms packets is the simplest thing the server's talk channel decodes (pcm_alaw), needs no
 * library, and the server transcodes it to whatever the camera wants (OPUS for the Xiaomi C300). Packets go out at
 * the pace of real time: a burst would overflow the camera's buffer and come out cut.
 */
import { randomInt } from 'node:crypto';

import type { Clock } from './clock.js';

/**
 * What the speaker needs of a camera source, its talk channel. The SDK's `CameraDeviceSource` has it; this package
 * names only what it uses, so it builds without the SDK.
 */
export interface TalkSource {
  backchannelAudioCodec?: unknown;
  backchannelDisabled?: boolean;
  createRtpSession(options: { video?: boolean; audio?: boolean; backchannel?: boolean }): TalkSession;
}

/** The part of the SDK's `RtpSession` the speaker uses. */
export interface TalkSession {
  readonly hasBackchannel: boolean;
  readonly onError: { subscribe(listener: (error: Error) => void): unknown };
  readonly onEnded: { subscribe(listener: () => void): unknown };
  startStream(): Promise<void>;
  startBackchannel(config: { decoderCodec: 'pcm_alaw' | 'pcm_mulaw'; payloadType: number; clockRate: number; channels?: number }): Promise<void>;
  sendAudioPacket(packet: Buffer): Promise<void>;
  stop(): Promise<void>;
}

/** The part of the SDK's `CameraDevice` the speaker uses. */
export interface SpeakerCamera {
  readonly name: string;
  readonly connected: boolean;
  readonly sources: readonly TalkSource[];
}

export const RTP_CLOCK = 8000;
export const PACKET_MS = 20;
export const SAMPLES_PER_PACKET = (RTP_CLOCK * PACKET_MS) / 1000;
export const PAYLOAD_TYPE_PCMA = 8;

export type SpeakStatus = 'spoken' | 'no_backchannel' | 'busy' | 'failed';

export interface SpeakResult {
  status: SpeakStatus;
  reason?: string;
  /** Milliseconds from the call to the first packet sent. */
  latencyMs?: number;
  durationMs?: number;
}

const SEGMENT_ENDS = [0x1f, 0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff];

/** G.711 A-law of one 16-bit sample, as the reference g711.c (Sun Microsystems) computes it. */
export function alawEncodeSample(sample: number): number {
  let pcm = Math.max(-32768, Math.min(32767, Math.round(sample))) >> 3;
  let mask: number;
  if (pcm >= 0) mask = 0xd5;
  else {
    mask = 0x55;
    pcm = -pcm - 1;
  }
  let segment = 0;
  while (segment < 8 && pcm > SEGMENT_ENDS[segment]) segment++;
  if (segment >= 8) return 0x7f ^ mask;
  const value = (segment << 4) | (segment < 2 ? (pcm >> 1) & 0x0f : (pcm >> segment) & 0x0f);
  return value ^ mask;
}

export function alawDecodeSample(value: number): number {
  const a = value ^ 0x55;
  let t = (a & 0x0f) << 4;
  const segment = (a & 0x70) >> 4;
  if (segment === 0) t += 8;
  else if (segment === 1) t += 0x108;
  else t = (t + 0x108) << (segment - 1);
  return a & 0x80 ? t : -t;
}

/** Float samples (-1…1) at any rate → 16-bit at 8 kHz, by linear interpolation (speech has nothing above 4 kHz worth keeping). */
export function toPcm8k(samples: Float32Array, sampleRate: number): Int16Array {
  const length = Math.floor((samples.length * RTP_CLOCK) / sampleRate);
  const out = new Int16Array(length);
  const step = sampleRate / RTP_CLOCK;
  for (let i = 0; i < length; i++) {
    const position = i * step;
    const index = Math.floor(position);
    const next = samples[Math.min(index + 1, samples.length - 1)];
    const value = samples[index] + (next - samples[index]) * (position - index);
    out[i] = Math.max(-32768, Math.min(32767, Math.round(value * 32767)));
  }
  return out;
}

export function alawEncode(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = alawEncodeSample(pcm[i]);
  return out;
}

export interface RtpStreamState {
  ssrc: number;
  sequence: number;
  timestamp: number;
}

export function newRtpState(): RtpStreamState {
  return { ssrc: randomInt(1, 0xffffffff), sequence: randomInt(0, 0xffff), timestamp: randomInt(0, 0xffffffff) };
}

/** RTP packets of 20 ms (RFC 3550 header, payload type 8); the last one is padded with A-law silence. */
export function packetize(alaw: Uint8Array, state: RtpStreamState): Buffer[] {
  const packets: Buffer[] = [];
  for (let offset = 0; offset < alaw.length; offset += SAMPLES_PER_PACKET) {
    const packet = Buffer.alloc(12 + SAMPLES_PER_PACKET, 0xd5);
    packet[0] = 0x80;
    // marker on the first packet of a talk spurt (RFC 3551 4.1)
    packet[1] = (offset === 0 ? 0x80 : 0) | PAYLOAD_TYPE_PCMA;
    packet.writeUInt16BE(state.sequence, 2);
    packet.writeUInt32BE(state.timestamp >>> 0, 4);
    packet.writeUInt32BE(state.ssrc >>> 0, 8);
    packet.set(alaw.subarray(offset, offset + SAMPLES_PER_PACKET), 12);
    packets.push(packet);
    state.sequence = (state.sequence + 1) & 0xffff;
    state.timestamp = (state.timestamp + SAMPLES_PER_PACKET) >>> 0;
  }
  return packets;
}

/**
 * Sends the packets at their time: packet i leaves at start + i·20 ms, measured from the start, so a late timer
 * does not add up to drift. One packet per timer: after a stall of the event loop the schedule moves on from the late
 * packet instead of catching up. The signal stops the phrase between packets.
 */
export function sendPaced(packets: Buffer[], send: (packet: Buffer) => Promise<void> | void, clock: Clock, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let start = clock.now();
    let index = 0;
    let done = false;
    let timer: unknown;
    const sent: Promise<void>[] = [];
    const finish = (error?: unknown) => {
      if (done) return;
      done = true;
      clock.clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error !== undefined) reject(error);
      else resolve();
    };
    const abort = () => finish(signal?.reason ?? new Error('the phrase was cancelled'));
    const next = () => {
      if (done) return;
      try {
        if (index < packets.length) {
          // a second of a stalled loop sent at once overflows the camera's buffer and comes out cut
          if (clock.now() - (start + index * PACKET_MS) >= PACKET_MS) start = clock.now() - index * PACKET_MS;
          sent.push(
            // a packet the server refused ends the phrase: it was reported "said" though nothing reached the camera
            Promise.resolve(send(packets[index])).catch((error: unknown) => {
              finish(error ?? new Error('the server refused an audio packet'));
            }),
          );
          index++;
        }
      } catch (error) {
        finish(error ?? new Error('the server refused an audio packet'));
        return;
      }
      if (index >= packets.length) {
        void Promise.all(sent).then(() => finish());
        return;
      }
      timer = clock.setTimeout(next, Math.max(0, start + index * PACKET_MS - clock.now()));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    next();
  });
}

export type SpeakerProblem = 'no_channel' | 'channel_off' | 'offline';

/** Said to the assistant and in the log; the camera drawer shows the same in the owner's language. */
export const PROBLEM_TEXT: Record<SpeakerProblem, string> = {
  no_channel: 'the camera has no speaker channel (no backchannel in its stream)',
  channel_off: 'the talk channel is turned off in the camera settings',
  offline: 'the camera is offline',
};

/** Why this camera cannot speak, or undefined when it can. */
export function speakerProblemCode(camera: Pick<SpeakerCamera, 'sources' | 'connected'>, pick = talkSource): SpeakerProblem | undefined {
  if (!pick(camera)) return camera.sources.some((s) => s.backchannelAudioCodec && s.backchannelDisabled) ? 'channel_off' : 'no_channel';
  if (!camera.connected) return 'offline';
  return undefined;
}

export function speakerProblem(camera: Pick<SpeakerCamera, 'sources' | 'connected'>, pick = talkSource): string | undefined {
  const code = speakerProblemCode(camera, pick);
  return code && PROBLEM_TEXT[code];
}

export function talkSource(camera: Pick<SpeakerCamera, 'sources'>): TalkSource | undefined {
  return camera.sources.find((s) => s.backchannelAudioCodec && !s.backchannelDisabled);
}

/** Leading silence: the talk channel of some cameras swallows the first fraction of a second. */
const LEAD_MS = 200;
/**
 * The session closes shortly after a phrase: the last packets still have to pass the server's transcoder. It is not
 * kept for the next phrase, because the server ends its talk channel when packets stop, and a phrase sent into an
 * ended channel is lost without an error.
 */
const DRAIN_MS = 1_000;

/**
 * One RTP session into the camera, opened for a phrase and kept for a while. Phrases are given to it one at a time (by
 * VOICE's queue, by the intercom's conversation); one given while another is said gets `busy`.
 */
export class CameraSpeaker {
  private session: TalkSession | undefined;
  private closeTimer: unknown;
  private rtp = newRtpState();
  /** Why the open session broke (the server ended or failed its talk channel), during a phrase or between two. */
  private broken: string | undefined;
  /** The phrase being said: closing the speaker or a broken channel stops it. */
  private active: AbortController | undefined;
  private disposed = false;

  constructor(
    private camera: SpeakerCamera,
    private clock: Clock,
    private log: (message: string) => void,
    /** The source whose talk channel to use; by default the first that has one. */
    private source: (camera: Pick<SpeakerCamera, 'sources'>) => TalkSource | undefined = talkSource,
  ) {}

  /**
   * Says the samples. Two phrases at once would mix their packets in one RTP stream (or open a second stream and leave
   * the first one running), so the second is refused as `busy`. The signal stops the phrase.
   */
  async speak(samples: Float32Array, sampleRate: number, signal?: AbortSignal): Promise<SpeakResult> {
    if (this.disposed || signal?.aborted) return { status: 'failed', reason: 'the phrase was cancelled' };
    if (this.active) return { status: 'busy', reason: 'the camera is already speaking' };
    const started = this.clock.now();
    const problem = speakerProblem(this.camera, this.source);
    if (problem) return { status: 'no_backchannel', reason: problem };
    this.clock.clearTimeout(this.closeTimer);
    const active = new AbortController();
    this.active = active;
    const cancelled = signal ? AbortSignal.any([signal, active.signal]) : active.signal;
    try {
      const session = await this.open(cancelled);
      cancelled.throwIfAborted();
      if (!session.hasBackchannel) {
        await this.close();
        return { status: 'no_backchannel', reason: 'the camera stream has no talk channel' };
      }
      const lead = new Int16Array((RTP_CLOCK * LEAD_MS) / 1000);
      const pcm = toPcm8k(samples, sampleRate);
      const audio = new Int16Array(lead.length + pcm.length);
      audio.set(pcm, lead.length);
      const packets = packetize(alawEncode(audio), this.rtp);
      const latencyMs = this.clock.now() - started;
      await sendPaced(packets, (packet) => session.sendAudioPacket(packet), this.clock, cancelled);
      // the server drops packets of an ended channel without an error: its end or failure is the only sign
      if (this.broken) {
        const reason = this.broken;
        await this.close();
        return { status: 'failed', reason };
      }
      this.closeTimer = this.clock.setTimeout(() => void this.close(), DRAIN_MS);
      return { status: 'spoken', latencyMs, durationMs: packets.length * PACKET_MS };
    } catch (error) {
      await this.close();
      return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
    } finally {
      if (this.active === active) this.active = undefined;
    }
  }

  /** Stops the phrase being said and the stream; the next phrase opens a new one. */
  async close(): Promise<void> {
    this.clock.clearTimeout(this.closeTimer);
    this.active?.abort(new Error('the speaker was closed'));
    const session = this.session;
    this.session = undefined;
    if (session) await session.stop().catch((error: Error) => this.log(`speaker of ${this.camera.name}: ${error.message}`));
  }

  /** The camera is released: closed for good, a phrase that comes late is not said. */
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.close();
  }

  private async open(signal: AbortSignal): Promise<TalkSession> {
    if (this.session) {
      // failed while idle, between phrases: sent into it, the phrase would be lost without an error
      if (this.broken) throw new Error(this.broken);
      return this.session;
    }
    const source = this.source(this.camera);
    if (!source) throw new Error('no source with a talk channel');
    // the talk channel rides on an open stream: audio only, nothing of it is read
    const session = source.createRtpSession({ video: false, audio: true, backchannel: true });
    // kept before it starts: closing the speaker meanwhile (the camera released, the plugin stopped) stops this stream
    // too, instead of leaving it half open
    this.session = session;
    this.broken = undefined;
    session.onError.subscribe((error) => {
      this.log(`speaker of ${this.camera.name}: ${error.message}`);
      if (this.session === session) {
        this.broken = error.message;
        this.active?.abort(error);
      }
    });
    session.onEnded.subscribe(() => {
      if (this.session !== session) return;
      this.session = undefined;
      this.broken ??= 'the talk channel of the camera ended';
      this.active?.abort(new Error(this.broken));
    });
    try {
      // no codec asked for the incoming audio: it is not read, and asking would make the server transcode it
      await session.startStream();
      signal.throwIfAborted();
      await session.startBackchannel({ decoderCodec: 'pcm_alaw', payloadType: PAYLOAD_TYPE_PCMA, clockRate: RTP_CLOCK, channels: 1 });
      signal.throwIfAborted();
    } catch (error) {
      // the stream is open by now and would keep pulling the camera until it drops it
      await session.stop().catch(() => undefined);
      if (this.session === session) this.session = undefined;
      throw error;
    }
    this.rtp = newRtpState();
    return session;
  }
}
