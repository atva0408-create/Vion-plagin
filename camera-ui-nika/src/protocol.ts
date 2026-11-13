/**
 * The link between VION and NIKA, version 1. NIKA's side is core/vion_link.py in the NIKA repository; both follow this.
 *
 * Finding: NIKA announces itself by mDNS/DNS-SD as `_vion-nika._tcp.local` (TXT id, name, room, ver, proto). VION looks
 * for it and connects: NIKA is the one that listens, so a NIKA that moves to another address is found again by its id.
 *
 * Wire: TCP, one JSON object per line (UTF-8, `\n`), a line at most MAX_LINE bytes.
 *
 * Opening, in plain lines:
 *   NIKA → {t:'hello', proto, id, name, room, ver, lang, tz, nonce: n1}
 *   pairing (first time):  VION → {t:'pair', vion, name}       NIKA says a code aloud → {t:'code_said', digits}
 *                          VION → {t:'code', code}             → {t:'code_wrong', left} | {t:'paired', token}
 *   then, or when paired:  VION → {t:'auth', vion, nonce: n2, proof: mac(token, 'vion|n1|n2')}
 *                          NIKA → {t:'welcome', proof: mac(token, 'nika|n1|n2')} | {t:'refused', reason}
 * Each side proves it holds the token without sending it: a device that announces itself as this NIKA without the token
 * is refused by VION, and a VION without it by NIKA. The token travels once, in the `paired` line; the code NIKA said
 * aloud is what proves that line goes to the VION of the person standing next to her.
 *
 * Session, in frames {seq, body, mac}: body is the JSON text of a message, seq counts from 1 in each direction,
 * mac = mac(key, dir|seq|body) with key = mac(token, 'session|n1|n2') and dir 'v' from VION, 'n' from NIKA. A frame out of
 * order or with a wrong mac ends the connection: nothing on the way can change, replay or add a message.
 *
 * Messages of the session:
 *   VION → NIKA  offer {commands: [{name, description, parameters, grant}]}  what NIKA may ask VION to do
 *                notify {id, title, body?, text, severity, tag?} → ack {id, ok, error?}  a notice of VION to say: `text`
 *                say {id, text} → ack {id, ok, error?}
 *                result {id, ok, text?, data?, error?, pending?}  the answer to a call
 *                decided {request, approved, text}  a call that waited for a parent's confirmation was answered
 *                unpair {}  VION forgets NIKA: NIKA forgets the token too
 *   NIKA → VION  call {id, name, args, speaker?}
 *                forgot {}  NIKA was disconnected from this VION on her side (she forgot the token)
 *   both         ping {} → pong {}
 * A message of a type a side does not know is left unanswered, so either side can learn new messages first.
 */
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

export const PROTOCOL = 1;
export const SERVICE = 'vion-nika';
export const SERVICE_NAME = `_${SERVICE}._tcp.local`;
export const DEFAULT_PORT = 8796;
export const MAX_LINE = 256 * 1024;
export const CODE_DIGITS = 6;

export type Message = Record<string, unknown> & { t: string };

/** A field of a message that should be text: the text, a number as text, anything else empty. */
export function str(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

export function newNonce(): string {
  return randomBytes(16).toString('hex');
}

export function newToken(): string {
  return randomBytes(32).toString('hex');
}

/** A code of CODE_DIGITS digits, leading zeros kept. */
export function newCode(): string {
  return String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0');
}

export function mac(key: string, text: string): string {
  return createHmac('sha256', Buffer.from(key, 'utf8')).update(text, 'utf8').digest('hex');
}

export function sameMac(a: unknown, b: string): boolean {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export interface Proofs {
  vion: string;
  nika: string;
  session: string;
}

export function proofs(token: string, nikaNonce: string, vionNonce: string): Proofs {
  return {
    vion: mac(token, `vion|${nikaNonce}|${vionNonce}`),
    nika: mac(token, `nika|${nikaNonce}|${vionNonce}`),
    session: mac(token, `session|${nikaNonce}|${vionNonce}`),
  };
}

export type Direction = 'v' | 'n';

/** Frames one side sends and checks the frames of the other. */
export class Framer {
  private sent = 0;
  private received = 0;

  constructor(
    private readonly key: string,
    private readonly own: Direction,
  ) {}

  frame(message: Message): string {
    this.sent += 1;
    const body = JSON.stringify(message);
    return JSON.stringify({ seq: this.sent, body, mac: mac(this.key, `${this.own}|${this.sent}|${body}`) });
  }

  /** The message of a frame of the other side; throws on a frame out of order or not made with the key. */
  open(frame: unknown): Message {
    const { seq, body, mac: given } = (frame ?? {}) as { seq?: unknown; body?: unknown; mac?: unknown };
    const other: Direction = this.own === 'v' ? 'n' : 'v';
    if (seq !== this.received + 1 || typeof body !== 'string') throw new Error('a frame out of order');
    if (!sameMac(given, mac(this.key, `${other}|${seq}|${body}`))) throw new Error('a frame not made with the key of this link');
    this.received = seq;
    const message = JSON.parse(body) as Message;
    if (!message || typeof message.t !== 'string') throw new Error('a frame without a message type');
    return message;
  }
}

/** Splits a stream of bytes into lines; too long a line is an error (a peer that is not NIKA, or a broken one). */
export class LineReader {
  private buffer = '';
  // a chunk may end inside a letter of several bytes: the decoder keeps its first bytes for the next chunk
  private decoder = new StringDecoder('utf8');

  constructor(private readonly max = MAX_LINE) {}

  push(chunk: Buffer | string): string[] {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    if ([this.buffer, ...lines].some((line) => Buffer.byteLength(line, 'utf8') > this.max)) throw new Error(`a line longer than ${this.max} bytes`);
    return lines.map((line) => line.replace(/\r$/, '')).filter((line) => line.length > 0);
  }
}
