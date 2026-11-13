// The network search, on answers as mDNS responders give them: a full answer, an answer in pieces (what it lacks is
// asked for), an answer without the host's address (the sender's is taken), a goodbye, a NIKA that went quiet, two
// instances of one NIKA, another service on the network, and lookup waiting for an answer.
// Run: npx tsx spec/discovery.spec.ts
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { chooseAddress, Discovery, FORGET_AFTER_MS } from '../src/discovery.js';
import { SERVICE_NAME } from '../src/protocol.js';

import type { MdnsPacket, MulticastDns } from 'multicast-dns';
import type { LocalNet } from '../src/discovery.js';

class FakeMdns extends EventEmitter {
  asked: { name: string; type: string }[] = [];
  destroyed = false;
  query(query: { questions: { name: string; type: string }[] }): void {
    this.asked.push(...query.questions);
  }
  destroy(): void {
    this.destroyed = true;
  }
}

const INSTANCE = `Ника — Детская.${SERVICE_NAME}`;
const txt = (values: Record<string, string>) => Object.entries(values).map(([key, value]) => Buffer.from(`${key}=${value}`));
const full = (instance = INSTANCE, id = 'n1', host = '192.168.10.128', port = 8796): MdnsPacket => ({
  type: 'response',
  answers: [{ name: SERVICE_NAME, type: 'PTR', ttl: 4500, data: instance }],
  additionals: [
    { name: instance, type: 'SRV', ttl: 120, data: { port, target: 'nika-jetson.local' } },
    { name: instance, type: 'TXT', ttl: 4500, data: txt({ id, name: 'Ника', room: 'Детская', ver: '1.2', proto: '1' }) },
    { name: 'nika-jetson.local', type: 'A', ttl: 120, data: host },
  ],
});

// the networks of the machine VION runs on: the home network, its Docker bridge, an adapter without a network
const BENCH: LocalNet[] = [
  { address: '192.168.10.225', netmask: '255.255.255.0' },
  { address: '172.17.0.1', netmask: '255.255.0.0' },
  { address: '169.254.7.7', netmask: '255.255.0.0' },
];
const at = (...entries: [string, number][]) => new Map(entries);

// ---- which of her addresses
{
  // she names her home address and her own Docker bridge, and answers from the home network
  assert.equal(chooseAddress(at(['172.17.0.1', 2], ['192.168.10.128', 1]), at(['192.168.10.128', 1]), BENCH), '192.168.10.128');
  // no answer address known: never this machine's own Docker bridge
  assert.equal(chooseAddress(at(['172.17.0.1', 2], ['192.168.10.128', 1]), at(), BENCH), '192.168.10.128');
  // a copy through an adapter without a network came last: not that one
  assert.equal(chooseAddress(at(), at(['192.168.10.164', 1], ['169.254.93.10', 2]), BENCH), '192.168.10.164');
  // she moved: the newest answer
  assert.equal(chooseAddress(at(), at(['192.168.10.128', 1], ['192.168.10.140', 5]), BENCH), '192.168.10.140');
  // VION and NIKA on one machine: its own address is all there is
  assert.equal(chooseAddress(at(['192.168.10.225', 1]), at(), BENCH), '192.168.10.225');
  // another network (a router between): what she names
  assert.equal(chooseAddress(at(['10.8.0.5', 1]), at(), BENCH), '10.8.0.5');
  // nothing but 169.254.x.x: that, rather than nothing
  assert.equal(chooseAddress(at(['169.254.93.10', 1]), at(), BENCH), '169.254.93.10');
  assert.equal(chooseAddress(at(), at(), BENCH), undefined);
}

let clock = 1_000_000;
const make = () => {
  const mdns = new FakeMdns();
  const logs: string[] = [];
  let changes = 0;
  const discovery = new Discovery({
    log: (line) => logs.push(line),
    now: () => clock,
    open: () => mdns as unknown as MulticastDns,
    onChange: () => (changes += 1),
    nets: () => BENCH,
  });
  discovery.start();
  return { discovery, mdns, logs, changes: () => changes };
};

// ---- the start asks; a full answer is a NIKA
{
  const { discovery, mdns, changes } = make();
  assert.deepEqual(mdns.asked, [{ name: SERVICE_NAME, type: 'PTR' }]);
  discovery.onPacket(full(), { address: '192.168.10.128', port: 5353 });
  assert.deepEqual(discovery.list(), [{ id: 'n1', name: 'Ника', room: 'Детская', version: '1.2', proto: 1, host: '192.168.10.128', port: 8796, seenAt: clock }]);
  assert.equal(changes(), 1);
  discovery.stop();
  assert.ok(mdns.destroyed);
}

