// A stand-in for a Mi Home camera in the local network, answering the way a Xiaomi Smart Camera C300 answered the
// plugin: the search on UDP port 32108, the session over TCP (or UDP), the sign-in with the key pair and signature the
// cloud handed out, and motor commands encrypted with the shared key, each answered with where the camera points.
// Commands are decrypted with the camera's own private key: a command the plugin encrypts wrongly is not understood.
import { createSocket } from 'node:dgram';
import { createServer } from 'node:net';

import { decode, encode, sharedKey } from '../src/xiaomi/crypto.js';
import { generateKeyPair } from '../src/xiaomi/keys.js';

import type { Socket as UdpSocket } from 'node:dgram';
import type { Server, Socket as TcpSocket } from 'node:net';

export const SIGN = 'fake-sign';

export interface FakeCameraOptions {
  transport?: 'tcp' | 'udp';
  /** the sign-in is refused */
  refuseSession?: boolean;
  /** `ret` of every motor answer (0: the step was taken) */
  ret?: number;
  /** motor answers per step: the C300 sends several as the motor turns */
  answersPerStep?: number;
  /** Damaged encrypted payload, for receive-loop failure tests. */
  malformedAnswer?: Buffer;
}

export interface FakeCamera {
  /** the public key the cloud gives for this camera (`public_key` of miss_get_vendor) */
  devicePublic: string;
  /** operations of the motor commands, in the order they came */
  operations: number[];
  /** sessions opened (sign-ins that passed) */
  sessions: number;
  pings: number;
  /** the sign-ins, as the client sent them */
  auths: { public_key?: string; sign?: string }[];
  /** ends the open sessions as a camera does when it restarts */
  dropSessions(): void;
  close(): Promise<void>;
}

const MAGIC = 0xf1;

