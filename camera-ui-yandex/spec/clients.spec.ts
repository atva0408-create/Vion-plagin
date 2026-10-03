// The clients against the stand-in of Yandex: the QR sign-in to an x_token, the cookies made from an x_token, the web
// API of the app with its CSRF token and an ended session, the live updates of the app on their socket, speech
// through a scenario of the account, the official API with the sign-in by code, and the local protocol of a station
// on a WebSocket.
// Run: npx tsx spec/clients.spec.ts
import assert from 'node:assert/strict';
import { createServer } from 'node:net';

import { WebSocketServer } from 'ws';

import { GlagolClient, sayPayload } from '../src/yandex/glagol.js';
import { YandexAuthError } from '../src/yandex/http.js';
import { AuthorizationPending, YandexIot, exchangeDeviceCode, refreshOAuthToken, requestDeviceCode, tokenPageUrl } from '../src/yandex/iot.js';
import { QuasarUpdates, YandexQuasar } from '../src/yandex/quasar.js';
import { YandexSession } from '../src/yandex/session.js';
import { StationVoice } from '../src/voice.js';
import { OAUTH_TOKEN, STATION_TOKEN, X_TOKEN, baseState, fakeUpdates, fakeYandex } from './fake-yandex.js';

import type { AddressInfo } from 'node:net';
import type { UpdateHandlers } from '../src/yandex/quasar.js';

const realFetch = globalThis.fetch;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, what: string, ms = 3_000): Promise<void> {
  for (const end = Date.now() + ms; !condition() && Date.now() < end; ) await sleep(10);
  assert.ok(condition(), `${what} did not come within ${ms} ms`);
}

/** What the live updates handed over, in order. */
function recorder() {
  const seen = { lists: 0, updates: [] as any[], scenarios: 0, lost: [] as unknown[] };
  const handlers: UpdateHandlers = {
    devices: () => void seen.lists++,
    update: (update) => void seen.updates.push(update),
    scenarios: () => void seen.scenarios++,
    lost: (error) => void seen.lost.push(error ?? 'closed'),
  };
  return { seen, handlers };
}

/** A station on a WebSocket of this machine; `answer` says what it does with a request. */
async function fakeStation(answer: (message: any, socket: import('ws').WebSocket, count: number) => void) {
  const received: any[] = [];
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));
  server.on('connection', (socket) => {
    socket.on('message', (data) => {
      const message = JSON.parse(String(data));
      received.push(message);
      answer(message, socket, received.length);
    });
  });
  return { server, received, port: (server.address() as AddressInfo).port };
}

