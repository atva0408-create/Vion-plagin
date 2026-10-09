import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { setTimeout as delay } from 'node:timers/promises';
import { P2pBridge, P2pConnections } from '../src/xiaomi/p2p.js';
import { Cs2Connection } from '../src/xiaomi/cs2.js';
import { RelayConnection, addressBlock, bind, encodeUid, frame, relayServers, setupReply } from '../src/xiaomi/relay.js';
import type { Endpoint } from '../src/xiaomi/relay.js';

const INIT = 'EBGDEOBOKGICGAIAFFGN';
const UID = 'ABCDEF-123456-GHIJK';
const tests: [string, () => Promise<void> | void][] = [];
const test = (name: string, run: () => Promise<void> | void) => tests.push([name, run]);
async function until(condition: () => boolean) {
  const deadline = Date.now() + 1500;
  while (!condition() && Date.now() < deadline) await delay(5);
  assert.ok(condition(), 'expected protocol state was not reached');
}

// Synthetic rendezvous, registration, and session endpoints. Joining requires both discovery tokens
// AND a NAT mapping opened by the client to the distinct session port; the first greeting is lost.
async function fakeRelay(tokenDelayMs = 0) {
  const server = createSocket('udp4'),
    relay = createSocket('udp4'),
    session = createSocket('udp4');
  for (const socket of [server, relay, session]) await bind(socket, '127.0.0.1');
  const endpoint = (socket: typeof server): Endpoint => ({ address: '127.0.0.1', port: socket.address().port });
  const tokens = [Buffer.from('12345678', 'hex'), Buffer.from('a1b2c3d4', 'hex')];
  const token = Buffer.from('11223344', 'hex'),
    registered = new Set<string>();
  let client: Endpoint | undefined,
    invited = false,
    punched = false,
    joined = false,
    linked = false,
    hellos = 0;
  const forwarded: Buffer[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const link = Buffer.alloc(88);
  link[0] = 0xa1;
  link[1] = 1;
  Buffer.from('01020304', 'hex').copy(link, 4);
  Buffer.from('0002fe70146433c60000000000000000', 'hex').copy(link, 40);
  const send = (socket: typeof server, type: number, payload: Buffer, to: Endpoint) => socket.send(frame(type, payload), to.port, to.address);
  const join = () => {
    if (!client || !invited || !punched || joined) return;
    joined = true;
    send(session, 0x84, Buffer.alloc(0), client);
    send(session, 0x28, link, client);
  };
  server.on('message', (m, from) => {
    if (m[1] === 0x67 && m.subarray(4).equals(encodeUid(UID))) {
      for (const [i, t] of tokens.entries()) {
        const reply = () => send(server, 0x82, Buffer.concat([addressBlock(endpoint(relay)), t]), from);
        if (i && tokenDelayMs) {
          const timer = setTimeout(() => {
            timers.delete(timer);
            reply();
          }, tokenDelayMs);
          timers.add(timer);
        } else reply();
      }
    } else if (m[1] === 0x80) {
      invited = m.subarray(40, 44).equals(token);
      join();
    }
  });
  relay.on('message', (m, from) => {
    if (m[1] === 0x83) registered.add(m.subarray(4, 8).toString('hex'));
    if (m[1] === 0x70 && tokens.every((t) => registered.has(t.toString('hex'))) && ++hellos > 1) send(relay, 0x71, Buffer.alloc(0), from);
    if (m[1] === 0x72) {
      const p = Buffer.concat([token, Buffer.alloc(2)]);
      p.writeUInt16BE(session.address().port, 4);
      send(relay, 0x73, p, from);
    }
  });
  session.on('message', (m, from) => {
    client = from;
    if (m[1] === 0x83 && m.subarray(4, 8).equals(token)) {
      punched = true;
      join();
    }
    if (m[1] === 0x28) linked = m[5] === 2 && m.subarray(60, 68).toString('hex') === 'feffffff04030201';
    if ([0xd0, 0xd1, 0xe0, 0xe1].includes(m[1])) forwarded.push(Buffer.from(m));
    if (m[1] === 0xe0) send(session, 0xe1, Buffer.alloc(0), from);
  });
  return {
    options: { serverPort: server.address().port, stageMs: 80, timeoutMs: 1200 },
    forwarded,
    get linked() {
      return linked;
    },
    send(m: Buffer) {
      assert.ok(client);
      session.send(m, client.port, client.address);
    },
    async close() {
      for (const timer of timers) clearTimeout(timer);
      await Promise.all([server, relay, session].map((s) => new Promise<void>((r) => s.close(() => r()))));
    },
  };
}

test('published CS2 configuration and identifiers match the documented wire format', () => {
  assert.deepEqual(relayServers('EBGBEPBPKGJKHOJOELGHEKEKHLMFHLNCGKELBICIBJIILILDCABCCGODHBKHJFKGBGNLLHCMPHNOAEDHICMMIEBANPOLBD'), [
    '104.166.181.58',
    '169.197.116.186',
    '169.197.116.216',
  ]);
  assert.deepEqual(relayServers(`${INIT}:unused-key`), ['127.0.0.1']);
  assert.equal(encodeUid(UID).toString('hex'), '41424344454600000001e2404748494a4b000000');
  assert.equal(addressBlock({ address: '198.51.100.20', port: 28926 }).toString('hex'), '0002fe70146433c60000000000000000');
  for (const s of ['', 'Z', 'ABZQ', 'AB', 'A'.repeat(5000)]) assert.throws(() => relayServers(s));
  for (const s of ['', 'prefix-4294967296-check', 'toolongprefix-1-x', 'x--x']) assert.throws(() => encodeUid(s));
});

test('linking reply has both address encodings and the reversed session marker', () => {
  const request = Buffer.alloc(88);
  request[0] = 0xa1;
  request[1] = 1;
  Buffer.from('aabbccdd', 'hex').copy(request, 4);
  Buffer.from('0002fe70146433c60000000000000000', 'hex').copy(request, 40);
  const reply = setupReply(request, { address: '10.0.0.2', port: 28132 });
  assert.ok(reply);
  assert.equal(reply[1], 2);
  assert.equal(reply.subarray(56).toString('hex'), 'feffffffddccbbaa0002e46d0200000a0000000000000000020070fec6336414');
  assert.equal(request[1], 1);
  assert.equal(setupReply(Buffer.alloc(87), { address: '127.0.0.1', port: 1 }), undefined);
});

test('relay retries a lost greeting, registers every token and opens the separate NAT port', async () => {
  const fake = await fakeRelay();
  const connection = await RelayConnection.connect({ uid: UID, init: INIT }, fake.options);
  try {
    await until(() => fake.linked);
    connection.send(frame(0xe0));
    await until(() => fake.forwarded.some((m) => m[1] === 0xe0));
  } finally {
    connection.close();
    await fake.close();
  }
});

test('an available relay connects before the discovery timeout despite delayed tokens and a lost greeting', async () => {
  const fake = await fakeRelay(100);
  let connection: RelayConnection | undefined;
  try {
    connection = await RelayConnection.connect({ uid: UID, init: INIT }, { ...fake.options, stageMs: 5000, timeoutMs: 1000 });
    await until(() => fake.linked);
    connection.send(frame(0xe0));
    await until(() => fake.forwarded.some((m) => m[1] === 0xe0));
  } finally {
    connection?.close();
    await fake.close();
  }
});

test('loopback bridge preserves encrypted commands and media and rejects a second peer', async () => {
  const fake = await fakeRelay();
  const bridge = await P2pBridge.open({ uid: UID, init: INIT }, fake.options);
  const client = createSocket('udp4'),
    other = createSocket('udp4');
  await bind(client, '127.0.0.1');
  await bind(other, '127.0.0.1');
  const received: Buffer[] = [];
  client.on('message', (m) => received.push(Buffer.from(m)));
  const port = Number(bridge.host.split(':')[1]);
  try {
    client.send(frame(0x30), port, '127.0.0.1');
    await until(() => received.some((m) => m[1] === 0x41));
    client.send(frame(0x41, Buffer.alloc(20)), port, '127.0.0.1');
    await until(() => received.some((m) => m[1] === 0x42));
    const command = frame(0xd0, Buffer.from('d1000000000000080000100111223344', 'hex'));
    client.send(command, port, '127.0.0.1');
    await until(() => fake.forwarded.some((m) => m.equals(command)));
    other.send(frame(0xd0, Buffer.from('d1000001deadbeef', 'hex')), port, '127.0.0.1');
    const media = frame(0xd0, Buffer.from('d1020000aabbccdd00112233445566778899', 'hex'));
    fake.send(media);
    await until(() => received.some((m) => m.equals(media)));
    assert.equal(fake.forwarded.filter((m) => m[1] === 0xd0).length, 1);
    assert.equal(bridge.host.split(':')[0], '127.0.0.1');
    fake.send(frame(0x83, Buffer.from('11223344', 'hex')));
    await delay(20);
    assert.ok(!received.some((m) => m[1] === 0x83));
    // go2rtc assumes complete DRW headers and only has incoming channels 0 and 2.
    const invalid = [frame(0xd0, Buffer.from([0xd1, 2])), frame(0xd0, Buffer.from([0xd1, 1, 0, 1])), frame(0xd1), frame(0xd1, Buffer.from([0xd1, 0, 0, 2, 0, 0]))];
    for (const message of invalid) fake.send(message);
    await delay(30);
    assert.ok(
      invalid.every((message) => !received.some((m) => m.equals(message))),
      'a malformed session frame reached go2rtc',
    );
  } finally {
    bridge.close();
    client.close();
    other.close();
    await fake.close();
  }
});

test('a remote close immediately notifies the local PTZ connection', async () => {
  const fake = await fakeRelay();
  const bridge = await P2pBridge.open({ uid: UID, init: INIT }, fake.options);
  const connection = await Cs2Connection.dial(bridge.host);
  try {
    fake.send(frame(0xf0));
    await until(() => connection.closed);
  } finally {
    connection.close();
    bridge.close();
    await fake.close();
  }
});

test('cancellation closes pending sockets, unused sessions expire, and stale requests cannot reopen them', async () => {
  const blackhole = createSocket('udp4');
  await bind(blackhole, '127.0.0.1');
  const abort = new AbortController();
  const pending = RelayConnection.connect({ uid: UID, init: INIT }, { serverPort: blackhole.address().port, timeoutMs: 5000, signal: abort.signal });
  abort.abort();
  await assert.rejects(pending, /cancelled/);
  blackhole.close();
  const fake = await fakeRelay();
  const bridge = await P2pBridge.open({ uid: UID, init: INIT }, { ...fake.options, idleMs: 80 });
  try {
    await until(() => bridge.closed);
  } finally {
    bridge.close();
    await fake.close();
  }
  const owner = new P2pConnections();
  const stale = owner.token('cam');
  owner.close('cam');
  await assert.rejects(owner.open('cam', { uid: UID, init: INIT }, stale), /cancelled/);
});

test('releasing a failed PTZ bridge preserves video and frees that connection slot', async () => {
  const original = P2pBridge.open;
  const bridges: { host: string; closed: boolean; onClose?: () => void; close: () => void }[] = [];
  P2pBridge.open = async () => {
    const bridge = {
      host: `127.0.0.1:${45000 + bridges.length}`,
      closed: false,
      onClose: undefined as (() => void) | undefined,
      close() {
        this.closed = true;
        this.onClose?.();
      },
    };
    bridges.push(bridge);
    return bridge as unknown as P2pBridge;
  };
  const owner = new P2pConnections();
  try {
    const video = await owner.open('cam', { uid: UID, init: INIT });
    const motor = await owner.open('cam', { uid: UID, init: INIT });
    owner.release('cam', motor);
    assert.equal(bridges[0].closed, false);
    assert.equal(bridges[1].closed, true);
    assert.notEqual(await owner.open('cam', { uid: UID, init: INIT }), video);
  } finally {
    owner.close();
    P2pBridge.open = original;
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
