/**
 * The sound of a SIP call: RTP of G.711 both ways (RFC 3550, RFC 3551) and the keys pressed as telephone events
 * (RFC 4733). Packets go out every 20 ms for the whole call, silence between phrases, as a phone does: a panel may end
 * a call that sends it nothing. What comes in is accepted from the panel's address only.
 */
import { randomInt } from 'node:crypto';
import { createSocket } from 'node:dgram';

import { LISTEN_RATE, PACKET_MS, RTP_CLOCK, SAMPLES_PER_PACKET, alawDecodeSample, alawEncode, systemClock, toPcm8k } from '@vionvision/speech';

import type { Socket } from 'node:dgram';
import type { Clock, SpeakResult } from '@vionvision/speech';
import type { G711 } from './message.js';

const ALAW_SILENCE = 0xd5;
const ULAW_SILENCE = 0xff;
/** a key held this long, in 20 ms packets, then three packets that end it (RFC 4733 2.5.1.4) */
const DTMF_PACKETS = 8;
const DTMF_END_PACKETS = 3;
/** silence between two keys of a code */
const DTMF_GAP_PACKETS = 5;
const DTMF_EVENTS = '0123456789*#ABCD';
/** the ports tried for a call's RTP, an even one (its RTCP would be the next) */
const PORTS: [number, number] = [30_000, 39_998];

/** G.711 μ-law of one 16-bit sample (ITU-T G.711, as the reference g711.c computes it). */
export function ulawEncodeSample(sample: number): number {
  const BIAS = 0x84;
  let pcm = Math.max(-32768, Math.min(32767, Math.round(sample))) >> 2;
  let mask: number;
  if (pcm < 0) {
    pcm = -pcm;
    mask = 0x7f;
  } else mask = 0xff;
  pcm = Math.min(pcm + (BIAS >> 2), 8159);
  let segment = 0;
  for (let end = 0x3f; segment < 8 && pcm > end; end = (end << 1) | 1) segment++;
  if (segment >= 8) return 0x7f ^ mask;
  return ((segment << 4) | ((pcm >> (segment + 1)) & 0x0f)) ^ mask;
}

export function ulawDecodeSample(value: number): number {
  const u = ~value & 0xff;
  let t = ((u & 0x0f) << 3) + 0x84;
  t <<= (u & 0x70) >> 4;
  return u & 0x80 ? 0x84 - t : t - 0x84;
}

function encode(codec: G711, pcm: Int16Array): Uint8Array {
  if (codec === 'PCMA') return alawEncode(pcm);
  const out = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = ulawEncodeSample(pcm[i]);
  return out;
}

/** G.711 at 8 kHz → float samples at 16 kHz (each sample and the midpoint to the next), what speech recognition takes. */
export function decodeTo16k(codec: G711, payload: Uint8Array, last: { value: number }): Float32Array {
  const decode = codec === 'PCMA' ? alawDecodeSample : ulawDecodeSample;
  const out = new Float32Array(payload.length * (LISTEN_RATE / RTP_CLOCK));
  let previous = last.value;
  for (let i = 0; i < payload.length; i++) {
    const value = decode(payload[i]) / 32768;
    out[i * 2] = (previous + value) / 2;
    out[i * 2 + 1] = value;
    previous = value;
  }
  last.value = previous;
  return out;
}

export interface RtpPeer {
  address: string;
  port: number;
}

export interface RtpOptions {
  codec: G711;
  payloadType: number;
  dtmfPayloadType?: number;
  /** where the panel wants the sound (its SDP); a packet from the panel's host moves it to where it really comes from */
  remote: RtpPeer;
  /** the only address accepted */
  panelHost: string;
  clock?: Clock;
  log?: (message: string) => void;
}

interface Frame {
  payload: Uint8Array;
  /** a telephone event packet: its own payload type; all packets of one key carry the timestamp of its first */
  event?: { marker: boolean; end: boolean };
  /** resolved when this frame went out */
  sent?: () => void;
}

interface RtpHeader {
  payloadType: number;
  sequence: number;
  timestamp: number;
  marker: boolean;
  payload: Uint8Array;
}

export function parseRtp(packet: Buffer): RtpHeader | undefined {
  if (packet.length < 12 || packet[0] >> 6 !== 2) return undefined;
  const csrc = packet[0] & 0x0f;
  let offset = 12 + csrc * 4;
  if (packet[0] & 0x10) {
    if (packet.length < offset + 4) return undefined;
    offset += 4 + packet.readUInt16BE(offset + 2) * 4;
  }
  let end = packet.length;
  if (packet[0] & 0x20) end -= packet[packet.length - 1];
  if (end < offset) return undefined;
  return {
    payloadType: packet[1] & 0x7f,
    marker: Boolean(packet[1] & 0x80),
    sequence: packet.readUInt16BE(2),
    timestamp: packet.readUInt32BE(4),
    payload: packet.subarray(offset, end),
  };
}

