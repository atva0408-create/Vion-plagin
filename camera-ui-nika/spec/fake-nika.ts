// A NIKA as the protocol describes her (her real side is core/vion_link.py of the NIKA repository): she listens on
// 127.0.0.1, says a hello, gives a token for the right code, checks the proof of VION and proves her own, and keeps what
// came in a session. The specs tell her to refuse, to lie about the token, to drop the connection.
import { createServer } from 'node:net';

import { Framer, LineReader, newCode, newNonce, newToken, proofs, sameMac } from '../src/protocol.js';

import type { Server, Socket } from 'node:net';
import type { Message } from '../src/protocol.js';

export interface FakeNikaOptions {
  id?: string;
  name?: string;
  room?: string;
  lang?: string;
  tz?: string;
  /** VION ids she knows and their tokens */
  tokens?: Map<string, string>;
  /** she claims to be paired but holds no real token: her proof is made with another one */
  impostor?: boolean;
  /** how many wrong codes she takes */
  tries?: number;
  /** how she answers notify and say: ok, or a reason */
  ackError?: string;
}

export class FakeNika {
  readonly id: string;
  readonly tokens: Map<string, string>;
  /** the code she «said» last */
  code?: string;
  /** messages of the sessions, in order */
  readonly got: Message[] = [];
  readonly sockets = new Set<Socket>();
  sessions = 0;
  private server: Server;
  private sessionSend?: (message: Message) => void;
  port = 0;

  constructor(private readonly options: FakeNikaOptions = {}) {
    this.id = options.id ?? 'nika-test-1';
    this.tokens = options.tokens ?? new Map();
    this.server = createServer((socket) => this.serve(socket));
  }

  listen(port = 0): Promise<number> {
    return new Promise((resolve) => this.server.listen(port, '127.0.0.1', () => resolve((this.port = (this.server.address() as { port: number }).port))));
  }

  close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  /** Ends every connection, as when her process restarts. */
  drop(): void {
    for (const socket of this.sockets) socket.destroy();
  }

  /** A message of the open session (a call, a ping). */
  send(message: Message): void {
    if (!this.sessionSend) throw new Error('no session');
    this.sessionSend(message);
  }

  get online(): boolean {
    return !!this.sessionSend;
  }

  private serve(socket: Socket): void {
    this.sockets.add(socket);
    const reader = new LineReader();
    const nonce = newNonce();
    let framer: Framer | undefined;
    let pairingWith: string | undefined;
    let tries = this.options.tries ?? 3;
    const plain = (message: Message) => socket.write(`${JSON.stringify(message)}\n`);
    socket.on('close', () => {
      this.sockets.delete(socket);
      if (framer) this.sessionSend = undefined;
    });
    socket.on('error', () => undefined);
    plain({ t: 'hello', proto: 1, id: this.id, name: this.options.name ?? 'Ника', room: this.options.room ?? 'Детская', ver: 'test', lang: this.options.lang ?? 'ru', tz: this.options.tz ?? 'Europe/Moscow', nonce });
    socket.on('data', (chunk: Buffer) => {
      for (const line of reader.push(chunk)) {
        if (framer) {
          let message: Message;
          try {
            message = framer.open(JSON.parse(line));
          } catch {
            socket.destroy();
            return;
          }
          this.got.push(message);
          if (message.t === 'ping') this.sessionSend?.({ t: 'pong' });
          if (message.t === 'notify' || message.t === 'say') {
            this.sessionSend?.({ t: 'ack', id: message.id, ok: !this.options.ackError, ...(this.options.ackError ? { error: this.options.ackError } : {}) });
          }
          if (message.t === 'unpair') {
            for (const [vion] of this.tokens) this.tokens.delete(vion);
            socket.destroy();
          }
          continue;
        }
        const message = JSON.parse(line) as Message;
        if (message.t === 'pair') {
          pairingWith = String(message.vion);
          this.code = newCode();
          plain({ t: 'code_said', digits: 6 });
        } else if (message.t === 'code') {
          if (!pairingWith) {
            plain({ t: 'refused', reason: 'no_pairing' });
          } else if (message.code === this.code) {
            const token = newToken();
            this.tokens.set(pairingWith, token);
            plain({ t: 'paired', token });
            pairingWith = undefined;
          } else {
            tries -= 1;
            plain({ t: 'code_wrong', left: tries });
            if (!tries) socket.end();
          }
        } else if (message.t === 'auth') {
          const token = this.tokens.get(String(message.vion));
          if (!token) {
            plain({ t: 'refused', reason: 'unknown' });
            socket.end();
            continue;
          }
          const proof = proofs(token, nonce, String(message.nonce));
          if (!sameMac(message.proof, proof.vion)) {
            plain({ t: 'refused', reason: 'bad_proof' });
            socket.end();
            continue;
          }
          const shown = this.options.impostor ? proofs(newToken(), nonce, String(message.nonce)).nika : proof.nika;
          plain({ t: 'welcome', proof: shown });
          framer = new Framer(proof.session, 'n');
          const own = framer;
          this.sessionSend = (out) => socket.write(`${own.frame(out)}\n`);
          this.sessions += 1;
        }
      }
    });
  }
}
