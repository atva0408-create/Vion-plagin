/**
 * SIP for a panel that calls ViON directly by IP (ТЗ 14.10): a user agent that takes calls, over UDP, only from the
 * addresses of the panels in the settings. An INVITE rings ViON; ViON answers it with G.711 when the agent or a person
 * takes the call, ends it with BYE (or turns it away while it rings), and hears the keys pressed as RFC 4733 events or
 * SIP INFO. No registration on a SIP server, no TCP, no TLS: a panel on the home network calls straight in.
 *
 * Only what such a call needs of RFC 3261: the INVITE server transaction (100, 180, the final answer resent until the
 * ACK), CANCEL, BYE both ways, INFO, OPTIONS, a re-INVITE answered with the same session.
 */
import { randomBytes, randomInt } from 'node:crypto';
import { createSocket } from 'node:dgram';

import { systemClock } from '@vionvision/speech';

import { chooseAudio, describeAudio, header, headers, hostOf, infoDigit, parseCSeq, parseSdp, parseSip, parseVia, serializeSip, textParam, uriOf } from './message.js';
import { RtpAudio } from './rtp.js';

import type { Socket } from 'node:dgram';
import type { Clock } from '@vionvision/speech';
import type { AudioChoice, SipMessage } from './message.js';

export type SipEnd = 'cancel' | 'bye' | 'local' | 'timeout';

export interface SipCallHandler {
  /** a call came: ring ViON */
  ring(call: SipCall): void;
  ended(call: SipCall, why: SipEnd): void;
  /** a key pressed at the panel during the call */
  dtmf(call: SipCall, digit: string): void;
  /** the panel sent anything at all: it is there */
  seen(): void;
}

export interface SipServerOptions {
  port: number;
  clock?: Clock;
  log?: (message: string) => void;
  /** RFC 3261 T1 (500 ms); the tests make it short */
  t1Ms?: number;
  /** the address of this server as the panel reaches it; by default the one the system would send from */
  localAddress?: (panelHost: string) => Promise<string>;
}

const USER_AGENT = 'ViON intercom';
const ALLOW = 'INVITE, ACK, CANCEL, BYE, OPTIONS, INFO, NOTIFY';
const T2_MS = 4_000;

/** The address of this machine that a packet to the host would leave from. */
export function localAddressFor(host: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    const done = (address: string) => {
      try {
        socket.close();
      } catch {
        // closed already
      }
      resolve(address);
    };
    socket.on('error', () => done('0.0.0.0'));
    // a connected UDP socket sends nothing: it only picks the route
    socket.connect(9, host, () => done(socket.address().address));
  });
}

const token = () => randomBytes(8).toString('hex');

export class SipServer {
  private socket: Socket | undefined;
  private readonly peers = new Map<string, SipCallHandler>();
  private readonly calls = new Map<string, SipCall>();
  readonly clock: Clock;
  readonly t1: number;
  private readonly logFn: (message: string) => void;

  constructor(private readonly options: SipServerOptions) {
    this.clock = options.clock ?? systemClock;
    this.t1 = options.t1Ms ?? 500;
    this.logFn = options.log ?? (() => undefined);
  }

  get port(): number {
    return this.socket?.address().port ?? this.options.port;
  }

  get running(): boolean {
    return Boolean(this.socket);
  }

