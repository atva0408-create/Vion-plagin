import { createSocket } from 'node:dgram';
import { isIPv4 } from 'node:net';

import type { RemoteInfo, Socket } from 'node:dgram';

// Xiaomi CS2 relay wire format (PPPP):
// https://github.com/magicus/pppp-dissector/blob/main/PPPP.md
// Xiaomi's relay registration and 0x28 linking exchange are described in:
// https://github.com/eugeneRover/micam#how-it-works
// This transport forwards the encrypted MISS packets; video decoding stays in go2rtc.

export interface RelayCredentials {
  uid: string;
  init: string;
}

export interface Endpoint {
  address: string;
  port: number;
}

const TABLE = Buffer.from('4959433db5bf6da347534f6165e371e9677f02030badb3892b2f35c16b8b959711e5a70deff1050783fb9d3bc5c713171d1f2529d3df', 'hex');

/** The cloud's obfuscated list of IPv4 rendezvous servers, never a user-supplied destination. */
export function relayServers(init: string): string[] {
  const encoded = init.split(':', 1)[0];
  if (!encoded || encoded.length > 4096 || encoded.length % 2 || !/^[A-P]+$/.test(encoded)) throw new Error('CS2 P2P: invalid server list from Xiaomi');
  const decoded = Buffer.alloc(encoded.length / 2);
  let running = 0x39;
  for (let i = 0; i < decoded.length; i++) {
    decoded[i] = running ^ TABLE[i % TABLE.length] ^ ((encoded.charCodeAt(i * 2) - 65) * 16 + encoded.charCodeAt(i * 2 + 1) - 65);
    running ^= decoded[i];
  }
  const servers = [...new Set(decoded.toString('ascii').split(',').filter(Boolean))];
  if (!servers.length || servers.length > 16 || servers.some((server) => !isIPv4(server))) throw new Error('CS2 P2P: invalid server addresses from Xiaomi');
  return servers;
}

export function encodeUid(uid: string): Buffer {
  const match = /^([A-Za-z0-9]{1,8})-(\d{1,10})-([A-Za-z0-9]{1,8})$/.exec(uid);
  if (!match || Number(match[2]) > 0xffffffff) throw new Error('CS2 P2P: invalid camera identifier from Xiaomi');
  const out = Buffer.alloc(20);
  out.write(match[1], 0, 'ascii');
  out.writeUInt32BE(Number(match[2]), 8);
  out.write(match[3], 12, 'ascii');
  return out;
}

export function frame(type: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const out = Buffer.alloc(4 + payload.length);
  out[0] = 0xf1;
  out[1] = type;
  out.writeUInt16BE(payload.length, 2);
  payload.copy(out, 4);
  return out;
}

export function validFrame(message: Buffer): boolean {
  return message.length >= 4 && message[0] === 0xf1 && message.readUInt16BE(2) === message.length - 4;
}

export function addressBlock(endpoint: Endpoint): Buffer {
  const out = Buffer.alloc(16);
  out.writeUInt16BE(2, 0);
  out.writeUInt16LE(endpoint.port, 2);
  Buffer.from(endpoint.address.split('.').map(Number).reverse()).copy(out, 4);
  return out;
}

function readAddress(data: Buffer): Endpoint | undefined {
  if (data.length < 16 || data.readUInt16BE(0) !== 2) return;
  const port = data.readUInt16LE(2);
  const address = [...data.subarray(4, 8)].reverse().join('.');
  if (!port || address === '0.0.0.0' || address === '255.255.255.255') return;
  return { address, port };
}

/** Xiaomi's linking message has an address block plus a second, compact address with different byte order. */
export function setupReply(request: Buffer, local: Endpoint): Buffer | undefined {
  if (request.length !== 88 || request[0] !== 0xa1 || request[1] !== 1) return;
  const external = readAddress(request.subarray(40, 56));
  if (!external) return;
  const reply = Buffer.from(request);
  reply[1] = 2;
  reply.fill(0xff, 56, 60);
  reply[56] = 0xfe;
  for (let i = 0; i < 4; i++) reply[60 + i] = request[7 - i];
  addressBlock(local).copy(reply, 64);
  reply.writeUInt16LE(2, 80);
  reply.writeUInt16BE(external.port, 82);
  Buffer.from(external.address.split('.').map(Number)).copy(reply, 84);
  return reply;
}

