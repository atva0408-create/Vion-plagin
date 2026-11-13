// The connection, against a NIKA on a real socket (spec/fake-nika.ts): pairing by the code she says (a wrong code, the
// tries running out), the lasting link (offer, a notice taken or refused, a call answered), her restart (the link comes
// back by itself), a device that announces itself as her without the key, a NIKA that forgot this VION, another NIKA at
// her address, a key she does not accept, and stopping.
// Run: npx tsx spec/link.spec.ts
import assert from 'node:assert/strict';

import { FakeNika } from './fake-nika.js';
import { NikaLink, Pairing, RefusedError } from '../src/link.js';
import { newToken } from '../src/protocol.js';

import type { Call, CallResult, LinkHost, PairedNika } from '../src/link.js';
import type { Message } from '../src/protocol.js';

const VION = 'vion-test';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, what: string, ms = 5_000): Promise<void> {
  for (const end = Date.now() + ms; !condition() && Date.now() < end; ) await sleep(10);
  assert.ok(condition(), `${what} did not come within ${ms} ms`);
}

function linkTo(nika: FakeNika, token: string, answer: (call: Call) => CallResult = () => ({ ok: true, text: 'сделано' })) {
  const logs: string[] = [];
  const calls: Call[] = [];
  let forgotten = 0;
  let changes = 0;
  const paired: PairedNika = { id: nika.id, name: 'Ника', room: 'Детская', token, speaks: true, pairedAt: 0 };
  const host: LinkHost = {
    vionId: VION,
    log: (line) => logs.push(line),
    address: async () => ({ host: '127.0.0.1', port: nika.port }),
    offer: (): Message => ({ t: 'offer', commands: [{ name: 'screen_time_status' }] }),
    onCall: async (_link, call) => {
      calls.push(call);
      return answer(call);
    },
    onChange: () => (changes += 1),
    onForgotten: () => (forgotten += 1),
  };
  const link = new NikaLink(paired, host);
  return { link, logs, calls, forgotten: () => forgotten, changes: () => changes };
}

// ---- pairing: a wrong code, then the right one; the token is hers and ours
{
  const nika = new FakeNika({ tries: 3 });
  const port = await nika.listen();
  const pairing = await Pairing.start({ host: '127.0.0.1', port }, VION, 'VION');
  assert.equal(pairing.hello.id, nika.id);
  assert.equal(pairing.hello.room, 'Детская');
  assert.equal(pairing.hello.tz, 'Europe/Moscow');
  assert.match(nika.code ?? '', /^\d{6}$/);
  const wrong = nika.code === '000000' ? '111111' : '000000';
  assert.deepEqual(await pairing.submit(wrong), { left: 2 });
  assert.ok(pairing.open, 'still open for another try');
  const done = await pairing.submit(` ${nika.code!.slice(0, 3)} ${nika.code!.slice(3)} `);
  assert.ok('token' in done && done.token === nika.tokens.get(VION), 'the token she keeps for this VION; spaces in the code do not matter');
  assert.ok(!pairing.open, 'the pairing connection ends');
  await nika.close();
}

// ---- pairing: the tries run out
{
  const nika = new FakeNika({ tries: 2 });
  const port = await nika.listen();
  const pairing = await Pairing.start({ host: '127.0.0.1', port }, VION, 'VION');
  const wrong = nika.code === '000000' ? '111111' : '000000';
  assert.deepEqual(await pairing.submit(wrong), { left: 1 });
  assert.deepEqual(await pairing.submit(wrong), { left: 0 });
  assert.ok(!pairing.open);
  assert.equal(nika.tokens.size, 0);
  await nika.close();
}