  async start(): Promise<void> {
    if (this.socket) return;
    const socket = createSocket('udp4');
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(this.options.port, () => {
        socket.off('error', reject);
        resolve();
      });
    });
    socket.on('error', (error) => this.log(`SIP: ${error.message}`));
    socket.on('message', (data, from) => this.onMessage(data, from));
    this.socket = socket;
  }

  async stop(): Promise<void> {
    // the BYE goes out once; nobody waits for its answer with the server going
    for (const call of this.calls.values()) void call.hangUp().catch(() => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    const socket = this.socket;
    this.socket = undefined;
    if (socket) await new Promise<void>((resolve) => socket.close(() => resolve()));
  }

  /** Takes calls from the panel at this address; returns the way to stop. */
  peer(host: string, handler: SipCallHandler): () => void {
    this.peers.set(host, handler);
    return () => {
      if (this.peers.get(host) !== handler) return;
      this.peers.delete(host);
      for (const call of this.calls.values()) if (call.remoteHost === host) void call.hangUp();
    };
  }

  log(message: string): void {
    this.logFn(message);
  }

  localAddress(host: string): Promise<string> {
    return (this.options.localAddress ?? localAddressFor)(host);
  }

  send(message: SipMessage | Buffer, address: string, port: number): void {
    const data = Buffer.isBuffer(message) ? message : serializeSip(message);
    this.socket?.send(data, port, address, (error) => {
      if (error) this.log(`SIP to ${address}:${port}: ${error.message}`);
    });
  }

  forget(call: SipCall): void {
    if (this.calls.get(call.callId) === call) this.calls.delete(call.callId);
  }

  private onMessage(data: Buffer, from: { address: string; port: number }): void {
    // anything not from a panel of the settings gets no answer at all: nothing to learn about this server
    const handler = this.peers.get(from.address);
    if (!handler) return;
    const message = parseSip(data);
    if (!message) return;
    handler.seen();
    const callId = header(message, 'Call-ID');
    if (message.status !== undefined) {
      const answered = callId ? this.calls.get(callId) : undefined;
      if (answered?.remoteHost === from.address) answered.onResponse(message);
      return;
    }
    const method = message.method!;
    // a call takes requests only from its own panel: another panel cannot end it or press keys in it
    const found = callId ? this.calls.get(callId) : undefined;
    const call = found?.remoteHost === from.address ? found : undefined;
    if (found && !call) {
      this.send(response(message, from, 481, 'Call/Transaction Does Not Exist'), ...replyTo(message, from));
      return;
    }
    if (call) {
      call.onRequest(message, from);
      return;
    }
    switch (method) {
      case 'INVITE':
        this.invite(message, from, handler);
        return;
      case 'ACK':
        return; // of a call that is gone
      case 'OPTIONS':
      case 'NOTIFY':
        this.send(response(message, from, 200, 'OK', [['Allow', ALLOW]]), ...replyTo(message, from));
        return;
      case 'REGISTER': {
        // a panel set to register with ViON as its server: let it, so it calls in; nobody else may
        const contact = header(message, 'Contact');
        const expires = header(message, 'Expires') ?? textParam(contact, 'expires') ?? '3600';
        const extra: [string, string][] = contact ? [['Contact', contact.includes('expires=') ? contact : `${contact};expires=${expires}`]] : [];
        this.send(response(message, from, 200, 'OK', [...extra, ['Expires', expires]]), ...replyTo(message, from));
        return;
      }
      case 'BYE':
      case 'CANCEL':
      case 'INFO':
        this.send(response(message, from, 481, 'Call/Transaction Does Not Exist'), ...replyTo(message, from));
        return;
      default:
        this.send(response(message, from, 405, 'Method Not Allowed', [['Allow', ALLOW]]), ...replyTo(message, from));
    }
  }

  private invite(message: SipMessage, from: { address: string; port: number }, handler: SipCallHandler): void {
    const callId = header(message, 'Call-ID');
    if (!callId || !header(message, 'From') || !header(message, 'To') || !parseCSeq(header(message, 'CSeq'))) {
      this.send(response(message, from, 400, 'Bad Request'), ...replyTo(message, from));
      return;
    }
    const required = header(message, 'Require');
    if (required) {
      this.send(response(message, from, 420, 'Bad Extension', [['Unsupported', required]]), ...replyTo(message, from));
      return;
    }
    // an ended call stays a while for the ACK of its last answer; it does not make the panel busy
    if ([...this.calls.values()].some((call) => call.remoteHost === from.address && call.state !== 'ended')) {
      this.send(response(message, from, 486, 'Busy Here'), ...replyTo(message, from));
      return;
    }
    const offer = message.body ? parseSdp(message.body) : undefined;
    const choice = offer ? chooseAudio(offer) : undefined;
    if (message.body && (!offer || !choice)) {
      this.send(response(message, from, 488, 'Not Acceptable Here'), ...replyTo(message, from));
      return;
    }
    const call = new SipCall(this, message, from, handler, offer && choice ? { offer: { address: offer.address || from.address, port: offer.port }, choice } : undefined);
    this.calls.set(callId, call);
    void call.ringing();
    handler.ring(call);
  }
}

