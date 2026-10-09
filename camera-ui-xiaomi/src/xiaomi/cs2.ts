import { createSocket } from 'node:dgram';
import { connect } from 'node:net';

import type { Socket as UdpSocket } from 'node:dgram';
import type { Socket as TcpSocket } from 'node:net';

// The CS2 P2P link of the Mi Home cameras, as go2rtc dials it (pkg/xiaomi/miss/cs2): a search on the camera's UDP port
// 32108, then the camera names the port and the transport (UDP or TCP) of the session. ViON plays the video through
// go2rtc; the plugin opens a session of its own only for the commands the stream engine does not send (the motor).

const PORT = 32108;
const MAGIC = 0xf1;
const MAGIC_DRW = 0xd1;
const MAGIC_TCP = 0x68;
const MSG_LAN_SEARCH = 0x30;
const MSG_PUNCH = 0x41;
const MSG_READY_UDP = 0x42;
const MSG_READY_TCP = 0x43;
const MSG_DRW = 0xd0;
const MSG_DRW_ACK = 0xd1;
const MSG_PING = 0xe0;
const MSG_PONG = 0xe1;
const MSG_CLOSE = 0xf0;

const HANDSHAKE_MS = 5000;
/** A command over UDP is sent again until the camera acknowledges it, this often at most. */
const UDP_TRIES = 5;
const MAX_COMMAND_SIZE = 64 * 1024;
const MAX_QUEUED_COMMANDS = 64;

export type Transport = 'udp' | 'tcp';

export interface Cs2Command {
  cmd: number;
  data: Buffer;
}

/** A session with one camera: commands on channel 0, which is all the motor needs. */
export class Cs2Connection {
  private seq = 0;
  private stream = Buffer.alloc(0);
  private size = 0;
  private waitSeq = 0;
  private early = new Map<number, Buffer>();
  private queue: Cs2Command[] = [];
  private readers: { resolve: (command: Cs2Command) => void; reject: (error: Error) => void }[] = [];
  private acked?: { sequence: number; resolve: (acknowledged: boolean) => void };
  private writing: Promise<void> = Promise.resolve();
  private keepalive: NodeJS.Timeout;
  private error?: Error;

  private constructor(
    private readonly send: (message: Buffer) => void,
    public readonly transport: Transport,
    private readonly end: () => void,
  ) {
    // the camera drops a session the client keeps silent; the Mi Home app pings about every second (go2rtc pings when
    // video arrives, and on this session none does)
    this.keepalive = setInterval(() => this.send(Buffer.from([MAGIC, MSG_PING, 0, 0])), 1000);
    this.keepalive.unref?.();
  }