async function bindEven(): Promise<Socket> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const port = PORTS[0] + 2 * randomInt(0, (PORTS[1] - PORTS[0]) / 2 + 1);
    const socket = createSocket('udp4');
    const bound = await new Promise<boolean>((resolve) => {
      socket.once('error', () => resolve(false));
      socket.bind(port, () => resolve(true));
    });
    if (bound) return socket;
    socket.close();
  }
  throw new Error('no free port for the sound of the call');
}

export class RtpAudio {
  private readonly clock: Clock;
  private readonly log: (message: string) => void;
  private remote: RtpPeer;
  private latched = false;
  private queue: Frame[] = [];
  private sequence = randomInt(0, 0xffff);
  private timestamp = randomInt(0, 0xffffffff);
  private readonly ssrc = randomInt(1, 0xffffffff);
  private talking = false;
  private started = 0;
  private sentFrames = 0;
  private timer: unknown;
  private closed = false;
  private audioListeners = new Set<(samples: Float32Array) => void>();
  private dtmfListeners = new Set<(digit: string) => void>();
  private lastSample = { value: 0 };
  /** of telephone events heard: the timestamp of the last one told, so its repeated packets are told once */
  private lastEvent: number | undefined;
  /** packets heard from the panel, for the log at the end */
  received = 0;

  private constructor(
    private readonly socket: Socket,
    private readonly options: RtpOptions,
  ) {
    this.clock = options.clock ?? systemClock;
    this.log = options.log ?? (() => undefined);
    this.remote = options.remote;
    socket.on('message', (packet, from) => this.onPacket(packet, from));
    socket.on('error', (error) => this.log(`RTP: ${error.message}`));
  }

  static async open(options: RtpOptions): Promise<RtpAudio> {
    return new RtpAudio(await bindEven(), options);
  }

  get port(): number {
    return this.socket.address().port;
  }

  get codec(): G711 {
    return this.options.codec;
  }

  /** The panel's sound as it comes, at 16 kHz; returns the way to stop listening. */
  onAudio(listener: (samples: Float32Array) => void): () => void {
    this.audioListeners.add(listener);
    return () => this.audioListeners.delete(listener);
  }

  onDtmf(listener: (digit: string) => void): () => void {
    this.dtmfListeners.add(listener);
    return () => this.dtmfListeners.delete(listener);
  }

  /** Where the panel wants the sound, when it said so only later (an answer in the ACK). */
  retarget(peer: RtpPeer | undefined): void {
    if (peer && !this.latched) this.remote = peer;
  }

  /** Starts sending: silence until there is something to say. */
  start(): void {
    if (this.started || this.closed) return;
    this.started = this.clock.now();
    this.tick();
  }

  /** Says the samples; resolves when the last packet of them went out. */
  async speak(samples: Float32Array, sampleRate: number): Promise<SpeakResult> {
    if (this.closed) return { status: 'failed', reason: 'the call is over' };
    this.start();
    const asked = this.clock.now();
    const coded = encode(this.options.codec, toPcm8k(samples, sampleRate));
    const frames: Frame[] = [];
    for (let offset = 0; offset < coded.length; offset += SAMPLES_PER_PACKET) {
      const payload = new Uint8Array(SAMPLES_PER_PACKET).fill(this.silence());
      payload.set(coded.subarray(offset, offset + SAMPLES_PER_PACKET));
      frames.push({ payload });
    }
    if (!frames.length) return { status: 'spoken', latencyMs: 0, durationMs: 0 };
    let firstAt: number | undefined;
    const done = new Promise<void>((resolve) => {
      frames[0].sent = () => (firstAt = this.clock.now());
      const last = frames[frames.length - 1];
      const previous = last.sent;
      last.sent = () => {
        previous?.();
        resolve();
      };
    });
    this.queue.push(...frames);
    await Promise.race([done, this.closing]);
    if (this.closed && firstAt === undefined) return { status: 'failed', reason: 'the call is over' };
    return { status: 'spoken', latencyMs: (firstAt ?? asked) - asked, durationMs: frames.length * PACKET_MS };
  }

  /** Presses keys in the call as telephone events; false when the panel did not offer them (SIP INFO is the way then). */
  async sendDtmf(digits: string): Promise<boolean> {
    const pt = this.options.dtmfPayloadType;
    if (pt === undefined) return false;
    this.start();
    const frames: Frame[] = [];
    for (const digit of digits.toUpperCase()) {
      const code = DTMF_EVENTS.indexOf(digit);
      if (code < 0) continue;
      for (let i = 1; i <= DTMF_PACKETS + DTMF_END_PACKETS; i++) {
        const end = i > DTMF_PACKETS;
        const duration = Math.min(i, DTMF_PACKETS) * SAMPLES_PER_PACKET;
        const payload = new Uint8Array(4);
        payload[0] = code;
        payload[1] = (end ? 0x80 : 0) | 10; // volume -10 dBm0
        payload[2] = duration >> 8;
        payload[3] = duration & 0xff;
        frames.push({ payload, event: { marker: i === 1, end } });
      }
      for (let i = 0; i < DTMF_GAP_PACKETS; i++) frames.push({ payload: new Uint8Array(SAMPLES_PER_PACKET).fill(this.silence()) });
    }
    if (!frames.length) return true;
    const done = new Promise<void>((resolve) => (frames[frames.length - 1].sent = resolve));
    this.queue.push(...frames);
    await Promise.race([done, this.closing]);
    return !this.closed;
  }