export interface RelayOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Injected only by protocol tests; production ports are the CS2 rendezvous ports. */
  serverPort?: number;
  stageMs?: number;
}

/** One remote camera session. Retries are bounded, and cancellation closes the socket at any handshake stage. */
export class RelayConnection {
  private readonly socket = createSocket('udp4');
  private endpoint?: Endpoint;
  private local?: Endpoint;
  private receive?: (message: Buffer, from: RemoteInfo) => void;
  private failure?: Error;
  private rejectWait?: (error: Error) => void;
  private abort?: () => void;
  public onMessage?: (message: Buffer) => void;
  public onClose?: () => void;

  private constructor(private readonly signal?: AbortSignal) {
    this.socket.on('error', () => this.close(new Error('CS2 P2P: UDP connection failed')));
    this.socket.on('message', (message, from) => {
      if (!validFrame(message)) return;
      if (from.address === this.endpoint?.address && from.port === this.endpoint.port) {
        if (message[1] === 0x28 && this.local) {
          const reply = setupReply(message.subarray(4), this.local);
          if (reply) this.send(frame(0x28, reply));
          return;
        }
        if (this.onMessage) {
          this.onMessage(message);
          return;
        }
      }
      this.receive?.(message, from);
    });
    if (signal) {
      this.abort = () => this.close(new Error('CS2 P2P: connection cancelled'));
      signal.addEventListener('abort', this.abort, { once: true });
    }
  }