async function main(): Promise<void> {
  // ---- QR sign-in
  {
    const state = baseState({ qrConfirmAfter: 1 });
    const fake = fakeYandex(state);
    globalThis.fetch = fake.fetch;
    const session = new YandexSession();
    const link = await session.startQr();
    assert.match(link, /track_id=track-1/);
    assert.equal(await session.checkQr(), false, 'not confirmed yet');
    assert.equal(await session.checkQr(), true, 'confirmed in the app');
    assert.equal(session.xToken, X_TOKEN);
    assert.equal((await session.account()).login, 'ivan');
    assert.ok(session.jar.header('https://iot.quasar.yandex.ru/').includes('Session_id='), 'the cookies of the session go to the app API');
    assert.equal(session.jar.header('https://example.com/'), '', 'and to no other site');

    // the session is kept and restored without a new sign-in
    const restored = new YandexSession(session.state());
    const quasar = new YandexQuasar(restored);
    const { devices } = await quasar.devices();
    assert.equal(devices.length, 7);
  }

  // ---- x_token by hand, an ended session, the CSRF token
  {
    const state = baseState();
    const fake = fakeYandex(state);
    globalThis.fetch = fake.fetch;
    await assert.rejects(new YandexSession().useXToken('wrong'), /did not accept/);

    const session = new YandexSession();
    assert.equal((await session.useXToken(X_TOKEN)).login, 'ivan');
    const quasar = new YandexQuasar(session);

    // a change carries the CSRF token of the page
    await quasar.runScenario('sc-1');
    assert.deepEqual(state.ran, ['sc-1']);
    const run = fake.calls.find((c) => c.url.endsWith('/m/user/scenarios/sc-1/actions'));
    assert.ok(run);
    assert.ok(fake.calls.some((c) => c.url === 'https://yandex.ru/quasar'), 'the CSRF token was read from the page');

    // Yandex ended the session: the cookies are made again from the x_token and the request repeated
    state.sessionEnded = true;
    const before = fake.calls.filter((c) => c.url.includes('/bundle/auth/x_token/')).length;
    await quasar.runScenario('sc-1');
    assert.equal(fake.calls.filter((c) => c.url.includes('/bundle/auth/x_token/')).length, before + 1);
    assert.deepEqual(state.ran, ['sc-1', 'sc-1']);

    // a camera's stream
    assert.equal(await quasar.streamUrl('cam-1'), 'https://app-stream.yandex/cam-1.m3u8');

    // ---- speech through a scenario of the account: made once, then changed and run
    await quasar.say('station-1', 'Движение во дворе');
    assert.equal(state.own.size, 1);
    const [id, scenario] = [...state.own.entries()][0]!;
    assert.equal(scenario.steps[0].parameters.items[0].value.capabilities[0].state.value.text, 'Движение во дворе');
    assert.equal(state.ran.at(-1), id);
    await quasar.say('station-1', 'x'.repeat(300));
    assert.equal(state.own.size, 1, 'the scenario is reused');
    assert.equal(state.own.get(id).steps[0].parameters.items[0].value.capabilities[0].state.value.text.length, 100, 'the cloud says at most 100 characters');

    // a new start finds the scenario it made before by its voice phrase
    const again = new YandexQuasar(session);
    await again.command('station-1', 'включи музыку');
    assert.equal(state.own.size, 1);
    assert.equal(state.own.get(id).steps[0].parameters.items[0].value.capabilities[0].type, 'devices.capabilities.quasar.server_action');

    // the stations of the home network
    state.stationHost = { host: '192.168.1.20', port: 1961 };
    const local = await quasar.glagolDevices();
    assert.deepEqual(local, [{ id: 'ST100', name: 'Станция', platform: 'yandexstation_2', host: '192.168.1.20', port: 1961 }]);
    assert.equal(session.musicToken, STATION_TOKEN);
    assert.equal(await quasar.glagolToken('ST100', 'yandexstation_2'), 'conv-ST100');
  }

  // ---- two texts for one station at once: one after the other, the first time with one scenario made
  {
    const state = baseState();
    const fake = fakeYandex(state);
    globalThis.fetch = fake.fetch;
    const session = new YandexSession();
    await session.useXToken(X_TOKEN);
    const quasar = new YandexQuasar(session);
    const said = () =>
      fake.calls
        .filter((c) => c.method === 'PUT' || /\/scenarios\/own-\d+\/actions$/.test(c.url))
        .map((c) => (c.method === 'PUT' ? `PUT:${c.body.steps[0].parameters.items[0].value.capabilities[0].state.value.text}` : 'RUN'));
    await Promise.all([quasar.say('station-1', 'Front door opened'), quasar.say('station-1', 'Smoke in the kitchen')]);
    assert.equal(state.own.size, 1, 'one scenario for the station, not one per text');
    assert.deepEqual(said(), ['PUT:Front door opened', 'RUN', 'PUT:Smoke in the kitchen', 'RUN'], 'each text is said once, none is lost');

    // a text that fails does not keep the next one from being said
    const realQuasar = session.quasar.bind(session);
    let failPut = true;
    session.quasar = (async (method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown) => {
      if (method === 'PUT' && failPut) {
        failPut = false;
        throw new Error('Yandex is down');
      }
      return realQuasar(method, url, body);
    }) as typeof session.quasar;
    const results = await Promise.allSettled([quasar.say('station-1', 'Lost'), quasar.say('station-1', 'Kept')]);
    assert.deepEqual(
      results.map((r) => r.status),
      ['rejected', 'fulfilled'],
    );
    assert.equal(said().at(-2), 'PUT:Kept');
  }

  // ---- the live updates of the app
  {
    const updates = await fakeUpdates();
    const state = baseState({ updatesUrl: updates.url });
    const fake = fakeYandex(state);
    globalThis.fetch = fake.fetch;
    const session = new YandexSession();
    await session.useXToken(X_TOKEN);
    const quasar = new YandexQuasar(session);
    const reads = () => fake.calls.filter((c) => c.url.endsWith('/m/v3/user/devices')).length;
    const logged: string[] = [];
    const { seen, handlers } = recorder();
    const live = new QuasarUpdates(quasar, handlers, (message) => logged.push(message), 50, 10_000);
    live.start();
    await until(() => updates.open === 1, 'the socket');
    assert.equal(seen.lists, 1, 'the list is read before the socket opens');
    assert.equal(seen.scenarios, 1, 'and the scenarios with it');

    // a change as Yandex sends it: the message is JSON text inside the JSON; an object there is read as well
    const opened = { id: 'door-1', properties: [{ type: 'devices.properties.event', parameters: { instance: 'open' }, state: { instance: 'open', value: 'opened' } }] };
    updates.states([opened]);
    updates.states([{ ...opened, id: 'motion-1' }], false);
    await until(() => seen.updates.length === 2, 'two updates');
    assert.deepEqual(
      seen.updates.map((u) => u.id),
      ['door-1', 'motion-1'],
    );
    updates.send({ operation: 'update_scenario_list', message: '{"source":"update"}' });
    await until(() => seen.scenarios === 2, 'the changed scenario list');
    updates.send('not json');
    await until(() => logged.includes('Could not read an update of the Smart Home'), 'the log of a message it cannot read');

    // the socket closed: the state is lost until the list is read again, then a new socket opens
    updates.drop();
    await until(() => seen.lists === 2 && updates.open === 1, 'the list read again and a new socket');
    assert.deepEqual(seen.lost, ['closed']);

    // stopped: the socket closes and nothing is read any more
    live.stop();
    await until(() => updates.open === 0, 'the socket closed by stop');
    const before = reads();
    await sleep(200);
    assert.equal(reads(), before, 'no reading after stop');
    assert.deepEqual(seen.lost, ['closed'], 'stop is not a lost state');

    // stopped while the list was read: what was read is not handed over
    const late = recorder();
    const stopped = new QuasarUpdates(quasar, late.handlers, () => {}, 50, 10_000);
    stopped.start();
    stopped.stop();
    await sleep(500);
    assert.equal(late.seen.lists, 0, 'a list read for a stopped connection is dropped');
    assert.equal(updates.opened, 2, 'and no socket is opened for it');
    await updates.close();
  }

  // ---- a connection that died without a close: no answer to the ping closes it, the list is read again
  {
    const updates = await fakeUpdates({ pong: false });
    const state = baseState({ updatesUrl: updates.url });
    globalThis.fetch = fakeYandex(state).fetch;
    const session = new YandexSession();
    await session.useXToken(X_TOKEN);
    const { seen, handlers } = recorder();
    const live = new QuasarUpdates(new YandexQuasar(session), handlers, () => {}, 50, 100);
    live.start();
    await until(() => updates.opened === 2, 'a new socket after the unanswered ping');
    assert.ok(updates.pings >= 1, 'pings went out');
    assert.equal(seen.lists, 2, 'the list was read again');
    assert.equal(seen.lost[0], 'closed');
    live.stop();
    await updates.close();
  }

  // ---- a refused sign-in ends the updates, a failure on the way is tried again
  {
    const state = baseState();
    const fake = fakeYandex(state);
    globalThis.fetch = fake.fetch;
    const reads = () => fake.calls.filter((c) => c.url.endsWith('/m/v3/user/devices')).length;
    const refused = recorder();
    const live = new QuasarUpdates(new YandexQuasar(new YandexSession({ xToken: 'revoked' })), refused.handlers, () => {}, 50, 10_000);
    live.start();
    await until(() => refused.seen.lost.length === 1, 'the refusal');
    assert.ok(refused.seen.lost[0] instanceof YandexAuthError);
    await sleep(300);
    assert.equal(reads(), 1, 'a refused sign-in is not presented again');
    live.stop();

    let down = true;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (down && String(input).includes('iot.quasar.yandex.ru')) throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') });
      return fake.fetch(input, init);
    }) as typeof fetch;
    const session = new YandexSession();
    await session.useXToken(X_TOKEN);
    const outage = recorder();
    const retried = new QuasarUpdates(new YandexQuasar(session), outage.handlers, () => {}, 50, 10_000);
    retried.start();
    await until(() => outage.seen.lost.length === 2, 'a second try after a failure');
    down = false;
    await until(() => outage.seen.lists === 1, 'the list once Yandex answers again');
    retried.stop();
  }

  // ---- official API and the sign-in by code
  {
    const state = baseState();
    const fake = fakeYandex(state);
    globalThis.fetch = fake.fetch;

    assert.match(tokenPageUrl('app-1'), /response_type=token&client_id=app-1&scope=iot%3Aview%20iot%3Acontrol/);
    const code = await requestDeviceCode('app-1', 'vion0001');
    assert.equal(code.userCode, 'ABCD1234');
    await assert.rejects(exchangeDeviceCode('app-1', 'secret', code.deviceCode), AuthorizationPending);
    state.codeConfirmed = true;
    const tokens = await exchangeDeviceCode('app-1', 'secret', code.deviceCode);
    assert.equal(tokens.accessToken, OAUTH_TOKEN);
    assert.equal((await refreshOAuthToken('app-1', 'secret', tokens.refreshToken!)).accessToken, 'oauth-2');

    const iot = new YandexIot(async () => tokens.accessToken);
    const home = await iot.home();
    assert.equal(home.devices.length, 7);
    assert.equal(home.devices.find((d) => d.id === 'motion-1')!.room, 'Прихожая');
    await iot.action('relay-1', [{ type: 'devices.capabilities.on_off', state: { instance: 'on', value: true } }]);
    assert.deepEqual(state.actions.at(-1), { id: 'relay-1', actions: [{ type: 'devices.capabilities.on_off', state: { instance: 'on', value: true } }] });
    await iot.runScenario('sc-1');
    assert.deepEqual(state.ran, ['sc-1']);
    assert.equal(await iot.streamUrl('cam-1'), 'https://streaming.yandex/cam-1.m3u8');

    const refused = new YandexIot(async () => 'bad');
    await assert.rejects(refused.home(), /did not accept the token/);
  }

  // ---- the local protocol of a station
  {
    const received: any[] = [];
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    server.on('connection', (socket) => {
      socket.on('message', (data) => {
        const message = JSON.parse(String(data));
        received.push(message);
        // the station refuses a token it does not know
        const status = message.conversationToken === 'conv-ST100' ? 'SUCCESS' : 'FAILURE';
        socket.send(JSON.stringify({ requestId: message.id, status }));
      });
    });

    let tokenCalls = 0;
    const client = new GlagolClient({ host: '127.0.0.1', port, secure: false }, async () => {
      tokenCalls++;
      return 'conv-ST100';
    });
    await client.send(sayPayload('Привет'));
    assert.equal(received[0].conversationToken, 'conv-ST100');
    assert.equal(received[0].payload.serverActionEventPayload.payload.form_update.slots[0].value, 'Привет');
    client.close();

    // the voice: local first, through the cloud when the station cannot be reached
    const state = baseState({ stationHost: { host: '127.0.0.1', port } });
    globalThis.fetch = fakeYandex(state).fetch;
    const session = new YandexSession();
    await session.useXToken(X_TOKEN);
    const quasar = new YandexQuasar(session);
    const station = (await quasar.devices()).devices.find((d) => d.id === 'station-1')!;
    let mode: 'auto' | 'local' | 'cloud' = 'auto';
    const voice = new StationVoice(
      () => quasar,
      () => ({ mode, hosts: undefined, secure: false }),
      () => {},
    );
    assert.equal(await voice.say(station, 'Дверь открыта'), 'local');
    assert.equal(received.at(-1).payload.serverActionEventPayload.payload.form_update.slots[0].value, 'Дверь открыта');
    assert.equal(state.own.size, 0, 'the local way makes no scenario');

    server.close();
    voice.close();
    mode = 'local';
    await assert.rejects(voice.say(station, 'Тест'));
    mode = 'auto';
    assert.equal(await voice.say(station, 'Тест'), 'cloud', 'without the station in reach the cloud speaks');
    assert.equal(state.own.size, 1);
    mode = 'cloud';
    assert.equal(await voice.say(station, 'Ещё'), 'cloud');
    assert.ok(tokenCalls >= 1);
  }

  // ---- a client closed while it connects: the socket does not open afterwards and stay open for good
  {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1', verifyClient: (_info, done) => void setTimeout(() => done(true), 300) });
    await new Promise((resolve) => server.once('listening', resolve));
    const client = new GlagolClient({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, secure: false }, async () => 'conv-ST100');
    const sending = client.send(sayPayload('Привет'));
    await sleep(50);
    client.close();
    await assert.rejects(sending, 'what was being sent fails at once');
    await sleep(500);
    assert.equal(server.clients.size, 0, 'no connection is left open');
    server.close();
  }

  // ---- the voice tries the station again only when it refused the token
  {
    const state = baseState();
    const fake = fakeYandex(state);
    globalThis.fetch = fake.fetch;
    const session = new YandexSession();
    await session.useXToken(X_TOKEN);
    const quasar = new YandexQuasar(session);
    const station = (await quasar.devices()).devices.find((d) => d.id === 'station-1')!;
    const tokenRequests = () => fake.calls.filter((c) => c.url.includes('/glagol/token')).length;
    const voiceFor = (port: number, mode: 'auto' | 'local' = 'local') =>
      new StationVoice(
        () => quasar,
        () => ({ mode, hosts: `ST100 = 127.0.0.1:${port}`, secure: false }),
        () => {},
      );

    // a station that answered with a failure may have said the text already: no second try
    const failing = await fakeStation((message, socket) => socket.send(JSON.stringify({ requestId: message.id, status: 'FAILURE' })));
    const voice = voiceFor(failing.port);
    await assert.rejects(voice.say(station, 'Один раз'), /answered "FAILURE"/);
    assert.equal(failing.received.length, 1, 'the text went to the station once');
    voice.close();
    failing.server.close();

    // a station that closed over the token gets a new one, once
    const before = tokenRequests();
    const refusing = await fakeStation((message, socket, count) => {
      if (count === 1) socket.close(4000, 'Invalid token');
      else socket.send(JSON.stringify({ requestId: message.id, status: 'SUCCESS' }));
    });
    const renewed = voiceFor(refusing.port);
    assert.equal(await renewed.say(station, 'Снова'), 'local');
    assert.equal(refusing.received.length, 2);
    assert.equal(tokenRequests() - before, 2, 'the refused token was asked anew');
    renewed.close();
    refusing.server.close();

    // a station that does not connect is not tried again at the next text: it would make every notification wait
    let connections = 0;
    const silent = createServer((socket) => {
      connections++;
      socket.destroy();
    });
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const unreachable = voiceFor((silent.address() as AddressInfo).port, 'auto');
    assert.equal(await unreachable.say(station, 'Первый'), 'cloud');
    assert.equal(connections, 1, 'one try, no second one');
    assert.equal(await unreachable.say(station, 'Второй'), 'cloud');
    assert.equal(connections, 1, 'the address that did not answer is skipped for a while');
    unreachable.close();
    silent.close();
  }

  globalThis.fetch = realFetch;
  console.log('clients.spec: ok');
}

// a step that hangs (a socket left open keeps the process alive) ends the run red instead of never ending
setTimeout(() => {
  console.log('not ok - clients.spec did not end within 150 s');
  process.exit(1);
}, 150_000).unref();

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
