import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { setTimeout as delay } from 'node:timers/promises';
import { Cs2Connection } from '../src/xiaomi/cs2.js';
import { bind, frame } from '../src/xiaomi/relay.js';
import type { Endpoint } from '../src/xiaomi/relay.js';

const tests: [string, () => Promise<void>][] = [];
const test = (name: string, run: () => Promise<void>) => tests.push([name, run]);
async function until(condition: () => boolean) {
  const deadline = Date.now() + 1500;
  while (!condition() && Date.now() < deadline) await delay(5);
  assert.ok(condition(), 'expected packet was not received');
}
async function peer() {
  const socket = createSocket('udp4');
  await bind(socket, '127.0.0.1');
  let client: Endpoint | undefined;
  const commands: Buffer[] = [];
  const acknowledgements: number[] = [];
  socket.on('message', (message, from) => {
    client = from;
    if (message[1] === 0x30 || message[1] === 0x41) socket.send(frame(message[1] === 0x30 ? 0x41 : 0x42, Buffer.alloc(20)), from.port, from.address);
    if (message[1] === 0xd0) commands.push(Buffer.from(message));
    if (message[1] === 0xd1 && message.length >= 10) acknowledgements.push(message.readUInt16BE(8));
  });
  return {
    host: `127.0.0.1:${socket.address().port}`,
    commands,
    acknowledgements,
    send(message: Buffer) {
      assert.ok(client);
      socket.send(message, client.port, client.address);
    },
    ack(sequence: number, channel = 0) {
      const b = Buffer.from([0xd1, channel, 0, 1, 0, 0]);
      b.writeUInt16BE(sequence, 4);
      this.send(frame(0xd1, b));
    },
    async close() {
      await new Promise<void>((r) => socket.close(() => r()));
    },
  };
}

test('a stale ACK, another channel or a truncated ACK cannot confirm the next command', async () => {
  const fake = await peer();
  const conn = await Cs2Connection.dial(fake.host);
  let completed = false;
  const write = conn.writeCommand(0x112, Buffer.from('command')).then(() => {
    completed = true;
  });
  try {
    await until(() => fake.commands.length === 1);
    fake.ack(9);
    fake.ack(0, 2);
    fake.send(frame(0xd1));
    await delay(30);
    assert.equal(completed, false);
    fake.ack(0);
    await write;
  } finally {
    conn.close();
    await write.catch(() => {});
    await fake.close();
  }
});

test('concurrent command writes are serialized and each has its own matching ACK', async () => {
  const fake = await peer();
  const conn = await Cs2Connection.dial(fake.host);
  const writes = [conn.writeCommand(0x112, Buffer.from('a')), conn.writeCommand(0x112, Buffer.from('b'))];
  try {
    await until(() => fake.commands.length >= 1);
    await delay(20);
    assert.equal(fake.commands.length, 1);
    fake.ack(0);
    await writes[0];
    await until(() => fake.commands.length === 2);
    assert.equal(fake.commands[1].readUInt16BE(6), 1);
    fake.ack(1);
    await writes[1];
  } finally {
    conn.close();
    await Promise.allSettled(writes);
    await fake.close();
  }
});

test('closing a session immediately rejects a command waiting for its ACK', async () => {
  const fake = await peer();
  const conn = await Cs2Connection.dial(fake.host);
  const write = conn.writeCommand(0x112, Buffer.from('a'));
  let rejected = false;
  const settled = write.catch(() => {
    rejected = true;
  });
  try {
    await until(() => fake.commands.length === 1);
    conn.close();
    await delay(30);
    assert.equal(rejected, true);
  } finally {
    conn.close();
    await settled;
    await fake.close();
  }
});

test('an out-of-order packet that does not fit the reorder buffer is not acknowledged', async () => {
  const fake = await peer();
  const conn = await Cs2Connection.dial(fake.host);
  try {
    for (let sequence = 1; sequence <= 65; sequence++) {
      const b = Buffer.alloc(13);
      b[0] = 0xd1;
      b[1] = 0;
      b.writeUInt16BE(sequence, 2);
      b.writeUInt32BE(5, 4);
      b.writeUInt32BE(0x101, 8);
      b[12] = sequence;
      fake.send(frame(0xd0, b));
    }
    await until(() => fake.acknowledgements.length >= 64);
    await delay(30);
    assert.ok(fake.acknowledgements.includes(64));
    assert.ok(!fake.acknowledgements.includes(65));
  } finally {
    conn.close();
    await fake.close();
  }
});

test('an impossible command length closes the session instead of accumulating unbounded data', async () => {
  const fake = await peer();
  const conn = await Cs2Connection.dial(fake.host);
  try {
    const b = Buffer.alloc(8);
    b[0] = 0xd1;
    b.writeUInt32BE(0xffffffff, 4);
    fake.send(frame(0xd0, b));
    await until(() => conn.closed);
  } finally {
    conn.close();
    await fake.close();
  }
});

let failed = 0;
for (const [name, run] of tests) {
  try {
    await run();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed++;
    console.error(`not ok - ${name}`, error);
  }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
if (failed) process.exitCode = 1;
