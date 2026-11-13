import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';

import { Framer, LineReader, PROTOCOL, newNonce, proofs, sameMac, str } from './protocol.js';

import type { Socket } from 'node:net';
import type { Message } from './protocol.js';

/** What NIKA says of herself when a connection opens. */
export interface Hello {
  id: string;
  name: string;
  room: string;
  ver: string;
  lang: string;
  /** her time zone (IANA), for the clocks of the page */
  tz: string;
  nonce: string;
  proto: number;
}

/** A NIKA this VION is paired with, as kept in the plugin's storage. */
export interface PairedNika {
  id: string;
  name: string;
  room: string;
  token: string;
  /** the last address she answered at; the address given by hand when `manual` */
  host?: string;
  port?: number;
  manual?: boolean;
  /** NIKA says the notifications of VION (Settings → Notifications switches it) */
  speaks: boolean;
  /** the name given in Settings → Notifications, over what she calls herself */
  label?: string;
  pairedAt: number;
  lang?: string;
}

export interface Address {
  host: string;
  port: number;
}

/** What NIKA asked for, as she sent it. */
export interface Call {
  id: string;
  name: string;
  args: Record<string, unknown>;
  speaker?: string;
}

/** The answer to a call. `pending`: a parent is asked first, a `decided` follows. */
export interface CallResult {
  ok: boolean;
  text?: string;
  data?: unknown;
  error?: string;
  pending?: boolean;
}

export const CONNECT_TIMEOUT_MS = 10_000;
export const STEP_TIMEOUT_MS = 15_000;
export const PING_EVERY_MS = 30_000;
/** Nothing heard for this long: the connection is dead (a NIKA that lost power sends no close). */
export const SILENT_DEAD_MS = 75_000;
export const RETRY_MIN_MS = 2_000;
export const RETRY_MAX_MS = 60_000;
/** How long NIKA has to say the code and the person to enter it. */
export const PAIRING_TIMEOUT_MS = 5 * 60_000;

function helloOf(message: Message): Hello {
  if (message.t !== 'hello') throw new Error(`not NIKA: she opens with "${message.t}" instead of hello`);
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  const hello: Hello = {
    id: text(message.id),
    name: text(message.name) || 'NIKA',
    room: text(message.room),
    ver: text(message.ver),
    lang: text(message.lang) || 'ru',
    tz: text(message.tz),
    nonce: text(message.nonce),
    proto: Number(message.proto) || 0,
  };
  if (!hello.id || hello.nonce.length < 16) throw new Error('not NIKA: her hello has no id or nonce');
  if (hello.proto !== PROTOCOL) throw new Error(`NIKA speaks link version ${hello.proto}, this plugin ${PROTOCOL}: update the older one`);
  return hello;
}

/** One TCP connection: plain JSON lines while it opens, then frames of the session. */
export class Wire {
  private reader = new LineReader();
  private lines: string[] = [];
  private wake?: () => void;
  private framer?: Framer;
  private handler?: (message: Message) => void;
  private ended?: Error;
  private closeHandlers: ((error: Error) => void)[] = [];
  lastHeard = Date.now();

  private constructor(private readonly socket: Socket) {
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => {
      this.lastHeard = Date.now();
      try {
        this.lines.push(...this.reader.push(chunk));
      } catch (error) {
        this.close(error as Error);
        return;
      }
      this.pump();
    });
    socket.on('error', (error) => this.close(error));
    socket.on('close', () => this.close(new Error('the connection closed')));
  }

  static open(address: Address, timeoutMs = CONNECT_TIMEOUT_MS): Promise<Wire> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: address.host, port: address.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`no answer from ${address.host}:${address.port} in ${timeoutMs / 1000} s`));
      }, timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve(new Wire(socket));
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  get closed(): boolean {
    return !!this.ended;
  }

  onClose(handler: (error: Error) => void): void {
    if (this.ended) handler(this.ended);
    else this.closeHandlers.push(handler);
  }

  close(error: Error = new Error('closed')): void {
    if (this.ended) return;
    this.ended = error;
    this.socket.destroy();
    this.wake?.();
    for (const handler of this.closeHandlers.splice(0)) handler(error);
  }

  sendPlain(message: Message): void {
    if (this.ended) throw this.ended;
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  send(message: Message): void {
    if (this.ended) throw this.ended;
    if (!this.framer) throw new Error('the session is not open');
    this.socket.write(`${this.framer.frame(message)}\n`);
  }

  /** The next plain line, while the connection opens. */
  async next(timeoutMs = STEP_TIMEOUT_MS): Promise<Message> {
    const deadline = Date.now() + timeoutMs;
    while (!this.lines.length) {
      if (this.ended) throw this.ended;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`NIKA did not answer in ${timeoutMs / 1000} s`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = undefined;
    }
    const message = JSON.parse(this.lines.shift()!) as Message;
    if (!message || typeof message.t !== 'string') throw new Error('a line without a message type');
    return message;
  }

  /** From now on lines are frames of the session, given to `handler`. */
  openSession(framer: Framer, handler: (message: Message) => void): void {
    this.framer = framer;
    this.handler = handler;
    this.pump();
  }

  private pump(): void {
    if (!this.framer || !this.handler) {
      this.wake?.();
      return;
    }
    while (this.lines.length && !this.ended) {
      const line = this.lines.shift()!;
      let message: Message;
      try {
        message = this.framer.open(JSON.parse(line));
      } catch (error) {
        this.close(error as Error);
        return;
      }
      this.handler(message);
    }
  }
}

