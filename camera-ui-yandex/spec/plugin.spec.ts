// The plugin as ViON drives it, against the stand-in of Yandex: the sign-in by code to the official API, sensors
// offered, adopted and kept up to date, commands and scenarios, a camera of the Smart Home with its stream, the
// sign-in by QR code, notifications said by a station, the tools of the assistant, and signing out. Then what breaks
// on the way: live updates that close or die, tokens Yandex refuses or renews, Sign out while Yandex answers, speech
// to several stations at once, and commands that fail.
// Run: npx tsx spec/plugin.spec.ts
import assert from 'node:assert/strict';

import { LightCapability, LightProperty, SensorType, SwitchProperty } from '@camera.ui/sdk';

import YandexPlugin from '../src/index.js';
import { YandexSession } from '../src/yandex/session.js';
import { OAUTH_TOKEN, X_TOKEN, baseState, fakeUpdates, fakeYandex } from './fake-yandex.js';

import type { AdoptedSensor, CameraDevice, DiscoveredCamera, DoorbellTrigger, FormSubmitResponse, JsonSchema, StreamingInterface } from '@camera.ui/sdk';

const realFetch = globalThis.fetch;
const silent = { log() {}, warn() {}, success() {}, debug() {}, trace() {}, attention() {}, error() {} };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, what: string, ms = 3_000): Promise<void> {
  for (const end = Date.now() + ms; !condition() && Date.now() < end; ) await sleep(10);
  assert.ok(condition(), `${what} did not come within ${ms} ms`);
}

/** A logger that keeps what the plugin says at each level. */
function recorder() {
  const lines: Record<string, string[]> = { log: [], warn: [], error: [], debug: [] };
  const level =
    (name: string) =>
    (...args: unknown[]) =>
      lines[name]!.push(args.map(String).join(' '));
  return { lines, logger: { ...silent, log: level('log'), warn: level('warn'), error: level('error'), debug: level('debug') } };
}

function host(values: Record<string, unknown> = {}, logger: typeof silent = silent) {
  const listeners = new Map<string, () => unknown>();
  const pushed: DiscoveredCamera[][] = [];
  const hookCalls = new Map<string, number>();
  const offers = { failing: 0, tried: 0 };
  // like the storage of ViON: setValue keeps only fields of the schema and runs their hook, detached;
  // other values go through setInternalValue
  const storage = {
    values,
    async setValue(key: string, value: unknown) {
      const field = plugin.storageSchema.find((f) => f.key === key) as any;
      if (!field) return;
      const old = values[key];
      values[key] = value;
      if (typeof field.onSet === 'function') void Promise.resolve(field.onSet(value, old)).catch(() => {});
      hookCalls.set(key, (hookCalls.get(key) ?? 0) + 1);
    },
    async setInternalValue(key: string, value: unknown) {
      values[key] = value;
    },
  };
  const api = {
    on(event: string, listener: () => unknown) {
      listeners.set(event, listener);
      return api;
    },
    deviceManager: {
      async pushDiscoveredCameras(cameras: DiscoveredCamera[]) {
        offers.tried++;
        if (offers.failing > 0) {
          offers.failing--;
          throw new Error('the server is restarting');
        }
        pushed.push(cameras);
      },
    },
  };
  const plugin = new YandexPlugin(logger, api as never, storage as never);
  const field = (key: string) => plugin.storageSchema.find((f) => f.key === key) as JsonSchema & Record<string, any>;
  return {
    plugin,
    /** the plugin with what it keeps to itself, for what a test has to look at or drive */
    inside: plugin as any,
    values,
    pushed,
    offers,
    hookCalls,
    launch: async () => listeners.get('finishLaunching')?.(),
    shutdown: async () => listeners.get('shutdown')?.(),
    submit: (key: string, form: Record<string, unknown>) => field(key).onClick(form) as Promise<FormSubmitResponse | undefined>,
    press: (key: string) => field(key).onSet(undefined, undefined) as Promise<void>,
    set: (key: string, value: unknown) => field(key).onSet(value, undefined) as Promise<void>,
    /** a value typed into a field of the settings: ViON stores it, then runs the hook */
    type: async (key: string, value: unknown) => {
      const old = values[key];
      values[key] = value;
      await field(key).onSet(value, old);
    },
  };
}

function keys(response: FormSubmitResponse | undefined): string[] {
  return (response?.schema ?? []).map((f) => f.key);
}

function valueOf(response: FormSubmitResponse | undefined, key: string): unknown {
  return response?.schema?.find((f) => f.key === key)?.defaultValue;
}

// width of a PNG given as a data URL, from its IHDR header
function pngWidth(dataUrl: string): number {
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64').readUInt32BE(16);
}

function adopt(nativeId: string, type: SensorType, name = nativeId): AdoptedSensor {
  return { id: `vion-${nativeId}`, nativeId, address: nativeId.split('|')[0], name, type } as AdoptedSensor;
}

/** The values a plugin keeps after the sign-in as the Yandex app, made against the stand-in in use. */
async function appSignIn(): Promise<Record<string, unknown>> {
  const session = new YandexSession();
  await session.useXToken(X_TOKEN);
  const state = session.state();
  return { xToken: state.xToken, cookies: state.cookies, account: 'ivan' };
}