  /** Connects to the camera at `host` in the local network; `transport` restricts what the camera may choose. */
  public static async dial(host: string, transport?: Transport): Promise<Cs2Connection> {
    const address = new URL(`udp://${host}`);
    const port = address.port ? Number(address.port) : PORT;
    host = address.hostname;
    const udp = createSocket('udp4');
    let ready: { port: number; transport: Transport };
    try {
      ready = await handshake(udp, host, transport, port);
    } catch (error) {
      udp.close();
      throw error;
    }

    if (ready.transport === 'udp') {
      const connection = new Cs2Connection(
        (message) =>
          udp.send(message, ready.port, host, (error) => {
            if (error) connection.fail(error);
          }),
        'udp',
        () => udp.close(),
      );
      udp.on('message', (message, from) => {
        if (from.address === host && from.port === ready.port) connection.receive(message);
      });
      udp.on('error', (error) => connection.fail(error));
      udp.on('close', () => connection.fail(new Error('cs2: the session was closed')));
      return connection;
    }

    udp.close();
    const tcp = await new Promise<TcpSocket>((resolve, reject) => {
      const socket = connect({ host, port: ready.port, timeout: 3000 });
      socket.once('connect', () => {
        socket.setTimeout(0);
        resolve(socket);
      });
      socket.once('timeout', () => {
        socket.destroy();
        reject(new Error(`cs2: no TCP connection to ${host}:${ready.port}`));
      });
      socket.once('error', reject);
    });
    const connection = new Cs2Connection(
      (message) => {
        // every message over TCP has a header of 8 bytes: its length and the TCP magic
        const header = Buffer.alloc(8);
        header.writeUInt16BE(message.length, 0);
        header[2] = MAGIC_TCP;
        tcp.write(Buffer.concat([header, message]));
      },
      'tcp',
      () => tcp.destroy(),
    );
    let pending = Buffer.alloc(0);
    tcp.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 8) {
        const length = pending.readUInt16BE(0);
        if (pending[2] !== MAGIC_TCP || length < 4) {
          connection.fail(new Error('cs2: invalid TCP frame'));
          return;
        }
        if (pending.length < 8 + length) break;
        connection.receive(pending.subarray(8, 8 + length));
        pending = pending.subarray(8 + length);
      }
    });
    tcp.on('error', (error) => connection.fail(error));
    tcp.on('close', () => connection.fail(new Error('cs2: the camera closed the session')));
    return connection;
  }

  /** Sends a command on channel 0; over UDP it is sent again until the camera acknowledges it. */
  public writeCommand(cmd: number, data: Buffer): Promise<void> {
    const write = this.writing.then(() => this.sendCommand(cmd, data));
    this.writing = write.catch(() => undefined);
    return write;
  }

  private async sendCommand(cmd: number, data: Buffer): Promise<void> {
    if (this.error) throw this.error;
    if (data.length > 0xffff - 16) throw new Error('cs2: command is too large');
    const message = Buffer.alloc(16 + data.length);
    message[0] = MAGIC;
    message[1] = MSG_DRW;
    message.writeUInt16BE(12 + data.length, 2);
    message[4] = MAGIC_DRW;
    message[5] = 0;
    message.writeUInt16BE(this.seq++ & 0xffff, 6);
    message.writeUInt32BE(4 + data.length, 8);
    message.writeUInt32BE(cmd, 12);
    data.copy(message, 16);

    if (this.transport === 'tcp') {
      this.send(message);
      return;
    }
    for (let attempt = 0; attempt < UDP_TRIES; attempt++) {
      const acknowledged = new Promise<boolean>((resolve) => {
        const waiting = {
          sequence: message.readUInt16BE(6),
          resolve: (received: boolean) => {
            clearTimeout(timer);
            if (this.acked === waiting) this.acked = undefined;
            resolve(received);
          },
        };
        const timer = setTimeout(() => waiting.resolve(false), 1000);
        this.acked = waiting;
      });
      this.send(message);
      if (await acknowledged) return;
      // read again: the session may have failed while the acknowledgement was awaited
      const failure = this.failure();
      if (failure) throw failure;
    }
    throw new Error(`cs2: the camera did not acknowledge command 0x${cmd.toString(16)}`);
  }

  /** The next command the camera sends on channel 0, or an error after `timeoutMs`. */
  public async readCommand(timeoutMs: number): Promise<Cs2Command> {
    const queued = this.queue.shift();
    if (queued) return queued;
    if (this.error) throw this.error;
    return new Promise<Cs2Command>((resolve, reject) => {
      const reader = {
        resolve: (command: Cs2Command) => {
          clearTimeout(timer);
          resolve(command);
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        this.readers = this.readers.filter((waiting) => waiting !== reader);
        reject(new Error(`cs2: the camera did not answer within ${timeoutMs / 1000} s`));
      }, timeoutMs);
      this.readers.push(reader);
    });
  }

  private failure(): Error | undefined {
    return this.error;
  }

  public get closed(): boolean {
    return this.error !== undefined;
  }

  public close(): void {
    if (!this.error) this.send(Buffer.from([MAGIC, MSG_CLOSE, 0, 0]));
    this.fail(new Error('cs2: the session was closed'));
  }

  private fail(error: Error): void {
    if (this.error) return;
    this.error = error;
    clearInterval(this.keepalive);
    this.acked?.resolve(false);
    for (const reader of this.readers.splice(0)) reader.reject(error);
    this.stream = Buffer.alloc(0);
    this.early.clear();
    this.queue = [];
    this.end();
  }

  private receive(message: Buffer): void {
    if (this.error || message.length < 4 || message[0] !== MAGIC || message.readUInt16BE(2) !== message.length - 4) return;
    switch (message[1]) {
      case MSG_DRW: {
        if (message.length < 8 || message[4] !== MAGIC_DRW) return;
        const channel = message[5];
        const seq = message.readUInt16BE(6);
        if (this.transport === 'tcp') {
          if (channel === 0) this.push(message.subarray(8));
        } else {
          const accepted = channel !== 0 || this.pushInOrder(seq, message.subarray(8));
          if (!this.error && accepted) this.send(Buffer.from([MAGIC, MSG_DRW_ACK, 0, 6, MAGIC_DRW, channel, 0, 1, message[6], message[7]]));
        }
        return;
      }
      case MSG_PING:
        this.send(Buffer.from([MAGIC, MSG_PONG, 0, 0]));
        return;
      case MSG_DRW_ACK: {
        if (message.length < 10 || message[4] !== MAGIC_DRW || message[5] !== 0) return;
        const count = message.readUInt16BE(6);
        if (message.length !== 8 + count * 2) return;
        const waiting = this.acked;
        for (let i = 0; waiting && i < count; i++) {
          if (message.readUInt16BE(8 + i * 2) === waiting.sequence) {
            waiting.resolve(true);
            break;
          }
        }
        return;
      }
      case MSG_CLOSE:
        this.fail(new Error('cs2: the camera closed the session'));
        return;
      default:
    }
  }

  /** Over UDP messages may come out of order: they are put back in order before they are read. */
  private pushInOrder(seq: number, data: Buffer): boolean {
    const ahead = (seq - this.waitSeq) & 0xffff;
    if (ahead >= 0x8000) return true; // duplicates still need an ACK
    if (ahead > 0) {
      if (this.early.has(seq)) return true;
      if (this.early.size >= 64) return false; // no ACK: the camera must resend this packet later
      this.early.set(seq, Buffer.from(data));
      return true;
    }
    let next: Buffer | undefined = data;
    while (next) {
      this.push(next);
      if (this.error) return false;
      this.waitSeq = (this.waitSeq + 1) & 0xffff;
      next = this.early.get(this.waitSeq);
      this.early.delete(this.waitSeq);
    }
    return true;
  }

  /** Channel 0 is a stream of commands, each with its size in front; one message may carry several, or a part. */
  private push(data: Buffer): void {
    this.stream = Buffer.concat([this.stream, data]);
    for (;;) {
      if (!this.size) {
        if (this.stream.length < 4) return;
        this.size = this.stream.readUInt32BE(0);
        if (this.size < 4 || this.size > MAX_COMMAND_SIZE) {
          this.fail(new Error('cs2: invalid command size'));
          return;
        }
        this.stream = this.stream.subarray(4);
      }
      if (this.stream.length < this.size) return;
      const command = this.stream.subarray(0, this.size);
      this.stream = this.stream.subarray(this.size);
      this.size = 0;
      if (command.length < 4) continue;
      // big-endian like what we send: go2rtc reads it little-endian but never looks at it (the sign-in answer is 0x101)
      const read = { cmd: command.readUInt32BE(0), data: Buffer.from(command.subarray(4)) };
      const reader = this.readers.shift();
      if (reader) reader.resolve(read);
      else {
        if (this.queue.length >= MAX_QUEUED_COMMANDS) {
          this.fail(new Error('cs2: command queue is full'));
          return;
        }
        this.queue.push(read);
      }
    }
  }
}