/** Where a response goes: back to the address the request came from, at its port when it asked for rport. */
function replyTo(request: SipMessage, from: { address: string; port: number }): [string, number] {
  const via = parseVia(headers(request, 'Via')[0] ?? '');
  return [from.address, via?.rport ? from.port : (via?.port ?? 5060)];
}

/** A response to the request: its Via, From, To, Call-ID and CSeq copied, the top Via told where it came from. */
function response(
  request: SipMessage,
  from: { address: string; port: number },
  status: number,
  reason: string,
  extra: [string, string][] = [],
  toTag?: string,
  body = '',
): SipMessage {
  const vias = headers(request, 'Via');
  const out: [string, string][] = vias.map((via, index) => {
    if (index > 0) return ['Via', via];
    let top = via.replace(/;rport(?=;|$)/i, `;rport=${from.port}`);
    const parsed = parseVia(via);
    if (parsed && parsed.host !== from.address && !/;received=/i.test(top)) top += `;received=${from.address}`;
    return ['Via', top];
  });
  const to = header(request, 'To') ?? '';
  out.push(['From', header(request, 'From') ?? '']);
  out.push(['To', toTag && !textParam(to, 'tag') ? `${to};tag=${toTag}` : to]);
  out.push(['Call-ID', header(request, 'Call-ID') ?? '']);
  out.push(['CSeq', header(request, 'CSeq') ?? '']);
  out.push(['User-Agent', USER_AGENT]);
  out.push(...extra);
  return { status, reason, headers: out, body };
}

type CallState = 'ringing' | 'accepting' | 'answered' | 'ended';

interface ClientTransaction {
  branch: string;
  done: (status: number | undefined) => void;
  timer: unknown;
}

/** One call from a panel. */
export class SipCall {
  readonly callId: string;
  readonly remoteHost: string;
  /** who called, as the panel names itself (its display name or number) */
  readonly caller: string;
  state: CallState = 'ringing';
  rtp: RtpAudio | undefined;
  private readonly localTag = token();
  private finalResponse: Buffer | undefined;
  private provisional: Buffer | undefined;
  private resend: unknown;
  private resendGiveUp: unknown;
  private accepted: Promise<void> | undefined;
  private ackWaiters: { resolve: () => void; reject: (error: Error) => void }[] = [];
  private localSeq = randomInt(1, 10_000);
  private resolveOver: (why: SipEnd) => void = () => undefined;
  /** resolves with why, when the call ends */
  readonly over = new Promise<SipEnd>((resolve) => (this.resolveOver = resolve));
  private transactions = new Map<string, ClientTransaction>();
  private local: { address: string } | undefined;
  private endedWhy: SipEnd | undefined;