/** The stand-in answering requests whose address contains `part` only after `ms`: time to press Sign out meanwhile. */
function slow(fetch: typeof globalThis.fetch, part: string, ms: number): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input instanceof Request ? input.url : input).includes(part)) await sleep(ms);
    return fetch(input, init);
  }) as typeof globalThis.fetch;
}

const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const tests: [string, () => Promise<void>][] = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

test('the whole way: sign-in by code, sensors, commands, a camera, the QR sign-in, stations, the assistant, sign out', async () => {
  const state = baseState();
  const fake = fakeYandex(state);
  globalThis.fetch = fake.fetch;
  const { lines, logger } = recorder();

  const h = host({ clientId: 'app-1', clientSecret: 'secret' }, logger);
  await h.launch();
  const plugin = h.plugin as any;

  // ---- the official sign-in by code
  const first = await h.submit('officialLogin', {});
  assert.deepEqual(keys(first), ['verificationUrl', 'userCode']);
  assert.equal(first?.schema?.[1]?.defaultValue, 'ABCD1234');
  const early = await h.submit('officialLogin', { userCode: 'ABCD1234' });
  assert.equal(early?.toast?.type, 'warning', 'the code is not entered yet');
  assert.deepEqual(keys(early), ['verificationUrl', 'userCode'], 'the window keeps the code');
  state.codeConfirmed = true;
  const done = await h.submit('officialLogin', { userCode: 'ABCD1234' });
  assert.deepEqual(keys(done), ['done']);
  assert.equal(done?.schema?.[0]?.defaultValue, '7');
  assert.equal(h.values.oauthToken, OAUTH_TOKEN);
  assert.equal(h.values.refreshToken, 'rt-1');
  assert.equal(await h.submit('officialLogin', { done: '' }), undefined, 'the button of the last window closes it');
  await sleep(700);

  // without a secret: the page of the token and a field for it
  const paste = host({ clientId: 'app-1' });
  const pasteWindow = await paste.submit('officialLogin', {});
  assert.deepEqual(keys(pasteWindow), ['tokenPage', 'pastedToken']);
  assert.match(String(pasteWindow?.schema?.[0]?.description), /Redirect URI https:\/\/oauth\.yandex\.ru\/verification_code/, 'the window says what the page needs');
  assert.equal((await paste.submit('officialLogin', { pastedToken: 'bad' }))?.toast?.type, 'error');
  assert.deepEqual(keys(await paste.submit('officialLogin', { pastedToken: OAUTH_TOKEN })), ['done']);
  assert.equal(paste.values.oauthToken, OAUTH_TOKEN);
  await sleep(600);

  // ---- sensors offered and adopted
  const offered = await plugin.onDiscoverSensors();
  const ids = offered.map((s: any) => s.id).sort();
  assert.deepEqual(ids, ['button-1|button', 'door-1|open', 'lamp-1|on', 'motion-1|illumination', 'motion-1|motion', 'relay-1|on', 'scenario|sc-1']);
  assert.equal(offered.find((s: any) => s.id === 'motion-1|motion').room, 'Прихожая');
  assert.equal(offered.find((s: any) => s.id === 'scenario|sc-1').name, 'Scenario: Я ушёл');

  const records: AdoptedSensor[] = offered.map((s: any, i: number) => ({ id: `s${i}`, nativeId: s.id, address: s.address, name: s.name, type: s.type }));
  const sensors = await plugin.configureAdoptedSensors(records);
  assert.equal(sensors.length, 7);
  const sensor = (nativeId: string) => sensors[records.findIndex((r) => r.nativeId === nativeId)];
  assert.equal(sensor('door-1|open').sourceState, 'connected');
  assert.equal(sensor('door-1|open').getValue('detected'), false);
  assert.equal(sensor('lamp-1|on').getValue(LightProperty.Brightness), 60);
  assert.equal(sensor('lamp-1|on').hasCapability(LightCapability.Brightness), true, 'a Yandex light with brightness shows the slider');
  assert.equal(sensor('scenario|sc-1').sourceState, 'connected');

  // a change at Yandex reaches the sensor at the next reading
  state.devices.find((d) => d.id === 'door-1')!.properties[0].state.value = 'opened';
  state.devices.find((d) => d.id === 'motion-1')!.properties[0].state.value = 'detected';
  await plugin.read();
  assert.equal(sensor('door-1|open').getValue('detected'), true);
  assert.equal(sensor('motion-1|motion').getValue('detected'), true);

  // a device removed from the account
  const removed = state.devices.splice(
    state.devices.findIndex((d) => d.id === 'door-1'),
    1,
  )[0];
  await plugin.read();
  assert.equal(sensor('door-1|open').sourceState, 'removed');
  state.devices.push(removed);
  await plugin.read();
  assert.equal(sensor('door-1|open').sourceState, 'connected');

  // ---- commands and scenarios
  await sensor('relay-1|on').updateValue(SwitchProperty.On, true);
  assert.deepEqual(state.actions.at(-1), { id: 'relay-1', actions: [{ type: 'devices.capabilities.on_off', state: { instance: 'on', value: true } }] });
  await sensor('lamp-1|on').updateValue(LightProperty.Brightness, 30);
  assert.deepEqual(
    state.actions.at(-1)!.actions.map((a: any) => a.state),
    [
      { instance: 'on', value: true },
      { instance: 'brightness', value: 30 },
    ],
    'brightness turns the light on too',
  );
  await sensor('lamp-1|on').updateValue(LightProperty.Brightness, 0);
  assert.deepEqual(
    state.actions.at(-1)!.actions,
    [{ type: 'devices.capabilities.on_off', state: { instance: 'on', value: false } }],
    'brightness 0 turns the light off, not on at the faintest',
  );
  await sensor('scenario|sc-1').updateValue(SwitchProperty.On, true);
  assert.deepEqual(state.ran, ['sc-1']);
  assert.equal(sensor('scenario|sc-1').getValue(SwitchProperty.On), true);
  await sleep(1700);
  assert.equal(sensor('scenario|sc-1').getValue(SwitchProperty.On), false, 'the scenario switch turns itself off');

  // ---- a camera of the Smart Home
  const cameras = await plugin.onDiscoverCameras();
  assert.deepEqual(
    cameras.map((c: DiscoveredCamera) => c.id),
    ['yandex:cam-1'],
  );
  const config = await plugin.onAdoptCamera(cameras[0], {});
  assert.equal(config.nativeId, 'cam-1');
  assert.equal(config.isCloud, true);
  let implemented: StreamingInterface | undefined;
  const device = {
    id: 'vion-cam',
    name: config.name,
    nativeId: 'cam-1',
    async implement(impl: StreamingInterface) {
      implemented = impl;
    },
    connect() {},
  } as unknown as CameraDevice;
  await plugin.onCameraAdded(device);
  assert.equal(await implemented!.streamUrl('HLS'), 'https://streaming.yandex/cam-1.m3u8');
  assert.deepEqual(await plugin.onDiscoverCameras(), [], 'an added camera is not offered again');

  // ---- stations: without the sign-in as the app none is offered, it could not speak
  assert.deepEqual(await plugin.getDevices(['user-1']), []);
  lines.error.length = 0;
  await plugin.sendNotification(['station:station-1'], { title: 'Движение', body: 'Камера во дворе' });
  assert.deepEqual(lines.error, [], 'nothing fails, nothing was chosen');

  // ---- sign-in by QR code
  const qr = await h.submit('qrLogin', {});
  assert.deepEqual(keys(qr), ['qrLink', 'qrImage'], 'the link to open in the browser comes first');
  // a web address: ViON gives such a field the button that opens it
  assert.match(String(valueOf(qr, 'qrLink')), /^https:\/\/passport\.yandex\.ru\//);
  assert.match(String(valueOf(qr, 'qrImage')), /^data:image\/png;base64,/);
  assert.equal(pngWidth(String(valueOf(qr, 'qrImage'))), 240, 'the code is small enough for the window on a phone');
  const signed = await h.submit('qrLogin', { qrLink: valueOf(qr, 'qrLink') });
  assert.deepEqual(keys(signed), ['done']);
  assert.equal(h.values.xToken, X_TOKEN);
  assert.equal(h.values.account, 'ivan');
  assert.ok(String(h.values.cookies).includes('Session_id'));
  await sleep(700);
  assert.equal(h.hookCalls.get('xToken'), 1, 'storing the x_token does not sign in again');

  // an x_token typed into its field signs in
  const typed = host();
  await typed.set('xToken', X_TOKEN);
  assert.equal(typed.values.account, 'ivan');
  await sleep(100);
  assert.equal(typed.hookCalls.get('xToken'), 1);
  await sleep(600);

  // the official API still reads the devices; the app lends the stations for the voice. A station is offered, but
  // speaks only once it is turned on
  await plugin.read();
  assert.deepEqual(
    (await plugin.getDevices(['user-1'])).map((d: any) => [d.id, d.ownerUserId, d.active]),
    [['station:station-1', 'user-1', false]],
  );
  await plugin.sendNotification(['station:station-1'], { title: 'Движение!', body: 'Камера во дворе' });
  assert.equal(state.own.size, 0, 'a station not turned on says nothing');
  await plugin.updateDevice('station:station-1', { active: true });
  assert.deepEqual(h.values.speakingStations, ['station-1']);
  await plugin.sendNotification(['station:station-1'], { title: 'Движение!', body: 'Камера во дворе' });
  const own = [...state.own.values()];
  assert.equal(own.length, 1);
  assert.equal(own[0].steps[0].parameters.items[0].value.capabilities[0].state.value.text, 'Движение. Камера во дворе');
  await plugin.sendNotification(['station:station-1'], { title: 'Тихо', silent: true });
  assert.equal(own[0].steps[0].parameters.items[0].value.capabilities[0].state.value.text, 'Движение. Камера во дворе', 'a silent notification is not said');

  // a station turned off says nothing
  await plugin.updateDevice('station:station-1', { active: false, name: 'Кухня' });
  assert.deepEqual(h.values.speakingStations, []);
  assert.equal((await plugin.getDevice('station:station-1')).name, 'Кухня');
  await plugin.sendNotification(['station:station-1'], { title: 'Не надо' });
  assert.equal([...state.own.values()][0].steps[0].parameters.items[0].value.capabilities[0].state.value.text, 'Движение. Камера во дворе');
  await plugin.updateDevice('station:station-1', { active: true });

  // the test window of the settings
  assert.deepEqual(keys(await h.submit('speak', {})), ['station', 'phrase']);
  assert.equal((await h.submit('speak', { station: 'station-1', phrase: 'Проверка' }))?.toast?.type, 'success');

  // ---- assistant
  const tools = plugin.assistantTools().map((t: any) => t.name);
  assert.deepEqual(tools, ['yandex_say', 'yandex_command', 'yandex_run_scenario', 'yandex_devices']);
  assert.match((await plugin.callAssistantTool('yandex_say', { text: 'Ужин готов', station: 'кухня' }, {})).content, /done \(cloud\)/);
  assert.match((await plugin.callAssistantTool('yandex_say', { text: 'x', station: 'Ванная' }, {})).error, /No station "Ванная"/);
  assert.match((await plugin.callAssistantTool('yandex_run_scenario', { name: 'ушёл' }, {})).content, /Я ушёл/);
  assert.deepEqual(state.ran.at(-1), 'sc-1');
  const listed = (await plugin.callAssistantTool('yandex_devices', {}, {})).content;
  assert.equal(listed.devices.find((d: any) => d.name === 'Лампа').state.on, true);
  assert.deepEqual(listed.scenarios, ['Я ушёл']);

  // ---- the app as the source: live updates
  await h.set('source', 'app');
  h.values.source = 'app';
  await sleep(700);
  await plugin.read();
  plugin.applyUpdate({ id: 'door-1', properties: [{ type: 'devices.properties.event', parameters: { instance: 'open' }, state: { instance: 'open', value: 'closed' } }] });
  assert.equal(sensor('door-1|open').getValue('detected'), false, 'an update of the app changes the sensor at once');

  // ---- sign out
  await h.press('logout');
  assert.equal(h.values.xToken, '');
  assert.equal(h.values.oauthToken, '');
  assert.deepEqual(h.values.speakingStations, [], 'the stations of the next sign-in speak once chosen again');
  assert.equal(sensor('door-1|open').sourceState, 'unavailable');
  assert.deepEqual(await plugin.onDiscoverSensors(), [], 'nothing read with the account is offered after it was left, scenarios included');

  await h.shutdown();
  await paste.shutdown();
  await typed.shutdown();
});

test('live updates: a change at once; after the socket closed the sensors are unavailable until the list is read, and a press made meanwhile does not ring', async () => {
  const updates = await fakeUpdates();
  const state = baseState({ updatesUrl: updates.url });
  globalThis.fetch = fakeYandex(state).fetch;
  const h = host({ ...(await appSignIn()), source: 'app' });
  const [door, button] = await h.plugin.configureAdoptedSensors([adopt('door-1|open', SensorType.Contact), adopt('button-1|button', SensorType.Doorbell)]);
  let rings = 0;
  (button as DoorbellTrigger).trigger = () => void rings++;
  await h.launch();
  await until(() => updates.open === 1 && door!.sourceState === 'connected', 'the sensors connected');

  const press = (at: number) => ({
    id: 'button-1',
    properties: [{ type: 'devices.properties.event', parameters: { instance: 'button' }, state: { instance: 'button', value: 'click' }, last_updated: at }],
  });
  updates.states([{ id: 'door-1', properties: [{ type: 'devices.properties.event', parameters: { instance: 'open' }, state: { instance: 'open', value: 'opened' } }] }]);
  updates.states([press(2000)]);
  await until(() => door!.getValue('detected') === true && rings === 1, 'the change and the press');

  // the socket closes: what the sensors show is not followed any more; meanwhile the button is pressed
  updates.drop();
  await until(() => door!.sourceState === 'unavailable', 'the sensors unavailable');
  state.devices.find((d) => d.id === 'button-1')!.properties[0].last_updated = 3000;
  // the list read again (the plugin waits 30 s before it, the test does not)
  await h.inside.updates.connect();
  await until(() => door!.sourceState === 'connected' && updates.open === 1, 'connected again');
  assert.equal(rings, 1, 'a press made while the socket was closed does not ring now');
  updates.states([press(4000)]);
  await until(() => rings === 2, 'a new press rings');

  await h.shutdown();
  await until(() => updates.open === 0, 'the socket closed by the shutdown');
  await updates.close();
});

test('the official API read again after a failed reading: a press made during the outage does not ring, the next one does', async () => {
  const state = baseState();
  const fake = fakeYandex(state);
  let down = false;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (down && String(input).startsWith('https://api.iot.yandex.net')) throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND api.iot.yandex.net') });
    return fake.fetch(input, init);
  }) as typeof fetch;
  const { lines, logger } = recorder();
  const h = host({ oauthToken: OAUTH_TOKEN, pollSeconds: 300 }, logger);
  const [button] = await h.plugin.configureAdoptedSensors([adopt('button-1|button', SensorType.Doorbell)]);
  let rings = 0;
  (button as DoorbellTrigger).trigger = () => void rings++;
  await h.launch();
  await h.inside.read();
  const pressAt = (at: number) => (state.devices.find((d) => d.id === 'button-1')!.properties[0].last_updated = at);
  pressAt(2000);
  await h.inside.read();
  assert.equal(rings, 1, 'a press between two readings rings');

  down = true;
  await h.inside.read();
  assert.equal(button!.sourceState, 'unavailable');
  assert.match(lines.warn.join('\n'), /Could not read the Smart Home: fetch failed: getaddrinfo ENOTFOUND/, 'the log says why');
  pressAt(3000);
  down = false;
  await h.inside.read();
  assert.equal(button!.sourceState, 'connected');
  assert.equal(rings, 1, 'the press during the outage does not ring late');
  pressAt(4000);
  await h.inside.read();
  assert.equal(rings, 2);
  await h.shutdown();
});