// ---- an answer in pieces: the instance alone, then its records; what it lacks is asked for
{
  const { discovery, mdns } = make();
  mdns.asked = [];
  discovery.onPacket({ type: 'response', answers: [{ name: SERVICE_NAME, type: 'PTR', ttl: 4500, data: INSTANCE }] });
  assert.deepEqual(discovery.list(), [], 'not a NIKA yet: no port, no id');
  const lower = INSTANCE.toLowerCase();
  assert.deepEqual(mdns.asked, [
    { name: lower, type: 'SRV' },
    { name: lower, type: 'TXT' },
  ]);
  discovery.onPacket({ type: 'response', answers: [{ name: INSTANCE, type: 'SRV', ttl: 120, data: { port: 9000, target: 'Nika-Host.local' } }] });
  discovery.onPacket({ type: 'response', answers: [{ name: INSTANCE, type: 'TXT', ttl: 120, data: txt({ id: 'n2', name: 'Ника' }) }] });
  assert.ok(
    mdns.asked.some((question) => question.name === 'nika-host.local' && question.type === 'A'),
    'the address of the host is asked for',
  );
  assert.deepEqual(discovery.list(), [], 'no address yet');
  discovery.onPacket({ type: 'response', answers: [{ name: 'Nika-Host.local', type: 'A', ttl: 120, data: '10.0.0.7' }] });
  assert.equal(discovery.get('n2')?.host, '10.0.0.7');
  assert.equal(discovery.get('n2')?.port, 9000);
  assert.equal(discovery.get('n2')?.room, '');
}

// ---- no A record: the address the answer came from
{
  const { discovery } = make();
  const packet = full();
  packet.additionals = packet.additionals!.filter((record) => record.type !== 'A');
  discovery.onPacket(packet, { address: '192.168.10.55', port: 5353 });
  assert.equal(discovery.get('n1')?.host, '192.168.10.55');
}

// ---- she names her Docker bridge too: the address of the home network; an old address is forgotten
{
  const { discovery } = make();
  const packet = full();
  packet.additionals!.push({ name: 'nika-jetson.local', type: 'A', ttl: 120, data: '172.17.0.1' });
  discovery.onPacket(packet, { address: '192.168.10.128', port: 5353 });
  assert.equal(discovery.get('n1')?.host, '192.168.10.128');
  clock += FORGET_AFTER_MS + 1;
  const moved = full(INSTANCE, 'n1', '192.168.10.140');
  moved.additionals = moved.additionals!.filter((record) => record.type !== 'A');
  discovery.onPacket(moved, { address: '192.168.10.140', port: 5353 });
  assert.equal(discovery.get('n1')?.host, '192.168.10.140', 'the address she answers from now');
}

// ---- a goodbye takes her off; quiet for long she is forgotten; heard again she is back
{
  const { discovery } = make();
  discovery.onPacket(full());
  discovery.onPacket({ type: 'response', answers: [{ name: SERVICE_NAME, type: 'PTR', ttl: 0, data: INSTANCE }] });
  assert.deepEqual(discovery.list(), [], 'a goodbye');
  discovery.onPacket(full());
  clock += FORGET_AFTER_MS + 1;
  assert.deepEqual(discovery.list(), [], 'not heard for too long');
  discovery.onPacket(full());
  assert.equal(discovery.list().length, 1, 'heard again');
}

// ---- one NIKA under two instance names (renamed): listed once, at the newer answer
{
  const { discovery } = make();
  discovery.onPacket(full(INSTANCE, 'n1', '192.168.10.128'));
  clock += 1000;
  discovery.onPacket(full(`Ника — Кухня.${SERVICE_NAME}`, 'n1', '192.168.10.129'));
  assert.equal(discovery.list().length, 1);
  assert.equal(discovery.get('n1')?.host, '192.168.10.129');
}

// ---- another service, a query, an empty answer: nothing
{
  const { discovery, changes } = make();
  discovery.onPacket({ type: 'response', answers: [{ name: '_camera-ui._tcp.local', type: 'PTR', ttl: 4500, data: `VION._camera-ui._tcp.local` }] });
  discovery.onPacket({ type: 'query', questions: [{ name: SERVICE_NAME, type: 'PTR' }] });
  discovery.onPacket({ type: 'response' });
  assert.deepEqual(discovery.list(), []);
  assert.equal(changes(), 0);
}

// ---- lookup: asks and waits for her; gives up after its time
{
  const { discovery, mdns } = make();
  mdns.asked = [];
  const waiting = discovery.lookup('n1', 2000);
  assert.deepEqual(mdns.asked, [{ name: SERVICE_NAME, type: 'PTR' }]);
  setTimeout(() => discovery.onPacket(full()), 20);
  const found = await waiting;
  assert.equal(found?.id, 'n1');
  const started = Date.now();
  assert.equal(await discovery.lookup('nobody', 100), undefined);
  assert.ok(Date.now() - started >= 90, 'waited its time');
}

// ---- a socket that cannot open: said, and the plugin goes on without the search
{
  const logs: string[] = [];
  const discovery = new Discovery({
    log: (line) => logs.push(line),
    open: () => {
      throw new Error('EACCES 5353');
    },
  });
  discovery.start();
  assert.ok(logs.some((line) => /cannot be searched.*EACCES/.test(line)));
  assert.equal(await discovery.lookup('n1', 50), undefined);
}

console.log('discovery: ok');