// ---- pairing: nobody at the address, something that is not NIKA
{
  await assert.rejects(Pairing.start({ host: '127.0.0.1', port: 1 }, VION, 'VION'), /ECONNREFUSED|connect/);
  const { createServer } = await import('node:net');
  const other = createServer((socket) => socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'));
  await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', () => resolve()));
  const port = (other.address() as { port: number }).port;
  await assert.rejects(Pairing.start({ host: '127.0.0.1', port }, VION, 'VION'), /JSON|not NIKA|type/);
  other.close();
}

// ---- the lasting link: offer, notices, calls, her restart
{
  const token = newToken();
  const nika = new FakeNika({ tokens: new Map([[VION, token]]) });
  await nika.listen();
  const { link, calls, logs } = linkTo(nika, token);
  link.start();
  await until(() => link.online && nika.online, 'the link');
  await until(() => nika.got.some((message) => message.t === 'offer'), 'the offer');
  assert.equal(link.hello?.lang, 'ru');

  const ack = await link.request({ t: 'notify', title: 'Сыночка', text: 'Сыночка не ушёл на перерыв', severity: 'warn' });
  assert.equal(ack.ok, true);
  assert.ok(nika.got.some((message) => message.t === 'notify' && message.text === 'Сыночка не ушёл на перерыв'));

  nika.send({ t: 'call', id: 'c1', name: 'screen_time_status', args: { child: 'Сыночка' }, speaker: 'Папа' });
  await until(() => nika.got.some((message) => message.t === 'result'), 'the result');
  assert.deepEqual(calls, [{ id: 'c1', name: 'screen_time_status', args: { child: 'Сыночка' }, speaker: 'Папа' }]);
  assert.deepEqual(
    nika.got.find((message) => message.t === 'result'),
    { t: 'result', id: 'c1', ok: true, text: 'сделано' },
  );

  nika.send({ t: 'ping' });
  await sleep(50);
  nika.send({ t: 'something_new', x: 1 });
  await sleep(50);
  assert.ok(link.online, 'a message of a newer NIKA ends nothing');

  // her restart: the link comes back by itself
  nika.drop();
  await until(() => !link.online, 'the drop seen');
  await until(() => link.online && nika.sessions === 2, 'the link back', 10_000);
  assert.ok(logs.some((line) => /connected at 127\.0\.0\.1/.test(line)));

  link.stop();
  await sleep(100);
  assert.equal(link.state, 'stopped');
  nika.drop();
  await sleep(2_500);
  assert.equal(nika.sessions, 2, 'a stopped link does not come back');
  await nika.close();
}

// ---- a refused notice comes back as she said it; a call that throws is answered with its error
{
  const token = newToken();
  const nika = new FakeNika({ tokens: new Map([[VION, token]]), ackError: 'занята: идёт тревога' });
  await nika.listen();
  const { link } = linkTo(nika, token, () => {
    throw new Error('VOICE не отвечает');
  });
  link.start();
  await until(() => link.online, 'the link');
  const ack = await link.request({ t: 'say', text: 'тест' });
  assert.deepEqual([ack.ok, ack.error], [false, 'занята: идёт тревога']);
  nika.send({ t: 'call', id: 'c2', name: 'x', args: {} });
  await until(() => nika.got.some((message) => message.t === 'result'), 'the result');
  assert.deepEqual(
    nika.got.find((message) => message.t === 'result'),
    { t: 'result', id: 'c2', ok: false, error: 'VOICE не отвечает' },
  );
  link.stop();
  await nika.close();
}

// ---- a device that announces itself as her without the key: never online
{
  const token = newToken();
  const nika = new FakeNika({ tokens: new Map([[VION, token]]), impostor: true });
  await nika.listen();
  const { link } = linkTo(nika, token);
  link.start();
  await until(() => !!link.lastError, 'the refusal');
  assert.match(link.lastError!, /does not hold the key/);
  assert.ok(!link.online);
  assert.ok(!nika.got.length, 'nothing was sent to it');
  link.stop();
  await nika.close();
}

// ---- she forgot this VION: told once, no more tries
{
  const nika = new FakeNika();
  await nika.listen();
  const { link, forgotten } = linkTo(nika, newToken());
  link.start();
  await until(() => forgotten() === 1, 'forgotten');
  await sleep(2_500);
  assert.equal(forgotten(), 1);
  assert.equal(link.state, 'offline');
  await nika.close();
}

// ---- a key she does not accept; another NIKA at her address
{
  const nika = new FakeNika({ tokens: new Map([[VION, newToken()]]) });
  await nika.listen();
  const wrongKey = linkTo(nika, newToken());
  wrongKey.link.start();
  await until(() => !!wrongKey.link.lastError, 'the refusal');
  assert.match(wrongKey.link.lastError!, /refused the key \(bad_proof\)/);
  wrongKey.link.stop();

  const other = linkTo(nika, newToken());
  other.link.nika.id = 'another-nika';
  other.link.start();
  await until(() => !!other.link.lastError, 'the mismatch');
  assert.match(other.link.lastError!, /another NIKA answers/);
  other.link.stop();
  await nika.close();
}

// ---- a request to a NIKA that is not connected fails at once
{
  const nika = new FakeNika();
  const { link } = linkTo(nika, newToken());
  await assert.rejects(link.request({ t: 'say', text: 'x' }), /not connected/);
  assert.ok(new RefusedError('x', 'y') instanceof Error);
}

console.log('link: ok');