test('a sign-in as the app Yandex refused: one error, the sensors unavailable, the stored sign-in dropped, Yandex not asked again', async () => {
  const state = baseState();
  const fake = fakeYandex(state);
  globalThis.fetch = fake.fetch;
  const { lines, logger } = recorder();
  const h = host({ xToken: 'revoked', account: 'ivan', source: 'app' }, logger);
  const [door] = await h.plugin.configureAdoptedSensors([adopt('door-1|open', SensorType.Contact)]);
  await h.launch();
  await until(() => h.values.xToken === '', 'the refused sign-in dropped');
  const asked = () => fake.calls.filter((c) => c.url.startsWith('https://iot.quasar.yandex.ru')).length;
  const before = asked();
  // past the restart that follows the drop
  await sleep(800);
  assert.equal(asked(), before, 'the refused sign-in is not presented again');
  assert.equal(lines.error.length, 1, 'said once');
  assert.match(lines.error[0]!, /no longer accepts the sign-in as the Yandex app.*oauth_token\.invalid/);
  assert.equal(door!.sourceState, 'unavailable');
  assert.equal(h.values.account, '');
  await h.shutdown();
});

test('a token of the official API Yandex refused: one error, the polling stops, the sign-in as the app takes over', async () => {
  const state = baseState();
  const fake = fakeYandex(state);
  globalThis.fetch = fake.fetch;
  const { lines, logger } = recorder();
  const h = host({ oauthToken: 'revoked', pollSeconds: 3, ...(await appSignIn()) }, logger);
  const [door] = await h.plugin.configureAdoptedSensors([adopt('door-1|open', SensorType.Contact)]);
  await h.launch();
  await until(() => h.values.oauthToken === '', 'the refused token dropped');
  await until(() => door!.sourceState === 'connected', 'the sensors read through the app');
  const official = () => fake.calls.filter((c) => c.url.startsWith('https://api.iot.yandex.net')).length;
  const before = official();
  // longer than the reading interval
  await sleep(3_500);
  assert.equal(official(), before, 'the official API is not read again');
  assert.equal(lines.error.length, 1, 'said once');
  assert.match(lines.error[0]!, /no longer accepts the token of the official API/);
  assert.ok(lines.log.some((line) => line.includes('through the Yandex app')));
  await h.shutdown();
});