/** Proves this VION holds the token and checks NIKA does too; then the session is open. */
async function authenticate(wire: Wire, hello: Hello, vionId: string, token: string): Promise<Framer> {
  const vionNonce = newNonce();
  const proof = proofs(token, hello.nonce, vionNonce);
  wire.sendPlain({ t: 'auth', vion: vionId, nonce: vionNonce, proof: proof.vion });
  const answer = await wire.next();
  if (answer.t === 'refused') {
    const reason = str(answer.reason);
    throw new RefusedError(reason, reason === 'unknown' ? 'NIKA does not know this VION any more: connect her again' : `NIKA refused the key (${reason})`);
  }
  if (answer.t !== 'welcome') throw new Error(`NIKA answered "${answer.t}" to the key`);
  if (!sameMac(answer.proof, proof.nika)) {
    throw new RefusedError('impostor', 'the device at this address does not hold the key of this NIKA: another device in her place?');
  }
  return new Framer(proof.session, 'v');
}

export class RefusedError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The first connection to a NIKA: she says a code aloud, the person enters it here, and she gives the token. The
 * session it opens lasts until the code is entered right, given up on, or PAIRING_TIMEOUT_MS passes.
 */
export class Pairing {
  readonly startedAt = Date.now();
  private timer: NodeJS.Timeout;

  private constructor(
    private readonly wire: Wire,
    readonly hello: Hello,
    readonly address: Address,
  ) {
    this.timer = setTimeout(() => this.close(), PAIRING_TIMEOUT_MS);
    wire.onClose(() => clearTimeout(this.timer));
  }

  static async start(address: Address, vionId: string, vionName: string): Promise<Pairing> {
    const wire = await Wire.open(address);
    try {
      const hello = helloOf(await wire.next());
      wire.sendPlain({ t: 'pair', vion: vionId, name: vionName });
      const answer = await wire.next(30_000);
      if (answer.t === 'refused') throw new RefusedError(str(answer.reason), refusalText(str(answer.reason)));
      if (answer.t !== 'code_said') throw new Error(`NIKA answered "${answer.t}" to the pairing`);
      return new Pairing(wire, hello, address);
    } catch (error) {
      wire.close();
      throw error;
    }
  }

  get open(): boolean {
    return !this.wire.closed;
  }

  /** The code the person entered: the token, or how many tries are left. */
  async submit(code: string): Promise<{ token: string } | { left: number }> {
    this.wire.sendPlain({ t: 'code', code: code.replace(/\D/g, '') });
    const answer = await this.wire.next();
    if (answer.t === 'paired' && typeof answer.token === 'string' && answer.token.length >= 32) {
      this.close();
      return { token: answer.token };
    }
    if (answer.t === 'code_wrong') {
      const left = Math.max(0, Number(answer.left) || 0);
      if (!left) this.close();
      return { left };
    }
    if (answer.t === 'refused') {
      this.close();
      throw new RefusedError(str(answer.reason), refusalText(str(answer.reason)));
    }
    throw new Error(`NIKA answered "${answer.t}" to the code`);
  }

  close(): void {
    clearTimeout(this.timer);
    this.wire.close();
  }
}

function refusalText(reason: string): string {
  switch (reason) {
    case 'expired':
      return 'the code is too old: start connecting again';
    case 'busy':
      return 'NIKA is connecting to another VION now: try again in a few minutes';
    case 'no_voice':
      return 'NIKA cannot say the code (her voice is off)';
    default:
      return `NIKA refused (${reason || 'no reason given'})`;
  }
}

export interface LinkHost {
  vionId: string;
  log(message: string): void;
  /** where to find her now: the network search, else the last address */
  address(nika: PairedNika): Promise<Address | undefined>;
  /** what NIKA may ask for, sent when the session opens and again when it changes */
  offer(link: NikaLink): Message;
  onCall(link: NikaLink, call: Call): Promise<CallResult>;
  /** she connected (with what she says of herself), or the connection ended */
  onChange(link: NikaLink): void;
  /** she said she forgot this VION: the token is gone on her side */
  onForgotten(link: NikaLink): void;
}

export type LinkState = 'connecting' | 'online' | 'offline' | 'stopped';