  private resolveClosing: () => void = () => undefined;
  private readonly closing = new Promise<void>((resolve) => (this.resolveClosing = resolve));

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clock.clearTimeout(this.timer);
    this.queue = [];
    this.resolveClosing();
    this.audioListeners.clear();
    this.dtmfListeners.clear();
    try {
      this.socket.close();
    } catch {
      // closed already
    }
  }

  private silence(): number {
    return this.options.codec === 'PCMA' ? ALAW_SILENCE : ULAW_SILENCE;
  }

  /** Sends what is due: packet n leaves at start + n·20 ms, so a late timer does not add up to drift. */
  private tick(): void {
    if (this.closed) return;
    const due = Math.floor((this.clock.now() - this.started) / PACKET_MS) + 1;
    // after a long stall (a busy event loop) the missed packets are not sent in a burst
    if (due - this.sentFrames > 5) this.sentFrames = due - 1;
    while (this.sentFrames < due) {
      this.sendFrame(this.queue.shift());
      this.sentFrames++;
    }
    this.timer = this.clock.setTimeout(() => this.tick(), Math.max(0, this.started + this.sentFrames * PACKET_MS - this.clock.now()));
  }

  private eventTimestamp: number | undefined;

  private sendFrame(frame: Frame | undefined): void {
    const packet = Buffer.alloc(12 + (frame?.payload.length ?? SAMPLES_PER_PACKET));
    packet[0] = 0x80;
    let advance = SAMPLES_PER_PACKET;
    if (frame?.event) {
      if (frame.event.marker || this.eventTimestamp === undefined) this.eventTimestamp = this.timestamp;
      packet[1] = (frame.event.marker ? 0x80 : 0) | this.options.dtmfPayloadType!;
      packet.writeUInt32BE(this.eventTimestamp >>> 0, 4);
      // the media clock goes on while a key is held (the end packets repeat its last duration): the audio after it
      // starts where the event ended
      advance = frame.event.end ? 0 : SAMPLES_PER_PACKET;
      this.talking = false;
    } else {
      this.eventTimestamp = undefined;
      const speech = frame !== undefined;
      // a marker on the first packet of a talk spurt (RFC 3551 4.1)
      packet[1] = (speech && !this.talking ? 0x80 : 0) | this.options.payloadType;
      this.talking = speech;
      packet.writeUInt32BE(this.timestamp >>> 0, 4);
    }
    packet.writeUInt16BE(this.sequence, 2);
    packet.writeUInt32BE(this.ssrc >>> 0, 8);
    if (frame) packet.set(frame.payload, 12);
    else packet.fill(this.silence(), 12);
    this.sequence = (this.sequence + 1) & 0xffff;
    this.timestamp = (this.timestamp + advance) >>> 0;
    // nowhere to send yet (an INVITE without an offer and an ACK without an answer): the frame is dropped
    if (this.remote.port > 0)
      this.socket.send(packet, this.remote.port, this.remote.address, (error) => {
        if (error && !this.closed) this.log(`RTP to ${this.remote.address}:${this.remote.port}: ${error.message}`);
      });
    frame?.sent?.();
  }

  private onPacket(packet: Buffer, from: { address: string; port: number }): void {
    if (this.closed || from.address !== this.options.panelHost) return;
    const rtp = parseRtp(packet);
    if (!rtp) return;
    // symmetric RTP: the sound goes back where the panel's sound comes from
    if (!this.latched) {
      this.latched = true;
      if (from.port !== this.remote.port || from.address !== this.remote.address) this.remote = { address: from.address, port: from.port };
    }
    this.received++;
    if (rtp.payloadType === this.options.dtmfPayloadType) {
      if (rtp.payload.length < 4) return;
      const ended = Boolean(rtp.payload[1] & 0x80);
      if (!ended || this.lastEvent === rtp.timestamp) return;
      this.lastEvent = rtp.timestamp;
      const digit = DTMF_EVENTS[rtp.payload[0]];
      if (digit) for (const listener of this.dtmfListeners) listener(digit);
      return;
    }
    if (rtp.payloadType !== this.options.payloadType) return;
    const samples = decodeTo16k(this.options.codec, rtp.payload, this.lastSample);
    for (const listener of this.audioListeners) listener(samples);
  }
}