test('the token of the official API is renewed through the plugin; a refused renewal is final, one that failed on the way waits an hour', async () => {
  const state = baseState();
  const fake = fakeYandex(state);
  let renewals = 0;
  let yandexId: 'up' | 'down' = 'up';
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === 'https://oauth.yandex.ru/token') {
      renewals++;
      if (yandexId === 'down') return json({ error: 'server_error' }, 500);
    }
    return fake.fetch(input, init);
  }) as typeof fetch;
  const base = { clientId: 'app-1', clientSecret: 'secret', oauthToken: OAUTH_TOKEN, pollSeconds: 300 };

  const h = host({ ...base, refreshToken: 'rt-1', tokenExpiresAt: Date.now() + 60_000 });
  const [door] = await h.plugin.configureAdoptedSensors([adopt('door-1|open', SensorType.Contact)]);
  await h.launch();
  await until(() => h.values.oauthToken === 'oauth-2', 'the renewed token');
  assert.equal(h.values.refreshToken, 'rt-2');
  assert.ok(Number(h.values.tokenExpiresAt) > Date.now() + 300 * 24 * 3600_000);
  await until(() => door!.sourceState === 'connected', 'the reading with the renewed token');
  assert.ok(
    fake.calls.some((c) => c.url.endsWith('/v1.0/user/info')),
    'read',
  );
  await h.shutdown();

  // Yandex ID refuses the refresh token: said once, not asked again; the token is used until it ends
  renewals = 0;
  const refused = recorder();
  const r = host({ ...base, refreshToken: 'rt-bad', tokenExpiresAt: Date.now() + 60_000 }, refused.logger);
  const [refusedDoor] = await r.plugin.configureAdoptedSensors([adopt('door-1|open', SensorType.Contact)]);
  await r.launch();
  await r.inside.read();
  await r.inside.read();
  assert.equal(renewals, 1, 'a refused renewal is not asked again');
  assert.equal(r.values.refreshToken, '');
  assert.equal(r.values.oauthToken, OAUTH_TOKEN);
  assert.equal(refused.lines.warn.length, 1);
  assert.match(refused.lines.warn[0]!, /no longer renews the token.*invalid_grant/);
  assert.equal(refusedDoor!.sourceState, 'connected', 'the token still reads');
  await r.shutdown();

  // Yandex ID does not answer: tried again after an hour, not at every reading
  renewals = 0;
  yandexId = 'down';
  const failed = recorder();
  const f = host({ ...base, refreshToken: 'rt-1', tokenExpiresAt: Date.now() + 60_000 }, failed.logger);
  await f.launch();
  await f.inside.read();
  await f.inside.read();
  assert.equal(renewals, 1, 'one try per hour');
  assert.equal(f.values.refreshToken, 'rt-1', 'kept for the next try');
  assert.equal(failed.lines.warn.length, 1);
  assert.match(failed.lines.warn[0]!, /trying again in an hour/);
  await f.shutdown();
});