/** The search: the camera answers with a punch message, then with the port and transport of the session. */
async function handshake(udp: UdpSocket, host: string, transport?: Transport, port = PORT): Promise<{ port: number; transport: Transport }> {
  await new Promise<void>((resolve, reject) => {
    udp.once('error', reject);
    udp.bind(0, () => {
      udp.off('error', reject);
      resolve();
    });
  });

  const exchange = (request: Buffer, port: number, accept: (message: Buffer) => boolean) =>
    new Promise<{ message: Buffer; port: number }>((resolve, reject) => {
      const resend = setInterval(() => udp.send(request, port, host), 1000);
      const onMessage = (message: Buffer, from: { address: string; port: number }) => {
        if (from.address !== host || message.length < 16 || !accept(message)) return;
        done();
        resolve({ message: Buffer.from(message), port: from.port });
      };
      const onError = (error: Error) => {
        done();
        reject(error);
      };
      const done = () => {
        clearInterval(resend);
        clearTimeout(timer);
        udp.off('message', onMessage);
        udp.off('error', onError);
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error(`cs2: no answer from the camera at ${host} (is it switched on and in the same network as the server?)`));
      }, HANDSHAKE_MS);
      udp.on('message', onMessage);
      udp.on('error', onError);
      udp.send(request, port, host);
    });

  const punch = await exchange(Buffer.from([MAGIC, MSG_LAN_SEARCH, 0, 0]), port, (message) => message[1] === MSG_PUNCH);
  const accepted = new Set<number>();
  if (transport !== 'tcp') accepted.add(MSG_READY_UDP);
  if (transport !== 'udp') accepted.add(MSG_READY_TCP);
  const ready = await exchange(punch.message, punch.port, (message) => accepted.has(message[1]));
  return { port: ready.port, transport: ready.message[1] === MSG_READY_TCP ? 'tcp' : 'udp' };
}
