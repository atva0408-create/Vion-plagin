// The clients against the stand-in of Yandex: the QR sign-in to an x_token, the cookies made from an x_token, the web
// API of the app with its CSRF token and an ended session, speech through a scenario of the account, the official
// API with the sign-in by code, and the local protocol of a station on a WebSocket.
// Run: npx tsx spec/clients.spec.ts
import assert from 'node:assert/strict';

import { WebSocketServer } from 'ws';

import { GlagolClient, sayPayload } from '../src/yandex/glagol.js';
import { AuthorizationPending, YandexIot, exchangeDeviceCode, refreshOAuthToken, requestDeviceCode, tokenPageUrl } from '../src/yandex/iot.js';
import { YandexQuasar } from '../src/yandex/quasar.js';
import { YandexSession } from '../src/yandex/session.js';
import { StationVoice } from '../src/voice.js';
import { OAUTH_TOKEN, STATION_TOKEN, X_TOKEN, baseState, fakeYandex } from './fake-yandex.js';

import type { AddressInfo } from 'node:net';

const realFetch = globalThis.fetch;

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

  globalThis.fetch = realFetch;
  console.log('clients.spec: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