test('Sign out while the official API is read: the reading does not bring back the devices', async () => {
  const state = baseState();
  globalThis.fetch = slow(fakeYandex(state).fetch, '/v1.0/user/info', 300);
  const h = host({ oauthToken: OAUTH_TOKEN, pollSeconds: 300 });
  const [door] = await h.plugin.configureAdoptedSensors([adopt('door-1|open', SensorType.Contact)]);
  await h.launch();
  await sleep(100);
  await h.press('logout');
  await sleep(500);
  assert.equal(h.values.oauthToken, '');
  assert.equal(h.inside.devices.size, 0);
  assert.equal(door!.sourceState, 'unavailable', 'the reading that ended after the sign-out does not connect the sensors');
  assert.deepEqual(await h.plugin.onDiscoverSensors(), [], 'nor is anything it read offered, scenarios included');
  await h.shutdown();
});

test('Sign out while the list of the app is read: the live updates hand over nothing', async () => {
  const state = baseState();
  globalThis.fetch = slow(fakeYandex(state).fetch, '/m/v3/user/devices', 400);
  const h = host({ ...(await appSignIn()), source: 'app' });
  const [door] = await h.plugin.configureAdoptedSensors([adopt('door-1|open', SensorType.Contact)]);
  await h.launch();
  await sleep(100);
  await h.press('logout');
  await sleep(700);
  assert.equal(h.inside.devices.size, 0);
  assert.equal(door!.sourceState, 'unavailable');
  await h.shutdown();
});