  public static async connect(credentials: RelayCredentials, options: RelayOptions = {}): Promise<RelayConnection> {
    const servers = relayServers(credentials.init);
    const uid = encodeUid(credentials.uid);
    const connection = new RelayConnection(options.signal);
    try {
      if (options.signal?.aborted) throw new Error('CS2 P2P: connection cancelled');
      await bind(connection.socket);
      await connection.handshake(uid, servers, options);
      return connection;
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  public get closed(): boolean {
    return !!this.failure;
  }

  public send(message: Buffer, endpoint = this.endpoint): void {
    if (this.failure || !endpoint) return;
    this.socket.send(message, endpoint.port, endpoint.address, (error) => {
      if (error) this.close(new Error('CS2 P2P: could not send UDP packet'));
    });
  }

  public close(error = new Error('CS2 P2P: connection closed')): void {
    if (this.failure) return;
    if (this.endpoint) this.send(frame(0xf0));
    this.failure = error;
    if (this.abort) this.signal?.removeEventListener('abort', this.abort);
    this.rejectWait?.(error);
    this.receive = undefined;
    this.onMessage = undefined;
    try {
      this.socket.close();
    } catch {
      /* not yet bound */
    }
    this.onClose?.();
  }

  /** Installs the listener before sending; even a synchronous local response cannot race the next wait. */
  private async exchange<T>(timeoutMs: number, send: () => void, accept: (message: Buffer, from: RemoteInfo) => T | undefined): Promise<T | undefined> {
    if (this.failure) throw this.failure;
    return new Promise<T | undefined>((resolve, reject) => {
      let result: T | undefined;
      const done = (error?: Error) => {
        clearTimeout(timeout);
        clearInterval(retry);
        this.receive = undefined;
        this.rejectWait = undefined;
        if (error) reject(error);
        else resolve(result);
      };
      const timeout = setTimeout(() => done(), timeoutMs);
      const retry = setInterval(send, Math.min(800, Math.max(20, timeoutMs / 3)));
      this.rejectWait = (error) => done(error);
      this.receive = (message, from) => {
        const found = accept(message, from);
        if (found !== undefined) {
          result = found;
          done();
        }
      };
      send();
    });
  }

  private async handshake(uid: Buffer, servers: string[], options: RelayOptions): Promise<void> {
    const deadline = Date.now() + (options.timeoutMs ?? 25_000);
    const stage = options.stageMs ?? 2500;
    const remaining = () => Math.max(1, Math.min(stage, deadline - Date.now()));
    const rendezvous = servers.map((address) => ({ address, port: options.serverPort ?? 32100 }));
    const trustedServer = (from: RemoteInfo) => rendezvous.some((server) => server.address === from.address && server.port === from.port);
    let reason = 'Xiaomi did not return a relay; the camera may be offline';
    while (Date.now() < deadline) {
      if (this.failure) throw this.failure;
      const candidates = new Map<string, { endpoint: Endpoint; tokens: Map<string, Buffer> }>();
      this.endpoint = undefined;
      const registration = (token: Buffer) => frame(0x83, Buffer.concat([token, uid, Buffer.alloc(4)]));
      // Register relays as discovery answers arrive. Keep discovering while waiting for a greeting,
      // so late candidates and additional registration tokens do not cost a fixed collection delay.
      const chosen = await this.exchange(
        remaining(),
        () => {
          for (const server of rendezvous) this.send(frame(0x67, uid), server);
          for (const candidate of candidates.values()) {
            for (const token of candidate.tokens.values()) {
              for (let i = 0; i < 4; i++) this.send(registration(token), candidate.endpoint);
            }
            this.send(frame(0x70), candidate.endpoint);
          }
        },
        (message, from) => {
          if (message[1] === 0x71 && candidates.has(`${from.address}:${from.port}`)) return { address: from.address, port: from.port };
          if (!trustedServer(from) || message[1] !== 0x82 || message.length < 24) return;
          const endpoint = readAddress(message.subarray(4, 20));
          if (!endpoint) return;
          const key = `${endpoint.address}:${endpoint.port}`;
          let candidate = candidates.get(key);
          if (!candidate) {
            if (candidates.size >= 16) return;
            candidates.set(key, (candidate = { endpoint, tokens: new Map() }));
          }
          const token = Buffer.from(message.subarray(20, 24));
          if (!candidate.tokens.has(token.toString('hex')) && candidate.tokens.size >= 32) return;
          candidate.tokens.set(token.toString('hex'), token);
          for (let i = 0; i < 4; i++) this.send(registration(token), endpoint);
          this.send(frame(0x70), endpoint);
          return;
        },
      );
      if (!chosen) {
        reason = candidates.size ? 'Xiaomi relays did not accept the connection' : 'Xiaomi did not return a relay; the camera may be offline';
        continue;
      }
      const allocation = await this.exchange(
        remaining(),
        () => this.send(frame(0x72), chosen),
        (message, from) => {
          if (message[1] !== 0x73 || message.length < 10 || from.address !== chosen.address || from.port !== chosen.port) return;
          const port = message.readUInt16BE(8);
          if (port) return { endpoint: { address: from.address, port }, token: Buffer.from(message.subarray(4, 8)) };
          return;
        },
      );
      if (!allocation) {
        reason = 'Xiaomi relay did not allocate a session';
        continue;
      }
      this.endpoint = allocation.endpoint;
      this.local = { address: await routeAddress(allocation.endpoint), port: this.socket.address().port };
      const request = frame(0x80, Buffer.concat([uid, addressBlock(allocation.endpoint), allocation.token]));
      const joined = await this.exchange(
        Math.min(8000, Math.max(1, deadline - Date.now())),
        () => {
          for (const server of rendezvous) this.send(request, server);
          for (let i = 0; i < 24; i++) this.send(registration(allocation.token));
        },
        (message, from) => (message[1] === 0x84 && from.address === allocation.endpoint.address && from.port === allocation.endpoint.port ? true : undefined),
      );
      if (joined) return;
      reason = 'The camera did not join the Xiaomi relay; check its connection in Mi Home';
    }
    throw new Error(`CS2 P2P: ${reason}`);
  }
}

export function bind(socket: Socket, address = '0.0.0.0'): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off('error', failed);
      socket.off('close', closed);
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    const closed = () => failed(new Error('CS2 P2P: connection cancelled'));
    socket.once('error', failed);
    socket.once('close', closed);
    socket.bind(0, address, () => {
      cleanup();
      resolve();
    });
  });
}

/** Ask the OS for the interface used to reach this relay, without sending any datagrams. */
async function routeAddress(endpoint: Endpoint): Promise<string> {
  const probe = createSocket('udp4');
  try {
    return await new Promise<string>((resolve, reject) => {
      probe.once('error', reject);
      probe.connect(endpoint.port, endpoint.address, () => resolve(probe.address().address));
    });
  } finally {
    try {
      probe.close();
    } catch {
      /* connect failed */
    }
  }
}
