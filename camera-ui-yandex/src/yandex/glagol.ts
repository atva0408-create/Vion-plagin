// The local protocol of the Yandex stations (Glagol): a WebSocket on the station itself in the home network. It
// answers in a moment and has no limit on the length of the text, but works only where ViON reaches the station.
// Not an official API; it follows the YandexStation integration (see LICENSE.md).
import { randomUUID } from 'node:crypto';

import WebSocket from 'ws';

import { messageText } from './http.js';

export const GLAGOL_PORT = 1961;
const ANSWER_TIMEOUT_MS = 5_000;
const CONNECT_TIMEOUT_MS = 5_000;
/** A connection no one used for this long is closed: the station keeps one per client. */
const IDLE_MS = 5 * 60_000;
/** Codes a station closes the connection with when it does not take the token, as the YandexStation integration reads them. */
const TOKEN_CLOSE_CODES = new Set([4000, 4001]);

/** The station did not take the token of the connection: a new one may pass. */
export class GlagolTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GlagolTokenError';
  }
}

/** The station got the request and answered, but not with success: it is reachable. */
export class GlagolAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GlagolAnswerError';
  }
}

interface Waiter {
  socket: WebSocket;
  resolve: (answer: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

/** Fills the form of a scenario of Alice with the values and runs it, as the apps do. */
export function updateForm(name: string, slots: Record<string, string>) {
  return {
    command: 'serverAction',
    serverActionEventPayload: {
      type: 'server_action',
      name: 'update_form',
      payload: {
        form_update: { name, slots: Object.entries(slots).map(([key, value]) => ({ type: 'string', name: key, value })) },
        resubmit: true,
      },
    },
  };
}

/** What makes a station say the text word for word. */
export function sayPayload(text: string) {
  return updateForm('personal_assistant.scenarios.quasar.iot.repeat_phrase', { phrase_to_repeat: text });
}

/** What a station does with the text as if it were said to Alice. */
export function commandPayload(text: string) {
  return { command: 'sendText', text };
}

export interface GlagolTarget {
  host: string;
  port: number;
  /** wss on the stations, which have a certificate of their own; ws only for tests. */
  secure?: boolean;
}

export class GlagolClient {
  private socket?: WebSocket;
  /** The socket while it connects: a close then must reach it too, or it opens afterwards and is never closed. */
  private connecting?: WebSocket;
  private opening?: Promise<WebSocket>;
  private waiters = new Map<string, Waiter>();
  private idleTimer?: NodeJS.Timeout;

  constructor(
    private target: GlagolTarget,
    private readonly token: () => Promise<string>,
  ) {}

  get address(): string {
    return `${this.target.host}:${this.target.port}`;
  }

  /** A new address of the station closes the connection to the old one. */
  retarget(target: GlagolTarget): void {
    if (target.host === this.target.host && target.port === this.target.port) return;
    this.target = target;
    this.close();
  }

  async send(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const socket = await this.connect();
    const id = randomUUID();
    const conversationToken = await this.token();
    const answer = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`The station ${this.address} did not answer`));
      }, ANSWER_TIMEOUT_MS);
      this.waiters.set(id, {
        socket,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
    socket.send(JSON.stringify({ conversationToken, id, payload, sentTime: Date.now() }));
    const message = await answer;
    if (message.status && message.status !== 'SUCCESS') throw new GlagolAnswerError(`The station ${this.address} answered ${JSON.stringify(message.status)}`);
    return message;
  }

  close(): void {
    clearTimeout(this.idleTimer);
    const sockets = [this.socket, this.connecting];
    this.socket = undefined;
    this.connecting = undefined;
    this.opening = undefined;
    for (const socket of sockets) socket?.close();
  }

  private connect(): Promise<WebSocket> {
    this.keepAlive();
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve(this.socket);
    this.opening ??= new Promise<WebSocket>((resolve, reject) => {
      const scheme = this.target.secure === false ? 'ws' : 'wss';
      // the certificate of a station is its own, not one a browser would trust
      const socket = new WebSocket(`${scheme}://${this.target.host}:${this.target.port}`, { rejectUnauthorized: false, handshakeTimeout: CONNECT_TIMEOUT_MS });
      this.connecting = socket;
      socket.once('open', () => {
        this.connecting = undefined;
        this.socket = socket;
        this.opening = undefined;
        resolve(socket);
      });
      socket.once('error', (error) => {
        // a close() meanwhile may have started a new connection already: that one stays
        if (this.connecting === socket) {
          this.connecting = undefined;
          this.opening = undefined;
        }
        reject(error);
      });
      socket.on('message', (data) => {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(messageText(data));
        } catch {
          return;
        }
        const requestId = typeof message.requestId === 'string' ? message.requestId : undefined;
        const waiter = requestId ? this.waiters.get(requestId) : undefined;
        if (requestId && waiter) {
          this.waiters.delete(requestId);
          waiter.resolve(message);
        }
      });
      socket.on('close', (code) => {
        if (this.socket === socket) this.socket = undefined;
        // what was sent on this socket gets no answer any more: said now, not after the answer timeout
        const error = TOKEN_CLOSE_CODES.has(code)
          ? new GlagolTokenError(`The station ${this.address} did not take the token (${code})`)
          : new Error(`The station ${this.address} closed the connection (${code})`);
        for (const [id, waiter] of this.waiters) {
          if (waiter.socket !== socket) continue;
          this.waiters.delete(id);
          waiter.reject(error);
        }
      });
    });
    return this.opening;
  }

  private keepAlive(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), IDLE_MS);
    this.idleTimer.unref?.();
  }
}