test('Sign out while the token is renewed: the renewed token does not come back', async () => {
  const state = baseState();
  globalThis.fetch = slow(fakeYandex(state).fetch, 'oauth.yandex.ru/token', 300);
  const h = host({ clientId: 'app-1', clientSecret: 'secret', oauthToken: OAUTH_TOKEN, refreshToken: 'rt-1', tokenExpiresAt: Date.now() + 60_000, pollSeconds: 300 });
  await h.launch();
  await sleep(100);
  await h.press('logout');
  await sleep(500);
  assert.equal(h.values.oauthToken, '');
  assert.equal(h.values.refreshToken, '');
  await h.shutdown();
});

test('Sign out while the QR sign-in waits for the confirmation: the confirmation does not sign in', async () => {
  const state = baseState({ qrConfirmAfter: 1 });
  globalThis.fetch = fakeYandex(state).fetch;
  const h = host();
  const window = await h.submit('qrLogin', {});
  const waiting = h.submit('qrLogin', { qrLink: valueOf(window, 'qrLink') });
  await sleep(300);
  await h.press('logout');
  const answer = await waiting;
  assert.equal(answer?.toast?.type, 'error');
  assert.match(String(answer?.toast?.message), /Signed out of Yandex while this sign-in ran/);
  assert.equal(h.values.xToken, '');
  assert.equal(h.values.account, '');
  await h.shutdown();

  // no confirmation comes: the window stops waiting at the sign-out, not 20 s later
  globalThis.fetch = fakeYandex(baseState({ qrConfirmAfter: 99 })).fetch;
  const unconfirmed = host();
  const unconfirmedWindow = await unconfirmed.submit('qrLogin', {});
  const started = Date.now();
  const stillWaiting = unconfirmed.submit('qrLogin', { qrLink: valueOf(unconfirmedWindow, 'qrLink') });
  await sleep(300);
  await unconfirmed.press('logout');
  assert.match(String((await stillWaiting)?.toast?.message), /Signed out of Yandex while this sign-in ran/);
  assert.ok(Date.now() - started < 5_000, 'ended at the next look at the confirmation');

  // the QR sign-in starting: its code is not kept to be confirmed later
  globalThis.fetch = slow(fakeYandex(baseState()).fetch, '/pwl-yandex', 300);
  const starting = host();
  const opening = starting.submit('qrLogin', {});
  await sleep(100);
  await starting.press('logout');
  assert.equal((await opening)?.toast?.type, 'error');
  assert.equal(starting.inside.qrSession, undefined);
});

