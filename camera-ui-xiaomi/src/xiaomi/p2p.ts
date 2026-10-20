import { createSocket } from 'node:dgram';

import { RelayConnection, bind, frame, validFrame } from './relay.js';

import type { Endpoint, RelayCredentials, RelayOptions } from './relay.js';

export type ConnectionMode = 'auto' | 'lan' | 'remote';

/** go2rtc assumes complete CS2 headers and cannot consume channel 1 or incoming speaker packets. */
function sessionFrame(message: Buffer, inbound: boolean): boolean {
  if (!validFrame(message)) return false;
  switch (message[1]) {
    case 0xd0:
      return message.length >= 8 && message[4] === 0xd1 && (inbound ? [0, 2] : [0, 3]).includes(message[5]);
    case 0xd1: {
      if (message.length < 10 || message[4] !== 0xd1 || ![0, 2, 3].includes(message[5])) return false;
      const count = message.readUInt16BE(6);
      return count > 0 && message.length === 8 + count * 2;
    }
    case 0xe0:
    case 0xe1:
    case 0xf0:
    case 0xf1:
      return message.length === 4;
    default:
      return false;
  }
}

/** A whole DRW frame of the camera on a channel other than go2rtc's 0 and 2. */
function unreadDrw(message: Buffer): boolean {
  return validFrame(message) && message[1] === 0xd0 && message.length >= 8 && message[4] === 0xd1 && message[5] !== 0 && message[5] !== 2;
}

/** A short, non-invasive discovery probe. An unrelated UDP response is not evidence of a local camera. */
export async function reachableLocally(host: string, timeoutMs = 1200): Promise<boolean> {
  if (!host) return false;
  const socket = createSocket('udp4');
  return new Promise<boolean>((resolve) => {
    let finished = false;
    const done = (found: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearInterval(retry);
      try {
        socket.close();
      } catch {
        /* bind failed */
      }
      resolve(found);
    };
    const send = () => {
      if (!finished)
        socket.send(frame(0x30), 32108, host, (error) => {
          if (error) done(false);
        });
    };
    const timeout = setTimeout(() => done(false), timeoutMs);
    const retry = setInterval(send, 400);
    socket.on('error', () => done(false));
    socket.on('message', (message, from) => {
      if (from.address === host && validFrame(message) && message[1] === 0x41 && message.length >= 16) done(true);
    });
    socket.bind(0, send);
  });
}

/**
 * Loopback CS2 adapter for the existing go2rtc Xiaomi producer. Only its one UDP peer may use this session.
 * MISS authentication, encryption, media sequencing, audio and video pass through unchanged.
 */
export class P2pBridge {
  private readonly socket = createSocket('udp4');
  private peer?: Endpoint;
  private lastActivity = Date.now();
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private readonly unread = new Set<number>();
  public onClose?: () => void;
  /** The first frame of a session on a channel go2rtc does not read: what the camera sends besides video. */
  public onUnread?: (channel: number) => void;
  public host = '';

  private constructor(
    private readonly relay: RelayConnection,
    private readonly idleMs: number,
  ) {
    relay.onClose = () => this.close();
    relay.onMessage = (message) => {
      if (!sessionFrame(message, true)) {
        // DRW is delivered reliably: a frame the camera sends on a channel go2rtc cannot read (1, or 3 where the speaker
        // is) is acknowledged here as Cs2Connection does, or the camera sends it again and again. Dropped unacknowledged,
        // the video of a camera behind a relay stopped 4 s after talk started (bench, 2026-10-20)
        if (!unreadDrw(message)) return;
        relay.send(frame(0xd1, Buffer.from([0xd1, message[5], 0, 1, message[6], message[7]])));
        if (!this.unread.has(message[5])) {
          this.unread.add(message[5]);
          this.onUnread?.(message[5]);
        }
        return;
      }
      if (message[1] === 0xf0 || message[1] === 0xf1) {
        this.close();
        return;
      }
      if (!this.peer) {
        if (message[1] === 0xe0) relay.send(frame(0xe1));
        return;
      }
      this.socket.send(message, this.peer.port, this.peer.address, (error) => {
        if (error) this.close();
      });
    };
    this.socket.on('error', () => this.close());
    this.socket.on('message', (message, from) => {
      if (this.stopped || !validFrame(message) || from.address !== '127.0.0.1') return;
      if (this.peer && from.port !== this.peer.port) return;
      // Local discovery is synthetic; the remote rendezvous handshake has already finished.
      if (message[1] === 0x30 || message[1] === 0x41) {
        this.peer ??= { address: from.address, port: from.port };
        const response = frame(message[1] === 0x30 ? 0x41 : 0x42, Buffer.alloc(20));
        this.socket.send(response, from.port, from.address, (error) => {
          if (error) this.close();
        });
      } else if (this.peer && sessionFrame(message, false)) {
        relay.send(message);
        if (message[1] === 0xf0 || message[1] === 0xf1) {
          this.close();
          return;
        }
      } else return;
      this.lastActivity = Date.now();
    });
  }