/** The lasting connection to one paired NIKA: reconnects by itself, finds her again when her address changes. */
export class NikaLink {
  state: LinkState = 'offline';
  lastError?: string;
  hello?: Hello;
  onlineSince?: number;
  private wire?: Wire;
  private stopped = false;
  private wakeRetry?: () => void;
  private pending = new Map<string, { resolve: (message: Message) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private ping?: NodeJS.Timeout;

  constructor(
    public nika: PairedNika,
    private readonly host: LinkHost,
  ) {}

  start(): void {
    void this.run();
  }

  stop(): void {
    this.stopped = true;
    this.state = 'stopped';
    this.wire?.close(new Error('stopped'));
    this.wakeRetry?.();
  }

  /** Try now instead of after the pause (a new address was heard, or a person pressed something). */
  retryNow(): void {
    this.wakeRetry?.();
  }

  get online(): boolean {
    return this.state === 'online';
  }

  send(message: Message): void {
    if (!this.wire || this.state !== 'online') throw new Error(`${this.nika.name} is not connected`);
    this.wire.send(message);
  }

  /** A message with an id and the `ack` NIKA answers it with. */
  request(message: Message, timeoutMs = 20_000): Promise<Message> {
    const id = typeof message.id === 'string' ? message.id : randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.nika.name} did not answer in ${timeoutMs / 1000} s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ ...message, id });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  private async run(): Promise<void> {
    let wait = RETRY_MIN_MS;
    while (!this.stopped) {
      this.state = 'connecting';
      try {
        const address = await this.host.address(this.nika);
        if (!address) throw new Error('not found on the network');
        await this.session(address);
        wait = RETRY_MIN_MS;
      } catch (error) {
        const text = (error as Error).message;
        if (text !== this.lastError && !this.stopped) this.host.log(`NIKA ${this.nika.name}: no connection: ${text}`);
        this.lastError = text;
        if (error instanceof RefusedError && error.reason === 'unknown') {
          // she was reset or forgot this VION: trying every minute would not change it
          this.state = 'offline';
          this.host.onForgotten(this);
          return;
        }
      }
      if (this.stopped) break;
      this.state = 'offline';
      this.host.onChange(this);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, wait + Math.random() * (wait / 2));
        this.wakeRetry = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wakeRetry = undefined;
      wait = Math.min(wait * 2, RETRY_MAX_MS);
    }
  }

  /** One connection, until it ends. */
  private async session(address: Address): Promise<void> {
    const wire = await Wire.open(address);
    this.wire = wire;
    try {
      const hello = helloOf(await wire.next());
      if (hello.id !== this.nika.id) throw new Error(`another NIKA answers at ${address.host}:${address.port} (${hello.name})`);
      const framer = await authenticate(wire, hello, this.host.vionId, this.nika.token);
      this.hello = hello;
      this.nika.host = address.host;
      this.nika.port = address.port;
      const closed = new Promise<Error>((resolve) => wire.onClose(resolve));
      wire.openSession(framer, (message) => this.onMessage(message));
      this.state = 'online';
      this.onlineSince = Date.now();
      this.lastError = undefined;
      this.host.log(`NIKA ${hello.name}${hello.room ? ` (${hello.room})` : ''}: connected at ${address.host}:${address.port}`);
      wire.send(this.host.offer(this));
      this.host.onChange(this);
      this.ping = setInterval(() => {
        if (Date.now() - wire.lastHeard > SILENT_DEAD_MS) wire.close(new Error(`nothing heard from her for ${SILENT_DEAD_MS / 1000} s`));
        else if (!wire.closed) wire.send({ t: 'ping' });
      }, PING_EVERY_MS);
      const error = await closed;
      if (!this.stopped) throw error;
    } finally {
      clearInterval(this.ping);
      this.ping = undefined;
      wire.close();
      this.wire = undefined;
      this.onlineSince = undefined;
      for (const [id, waiting] of this.pending) {
        clearTimeout(waiting.timer);
        waiting.reject(new Error(`${this.nika.name} disconnected`));
        this.pending.delete(id);
      }
    }
  }

  private onMessage(message: Message): void {
    switch (message.t) {
      case 'ping':
        this.wire?.send({ t: 'pong' });
        return;
      case 'pong':
        return;
      case 'ack': {
        const id = str(message.id);
        const waiting = this.pending.get(id);
        if (!waiting) return;
        clearTimeout(waiting.timer);
        this.pending.delete(id);
        waiting.resolve(message);
        return;
      }
      case 'call': {
        const call: Call = {
          id: str(message.id),
          name: str(message.name),
          args: message.args && typeof message.args === 'object' ? (message.args as Record<string, unknown>) : {},
          ...(typeof message.speaker === 'string' && message.speaker ? { speaker: message.speaker.slice(0, 60) } : {}),
        };
        void this.host
          .onCall(this, call)
          .catch((error: Error): CallResult => ({ ok: false, error: error.message }))
          .then((result) => {
            if (this.wire && !this.wire.closed) this.wire.send({ t: 'result', id: call.id, ...result });
          });
        return;
      }
      case 'forgot':
        this.host.log(`NIKA ${this.nika.name}: she was disconnected from this VION on her side`);
        this.stop();
        this.host.onForgotten(this);
        return;
      default:
        // a message of a newer NIKA: left unanswered
        return;
    }
  }
}