test('Sign out while a pasted token is checked: the token is not kept', async () => {
  const state = baseState();
  globalThis.fetch = slow(fakeYandex(state).fetch, '/v1.0/user/info', 300);
  const h = host({ clientId: 'app-1' });
  const pasting = h.submit('officialLogin', { pastedToken: OAUTH_TOKEN });
  await sleep(100);
  await h.press('logout');
  assert.equal((await pasting)?.toast?.type, 'error');
  assert.equal(h.values.oauthToken, '');
  await h.shutdown();
});

test('two notifications for one station at once are said one after the other, each once', async () => {
  const state = baseState();
  const fake = fakeYandex(state);
  globalThis.fetch = fake.fetch;
  const h = host({ ...(await appSignIn()), source: 'app', voiceMode: 'cloud', speakingStations: ['station-1'] });
  await h.launch();
  await until(() => h.inside.complete, 'the list');
  const from = fake.calls.length;
  await Promise.all([
    h.plugin.sendNotification(['station:station-1'], { title: 'Front door opened' }),
    h.plugin.sendNotification(['station:station-1'], { title: 'Smoke in the kitchen' }),
  ]);
  const said = fake.calls
    .slice(from)
    .filter((c) => c.method === 'PUT' || /\/scenarios\/own-\d+\/actions$/.test(c.url))
    .map((c) => (c.method === 'PUT' ? `PUT:${c.body.steps[0].parameters.items[0].value.capabilities[0].state.value.text}` : 'RUN'));
  assert.deepEqual(said, ['PUT:Front door opened', 'RUN', 'PUT:Smoke in the kitchen', 'RUN']);
  assert.equal(state.own.size, 1, 'one scenario for the station');
  await h.shutdown();
});

test('stations speak at once: a slow one does not hold back another', async () => {
  const state = baseState();
  state.devices.push({ ...state.devices.find((d) => d.id === 'station-1'), id: 'station-2', name: 'Вторая станция', quasar_info: { device_id: 'ST200', platform: 'yandexmini' } });
  const fake = fakeYandex(state);
  // the first station's scenario is written slowly
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'PUT' && String(init.body).includes('"ViON station-1"')) await sleep(1_500);
    return fake.fetch(input, init);
  }) as typeof fetch;
  const h = host({ ...(await appSignIn()), source: 'app', voiceMode: 'cloud', speakingStations: ['station-1', 'station-2'] });
  await h.launch();
  await until(() => h.inside.complete, 'the list');
  await h.plugin.sendNotification(['station:station-1', 'station:station-2'], { title: 'Тревога' });
  const runs = fake.calls.flatMap((c) => {
    const id = /\/scenarios\/(own-\d+)\/actions$/.exec(c.url)?.[1];
    return id ? [state.own.get(id).name] : [];
  });
  assert.deepEqual(runs, ['ViON station-2', 'ViON station-1'], 'the second station spoke while the first one waited');
  await h.shutdown();
});

test('stations: none without the sign-in as the app, none speaks until turned on, a guest who listed them cannot change them', async () => {
  const state = baseState();
  const fake = fakeYandex(state);
  globalThis.fetch = fake.fetch;
  const { lines, logger } = recorder();
  const official = host({ oauthToken: OAUTH_TOKEN, pollSeconds: 300 }, logger);
  await official.launch();
  await official.inside.read();
  assert.deepEqual(await official.plugin.getDevices([]), [], 'a station that cannot speak is not offered');
  assert.equal(await official.plugin.getDevice('station:station-1'), null);
  await official.plugin.sendNotification(['station:station-1'], { title: 'Движение' });
  assert.deepEqual(lines.error, []);
  await official.shutdown();

  const h = host({ ...(await appSignIn()), source: 'app', voiceMode: 'cloud' });
  await h.launch();
  await until(() => h.inside.complete, 'the list');
  const listed = await h.plugin.getDevices(['guest']);
  assert.deepEqual(
    listed.map((d) => [d.id, d.ownerUserId, d.active]),
    [['station:station-1', 'guest', false]],
    'listed for the notification of the user, silent until turned on',
  );
  assert.equal((await h.plugin.getDevice('station:station-1'))?.ownerUserId, '', 'changing it asks for no user: only an admin passes');
  assert.equal((await h.plugin.getDevices([]))[0]?.ownerUserId, '');
  await h.plugin.sendNotification(['station:station-1'], { title: 'Движение' });
  assert.equal(state.own.size, 0, 'a station not turned on says nothing');

  await h.plugin.updateDevice('station:station-1', { active: true });
  assert.equal((await h.plugin.getDevices(['guest']))[0]?.active, true);
  await h.plugin.sendNotification(['station:station-1'], { title: 'Движение' });
  assert.equal(state.own.size, 1, 'turned on, it speaks');
  await h.plugin.revokeDevice('station:station-1');
  assert.deepEqual(h.values.speakingStations, []);
  await h.shutdown();
});