  public static async open(credentials: RelayCredentials, options: RelayOptions & { idleMs?: number } = {}): Promise<P2pBridge> {
    const relay = await RelayConnection.connect(credentials, options);
    const bridge = new P2pBridge(relay, options.idleMs ?? 20_000);
    try {
      if (relay.closed || options.signal?.aborted) throw new Error('CS2 P2P: connection cancelled');
      await bind(bridge.socket, '127.0.0.1');
      bridge.host = `127.0.0.1:${bridge.socket.address().port}`;
      bridge.timer = setInterval(
        () => {
          // go2rtc closes its UDP socket without sending CLOSE. Stop when its ACKs/PONGs stop arriving.
          if (Date.now() - bridge.lastActivity > bridge.idleMs) bridge.close();
          else relay.send(frame(0xe0));
        },
        Math.min(1000, bridge.idleMs),
      );
      bridge.timer.unref?.();
      return bridge;
    } catch (error) {
      bridge.close();
      throw error;
    }
  }

  public get closed(): boolean {
    return this.stopped;
  }

  public close(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    this.relay.close();
    const end = () => {
      try {
        this.socket.close();
      } catch {
        /* not yet bound */
      }
    };
    // UDP has no EOF. Tell the PTZ client to discard its authenticated session before closing the local port.
    if (this.peer) {
      try {
        this.socket.send(frame(0xf0), this.peer.port, this.peer.address, end);
      } catch {
        end();
      }
    } else end();
    this.onClose?.();
  }
}

/** Owns every pending/active remote session so sign-out, camera removal and shutdown release them immediately. */
export class P2pConnections {
  private readonly active = new Map<string, Set<{ abort: AbortController; bridge?: P2pBridge }>>();
  private epoch = 0;
  private readonly versions = new Map<string, number>();

  constructor(private readonly say?: (message: string) => void) {}

  public token(did: string): string {
    return `${this.epoch}:${this.versions.get(did) ?? 0}`;
  }

  public async open(did: string, credentials: RelayCredentials, token = this.token(did)): Promise<string> {
    if (token !== this.token(did)) throw new Error('CS2 P2P: connection cancelled');
    const sessions = this.active.get(did) ?? new Set();
    // Probes and players can request fresh URLs concurrently. Bound unused sessions without sharing auth keys.
    if (sessions.size >= 4) throw new Error('CS2 P2P: too many simultaneous connections to this camera');
    const session: { abort: AbortController; bridge?: P2pBridge } = { abort: new AbortController() };
    sessions.add(session);
    this.active.set(did, sessions);
    const remove = () => {
      sessions.delete(session);
      if (!sessions.size && this.active.get(did) === sessions) this.active.delete(did);
    };
    try {
      const bridge = await P2pBridge.open(credentials, { signal: session.abort.signal });
      session.bridge = bridge;
      bridge.onClose = remove;
      bridge.onUnread = (channel) => this.say?.(`CS2 P2P ${did}: the camera sends on channel ${channel}, which go2rtc does not read; acknowledged here`);
      if (session.abort.signal.aborted || bridge.closed) {
        bridge.close();
        throw new Error('CS2 P2P: connection cancelled');
      }
      return bridge.host;
    } catch (error) {
      remove();
      throw error;
    }
  }

  /** Release only a failed motor connection; the camera's video session must keep running. */
  public release(did: string, host: string): void {
    for (const session of [...(this.active.get(did) ?? [])]) {
      if (session.bridge?.host !== host) continue;
      session.abort.abort();
      session.bridge.close();
    }
  }

  public close(did?: string): void {
    if (did) this.versions.set(did, (this.versions.get(did) ?? 0) + 1);
    else {
      this.epoch++;
      this.versions.clear();
    }
    for (const [id, sessions] of this.active) {
      if (did && id !== did) continue;
      this.active.delete(id);
      for (const session of [...sessions]) {
        session.abort.abort();
        session.bridge?.close();
      }
    }
  }
}