export async function fakeCamera(options: FakeCameraOptions = {}): Promise<FakeCamera> {
  const transport = options.transport ?? 'tcp';
  const device = generateKeyPair();
  const state: FakeCamera = {
    devicePublic: device.publicKey,
    operations: [],
    sessions: 0,
    pings: 0,
    auths: [],
    dropSessions: () => {
      for (const socket of tcpSockets) socket.destroy();
      tcpSockets.clear();
    },
    close: async () => {
      state.dropSessions();
      // awaited: the next stand-in binds port 32108 again
      await Promise.all([
        new Promise<void>((resolve) => search.close(() => resolve())),
        new Promise<void>((resolve) => sessionUdp.close(() => resolve())),
        new Promise<void>((resolve) => tcp.close(() => resolve())),
      ]);
    },
  };
  const tcpSockets = new Set<TcpSocket>();

  // the session port: TCP and UDP on the same number, as the camera names one port for either
  const tcp: Server = createServer();
  await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', () => resolve()));
  const port = (tcp.address() as { port: number }).port;
  const sessionUdp: UdpSocket = createSocket('udp4');
  await new Promise<void>((resolve) => sessionUdp.bind(port, '127.0.0.1', () => resolve()));
  const search: UdpSocket = createSocket('udp4');
  await new Promise<void>((resolve, reject) => {
    search.once('error', reject);
    search.bind(32108, '127.0.0.1', () => resolve());
  });

  const punch = Buffer.alloc(16);
  punch[0] = MAGIC;
  punch[1] = 0x41;
  const ready = Buffer.alloc(16);
  ready[0] = MAGIC;
  ready[1] = transport === 'tcp' ? 0x43 : 0x42;

  search.on('message', (message, from) => {
    if (message[0] === MAGIC && message[1] === 0x30) sessionUdp.send(punch, from.port, from.address);
  });

  /** One session: what the client sends on channel 0 and how the camera answers. */
  const session = (send: (message: Buffer) => void) => {
    let stream = Buffer.alloc(0);
    let size = 0;
    let seq = 0;
    let key: Buffer | undefined;
    const reply = (cmd: number, data: Buffer) => {
      const payload = Buffer.alloc(8 + data.length);
      payload.writeUInt32BE(4 + data.length, 0);
      payload.writeUInt32BE(cmd, 4);
      data.copy(payload, 8);
      const message = Buffer.alloc(8 + payload.length);
      message[0] = MAGIC;
      message[1] = 0xd0;
      message.writeUInt16BE(4 + payload.length, 2);
      message[4] = 0xd1;
      message[5] = 0;
      message.writeUInt16BE(seq++ & 0xffff, 6);
      payload.copy(message, 8);
      send(message);
    };
    const command = (cmd: number, data: Buffer) => {
      if (cmd === 0x100) {
        const auth = JSON.parse(data.toString()) as { public_key?: string; sign?: string };
        state.auths.push(auth);
        if (options.refuseSession || auth.sign !== SIGN || !auth.public_key) {
          reply(0x101, Buffer.from('{"result":"fail","reason":"sign"}'));
          return;
        }
        key = sharedKey(auth.public_key, device.privateKey);
        state.sessions++;
        reply(0x101, Buffer.from('{"result":"success", "channel": "1790991066786"}'));
        return;
      }
      if (cmd !== 0x1001 || !key) return;
      const plain = decode(data, key);
      if (plain.readUInt32BE(0) !== 0x112) return;
      const { operation } = JSON.parse(plain.subarray(4).toString()) as { operation: number };
      state.operations.push(operation);
      for (let i = 0; i < (options.answersPerStep ?? 1); i++) {
        const answer = Buffer.alloc(4);
        answer.writeUInt32BE(0x113, 0);
        const text = `{"ret":${options.ret ?? 0}, "angle":${40 + state.operations.length},"elevation":10}\0`;
        reply(0x1001, options.malformedAnswer ?? encode(Buffer.concat([answer, Buffer.from(text)]), key));
      }
    };
    return (message: Buffer) => {
      if (message[0] !== MAGIC) return;
      if (message[1] === 0xe0) {
        state.pings++;
        send(Buffer.from([MAGIC, 0xe1, 0, 0]));
        return;
      }
      if (message[1] !== 0xd0 || message[5] !== 0) return;
      if (transport === 'udp') send(Buffer.from([MAGIC, 0xd1, 0, 6, 0xd1, 0, 0, 1, message[6], message[7]]));
      stream = Buffer.concat([stream, message.subarray(8)]);
      for (;;) {
        if (!size) {
          if (stream.length < 4) return;
          size = stream.readUInt32BE(0);
          stream = stream.subarray(4);
        }
        if (stream.length < size) return;
        const body = stream.subarray(0, size);
        stream = stream.subarray(size);
        size = 0;
        command(body.readUInt32BE(0), body.subarray(4));
      }
    };
  };

  let udpSession: ((message: Buffer) => void) | undefined;
  sessionUdp.on('message', (message, from) => {
    if (message[1] === 0x41) {
      sessionUdp.send(ready, from.port, from.address);
      if (transport === 'udp') udpSession = session((reply) => sessionUdp.send(reply, from.port, from.address));
      return;
    }
    udpSession?.(message);
  });

  tcp.on('connection', (socket) => {
    tcpSockets.add(socket);
    socket.on('close', () => tcpSockets.delete(socket));
    socket.on('error', () => tcpSockets.delete(socket));
    const handle = session((message) => {
      const header = Buffer.alloc(8);
      header.writeUInt16BE(message.length, 0);
      header[2] = 0x68;
      socket.write(Buffer.concat([header, message]));
    });
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 8) {
        const length = pending.readUInt16BE(0);
        if (pending.length < 8 + length) break;
        // a frame without the TCP magic is not the camera's protocol: dropped, as noise would be
        if (pending[2] === 0x68) handle(pending.subarray(8, 8 + length));
        pending = pending.subarray(8 + length);
      }
    });
  });

  return state;
}