test('a scenario that does not run: its switch goes back off and the caller gets the error; so does a failed command', async () => {
  const state = baseState();
  const fake = fakeYandex(state);
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/v1.0/scenarios/sc-1/actions')) return json({ status: 'error', message: 'scenario is broken' }, 500);
    if (url.endsWith('/v1.0/devices/actions')) return json({ status: 'error', message: 'device is busy' }, 500);
    return fake.fetch(input, init);
  }) as typeof fetch;
  const h = host({ oauthToken: OAUTH_TOKEN, pollSeconds: 300 });
  await h.launch();
  await h.inside.read();
  const [scenario, relay] = await h.plugin.configureAdoptedSensors([adopt('scenario|sc-1', SensorType.Switch), adopt('relay-1|on', SensorType.Switch)]);
  await assert.rejects(scenario!.updateValue(SwitchProperty.On, true), /scenario is broken/);
  assert.equal(scenario!.getValue(SwitchProperty.On), false, 'the switch shows the scenario did not run');
  await assert.rejects(relay!.updateValue(SwitchProperty.On, true), /device is busy/);
  assert.equal(relay!.getValue(SwitchProperty.On), false, 'the relay shows what the device reports');
  await h.shutdown();
});

test('cameras are offered when the set changes, not at every reading; a failed offer is logged and made again', async () => {
  const state = baseState();
  globalThis.fetch = fakeYandex(state).fetch;
  const { lines, logger } = recorder();
  const h = host({ oauthToken: OAUTH_TOKEN, pollSeconds: 300 }, logger);
  h.offers.failing = 1;
  await h.launch();
  await h.inside.read();
  assert.equal(h.offers.tried, 1);
  assert.equal(h.pushed.length, 0);
  assert.match(lines.warn.join('\n'), /Could not offer the cameras of the Smart Home for adding: the server is restarting/);
  await h.inside.read();
  await h.inside.read();
  assert.deepEqual(
    h.pushed.map((cameras) => cameras.map((c) => c.id)),
    [['yandex:cam-1']],
    'offered again after the failure, then not again',
  );
  state.devices.push({ ...state.devices.find((d) => d.id === 'cam-1'), id: 'cam-2', name: 'Камера у входа' });
  await h.inside.read();
  assert.deepEqual(h.pushed.at(-1)!.map((c) => c.id).sort(), ['yandex:cam-1', 'yandex:cam-2'], 'a new camera is offered');
  await h.shutdown();
});

test('an x_token Yandex does not take is not kept, the sign-in that worked stays, and the log says why', async () => {
  const state = baseState();
  globalThis.fetch = fakeYandex(state).fetch;
  const { lines, logger } = recorder();
  const h = host({ ...(await appSignIn()) }, logger);
  await h.launch();
  await h.type('xToken', 'mistyped');
  await until(() => h.values.xToken === X_TOKEN, 'the x_token that worked back in its field');
  assert.equal(lines.error.length, 1);
  assert.match(lines.error[0]!, /x_token typed in the settings did not sign in.*oauth_token\.invalid/);
  await h.shutdown();

  // without a sign-in before, the field is emptied
  const fresh = host();
  await fresh.type('xToken', 'mistyped');
  await until(() => fresh.values.xToken === '', 'the field emptied');
  assert.equal(fresh.values.account, undefined);
});

test('scenarios in the app mode: read with the list and again when Yandex says they changed; one not read shows unavailable, not removed', async () => {
  const updates = await fakeUpdates();
  const state = baseState({ updatesUrl: updates.url });
  const fake = fakeYandex(state);
  let failing = 1;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith('/m/user/scenarios') && (init?.method ?? 'GET') === 'GET' && failing > 0) {
      failing--;
      return json({ status: 'error', message: 'try later' }, 500);
    }
    return fake.fetch(input, init);
  }) as typeof fetch;
  const { lines, logger } = recorder();
  const h = host({ ...(await appSignIn()), source: 'app' }, logger);
  const [left] = await h.plugin.configureAdoptedSensors([adopt('scenario|sc-1', SensorType.Switch)]);
  await h.launch();
  await until(() => lines.warn.some((line) => line.includes('Could not read the scenarios')), 'the warning');
  await until(() => updates.open === 1, 'the socket');
  assert.equal(left!.sourceState, 'unavailable', 'not read is not removed');

  // Yandex says the list changed
  state.scenarios.push({ id: 'sc-2', name: 'Я дома' });
  updates.send({ operation: 'update_scenario_list', message: '{"source":"create_scenario"}' });
  await until(() => left!.sourceState === 'connected', 'the scenario read');
  assert.ok((await h.plugin.onDiscoverSensors()).some((s) => s.id === 'scenario|sc-2'), 'a new scenario is offered');

  state.scenarios.splice(0, 1);
  updates.send({ operation: 'update_scenario_list', message: '{"source":"delete_scenario"}' });
  await until(() => left!.sourceState === 'removed', 'the removed scenario');
  await h.shutdown();
  await updates.close();
});

// a step that hangs (a socket or a timer left running keeps the process alive) ends the run red instead of never
// ending; the run is not ended by hand when it passes, so whatever is left running shows here
setTimeout(() => {
  console.log('not ok - plugin.spec did not end within 150 s');
  process.exit(1);
}, 150_000).unref();

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed++;
    console.error(`not ok - ${name}\n`, error);
  } finally {
    // a request the plugin of a test started still goes to that test's stand-in: the session keeps requests 200 ms
    // apart, so one can leave after the test ended, and the next test would count it as its own
    await sleep(300);
    globalThis.fetch = realFetch;
  }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);