  constructor(
    private readonly server: SipServer,
    private readonly invite: SipMessage,
    private readonly from: { address: string; port: number },
    private readonly handler: SipCallHandler,
    private media: { offer: { address: string; port: number }; choice: AudioChoice } | undefined,
  ) {
    this.callId = header(invite, 'Call-ID')!;
    this.remoteHost = from.address;
    const caller = header(invite, 'From') ?? '';
    this.caller = /^\s*"([^"]+)"/.exec(caller)?.[1] ?? hostOf(uriOf(caller))?.user ?? '';
  }

  get endReason(): SipEnd | undefined {
    return this.endedWhy;
  }

  /** 100 Trying, then 180 Ringing: the panel plays its ring-back tone. */
  async ringing(): Promise<void> {
    this.provisional = serializeSip(response(this.invite, this.from, 100, 'Trying'));
    this.server.send(this.provisional, ...replyTo(this.invite, this.from));
    // the 180 starts the dialog and names where the panel reaches ViON: the address it routes to
    const address = await this.localAddress();
    if (this.state !== 'ringing' || this.finalResponse) return;
    this.provisional = serializeSip(response(this.invite, this.from, 180, 'Ringing', [['Contact', this.contact(address)]], this.localTag));
    this.server.send(this.provisional, ...replyTo(this.invite, this.from));
  }

  /**
   * Answers with 200 OK and the session (G.711), resent until the panel's ACK; the sound starts then. Resolves when
   * the call is up; again and again the same once it is.
   */
  accept(): Promise<void> {
    if (this.state === 'ended') return Promise.reject(new Error('the call is over'));
    this.accepted ??= this.doAccept();
    return this.accepted;
  }

  private async doAccept(): Promise<void> {
    const address = await this.localAddress();
    if (this.state !== 'ringing') throw new Error('the call is over');
    const choice = this.media?.choice ?? { payloadType: 8, codec: 'PCMA' as const, dtmfPayloadType: 101 };
    this.rtp = await RtpAudio.open({
      codec: choice.codec,
      payloadType: choice.payloadType,
      dtmfPayloadType: choice.dtmfPayloadType,
      remote: this.media?.offer ?? { address: this.remoteHost, port: 0 },
      panelHost: this.remoteHost,
      clock: this.server.clock,
      log: (message) => this.server.log(message),
    });
    if (this.state !== 'ringing') {
      this.rtp.close();
      throw new Error('the call is over');
    }
    this.rtp.onDtmf((digit) => this.handler.dtmf(this, digit));
    this.state = 'accepting';
    // to an INVITE without an offer the 200 carries the offer, the ACK the answer
    const sdp = describeAudio({ address, port: this.rtp.port, sessionId: randomInt(1, 1_000_000_000), choice: this.media?.choice });
    this.finalResponse = serializeSip(
      response(
        this.invite,
        this.from,
        200,
        'OK',
        [
          ['Contact', this.contact(address)],
          ['Allow', ALLOW],
          ['Content-Type', 'application/sdp'],
        ],
        this.localTag,
        sdp,
      ),
    );
    const acked = new Promise<void>((resolve, reject) => this.ackWaiters.push({ resolve, reject }));
    this.sendFinalUntilAck(true);
    await acked;
  }

  /** Turns the call away while it rings (486 Busy Here, 603 Decline). */
  reject(status = 486, reason = 'Busy Here'): void {
    if (this.state !== 'ringing') return;
    this.finalResponse = serializeSip(response(this.invite, this.from, status, reason, [], this.localTag));
    this.sendFinalUntilAck(false);
    this.end('local');
  }

  /** Ends the call from ViON's side: BYE once it is up, a "busy" while it rings. */
  async hangUp(): Promise<void> {
    if (this.state === 'ended') return;
    if (this.state === 'ringing') {
      this.reject();
      return;
    }
    const wasAccepting = this.state === 'accepting';
    this.end('local');
    // a BYE before the ACK is allowed for a 2xx sent (RFC 3261 15)
    await this.request('BYE', [], '', wasAccepting);
  }

  /** Presses keys in the call: as telephone events when the panel offered them, else as SIP INFO, one per key. */
  async dtmf(digits: string): Promise<boolean> {
    if (this.state !== 'answered' && this.state !== 'accepting') return false;
    if (await this.rtp?.sendDtmf(digits)) return true;
    for (const digit of digits) {
      const status = await this.request('INFO', [['Content-Type', 'application/dtmf-relay']], `Signal=${digit}\r\nDuration=250\r\n`);
      if (status === undefined || status >= 300) return false;
    }
    return true;
  }

  onRequest(message: SipMessage, from: { address: string; port: number }): void {
    switch (message.method) {
      case 'INVITE': {
        const toTag = textParam(header(message, 'To'), 'tag');
        if (!toTag) {
          // the INVITE again: the panel did not hear the answer
          const last = this.finalResponse ?? this.provisional;
          if (last) this.server.send(last, ...replyTo(message, from));
          return;
        }
        // a re-INVITE (hold, a session refresh): the same session again
        if (this.state !== 'answered' || !this.rtp) {
          this.server.send(response(message, from, 491, 'Request Pending', [], undefined), ...replyTo(message, from));
          return;
        }
        void this.localAddress().then((address) => {
          const sdp = describeAudio({ address, port: this.rtp!.port, sessionId: randomInt(1, 1_000_000_000), choice: this.media?.choice });
          this.server.send(
            response(
              message,
              from,
              200,
              'OK',
              [
                ['Contact', this.contact(address)],
                ['Content-Type', 'application/sdp'],
              ],
              undefined,
              sdp,
            ),
            ...replyTo(message, from),
          );
        });
        return;
      }
      case 'ACK':
        this.onAck(message);
        return;
      case 'CANCEL':
        this.server.send(response(message, from, 200, 'OK', [], this.localTag), ...replyTo(message, from));
        if (this.state === 'ringing' || (this.state === 'accepting' && !this.finalResponse)) {
          this.finalResponse = serializeSip(response(this.invite, this.from, 487, 'Request Terminated', [], this.localTag));
          this.sendFinalUntilAck(false);
          this.end('cancel');
        }
        return;
      case 'BYE':
        this.server.send(response(message, from, 200, 'OK'), ...replyTo(message, from));
        this.end('bye');
        return;
      case 'INFO': {
        this.server.send(response(message, from, 200, 'OK'), ...replyTo(message, from));
        const digit = infoDigit(message);
        if (digit && this.state !== 'ended') this.handler.dtmf(this, digit);
        return;
      }
      case 'OPTIONS':
      case 'NOTIFY':
        this.server.send(response(message, from, 200, 'OK', [['Allow', ALLOW]]), ...replyTo(message, from));
        return;
      default:
        this.server.send(response(message, from, 405, 'Method Not Allowed', [['Allow', ALLOW]]), ...replyTo(message, from));
    }
  }

  onResponse(message: SipMessage): void {
    const branch = parseVia(headers(message, 'Via')[0] ?? '')?.branch;
    const transaction = branch ? this.transactions.get(branch) : undefined;
    if (!transaction || message.status! < 200) return;
    this.transactions.delete(branch!);
    this.server.clock.clearTimeout(transaction.timer);
    transaction.done(message.status);
  }

  private onAck(message: SipMessage): void {
    this.server.clock.clearTimeout(this.resend);
    this.server.clock.clearTimeout(this.resendGiveUp);
    if (this.state !== 'accepting') return;
    // an INVITE without an offer: the ACK has the answer
    if (!this.media && message.body) {
      const answer = parseSdp(message.body);
      const choice = answer ? chooseAudio(answer) : undefined;
      if (answer && choice) this.media = { offer: { address: answer.address || this.remoteHost, port: answer.port }, choice };
    }
    this.state = 'answered';
    this.rtp?.retarget(this.media?.offer);
    this.rtp?.start();
    for (const waiter of this.ackWaiters.splice(0)) waiter.resolve();
  }

  /** The final response again and again (T1, 2·T1, … up to T2) until the ACK, for 64·T1 at most. */
  private sendFinalUntilAck(success: boolean): void {
    const clock = this.server.clock;
    let interval = this.server.t1;
    const again = () => {
      if (!this.finalResponse) return;
      this.server.send(this.finalResponse, ...replyTo(this.invite, this.from));
      interval = Math.min(interval * 2, T2_MS);
      this.resend = clock.setTimeout(again, interval);
    };
    clock.clearTimeout(this.resend);
    clock.clearTimeout(this.resendGiveUp);
    again();
    this.resendGiveUp = clock.setTimeout(() => {
      clock.clearTimeout(this.resend);
      if (!success || this.state !== 'accepting') return;
      // answered, but the panel never confirmed: it does not have the call
      this.server.log(`SIP: no ACK from ${this.remoteHost} for the answer of ${this.callId}`);
      for (const waiter of this.ackWaiters.splice(0)) waiter.reject(new Error('the panel did not confirm the answer'));
      this.end('timeout');
      void this.request('BYE', [], '', true);
    }, 64 * this.server.t1);
  }

  /** A request of ours in the call (BYE, INFO), resent until a final answer; its status, undefined when none came. */
  private async request(method: 'BYE' | 'INFO', extra: [string, string][], body: string, force = false): Promise<number | undefined> {
    if (this.state === 'ended' && !force && method !== 'BYE') return undefined;
    const address = await this.localAddress();
    const branch = `z9hG4bK${token()}`;
    const contact = header(this.invite, 'Contact');
    const target = contact ? uriOf(contact) : `sip:${this.remoteHost}`;
    const targetHost = hostOf(target);
    // the panel names its own address in Contact; one that names another host is not followed (only the panel is called)
    const port = targetHost?.host === this.remoteHost ? (targetHost.port ?? 5060) : this.from.port;
    this.localSeq++;
    const message: SipMessage = {
      method,
      uri: target,
      headers: [
        ['Via', `SIP/2.0/UDP ${address}:${this.server.port};branch=${branch};rport`],
        ['Max-Forwards', '70'],
        ['From', this.withTag(header(this.invite, 'To') ?? '')],
        ['To', header(this.invite, 'From') ?? ''],
        ['Call-ID', this.callId],
        ['CSeq', `${this.localSeq} ${method}`],
        ['User-Agent', USER_AGENT],
        ...extra,
      ],
      body,
    };
    const data = serializeSip(message);
    return new Promise((resolve) => {
      const clock = this.server.clock;
      let interval = this.server.t1;
      const started = clock.now();
      const transaction: ClientTransaction = { branch, done: resolve, timer: undefined };
      const again = () => {
        if (clock.now() - started >= 64 * this.server.t1) {
          this.transactions.delete(branch);
          resolve(undefined);
          return;
        }
        this.server.send(data, this.remoteHost, port);
        transaction.timer = clock.setTimeout(again, interval);
        interval = Math.min(interval * 2, T2_MS);
      };
      this.transactions.set(branch, transaction);
      again();
    });
  }

  private end(why: SipEnd): void {
    if (this.state === 'ended') return;
    this.state = 'ended';
    this.endedWhy = why;
    this.rtp?.close();
    for (const waiter of this.ackWaiters.splice(0)) waiter.reject(new Error('the call is over'));
    // the final response may still be resent for its ACK; the call is gone for the server after that
    this.server.clock.setTimeout(() => {
      this.server.clock.clearTimeout(this.resend);
      for (const transaction of this.transactions.values()) {
        this.server.clock.clearTimeout(transaction.timer);
        transaction.done(undefined);
      }
      this.transactions.clear();
      this.server.forget(this);
    }, 64 * this.server.t1);
    this.resolveOver(why);
    this.handler.ended(this, why);
  }

  private withTag(value: string): string {
    return textParam(value, 'tag') ? value : `${value};tag=${this.localTag}`;
  }

  private contact(address: string): string {
    return `<sip:vion@${address}:${this.server.port}>`;
  }

  private async localAddress(): Promise<string> {
    this.local ??= { address: await this.server.localAddress(this.remoteHost) };
    return this.local.address;
  }
}
