// The plugin as ViON drives it, against the stand-in of Yandex: the sign-in by code to the official API, sensors
// offered, adopted and kept up to date, commands and scenarios, a camera of the Smart Home with its stream, the
// sign-in by QR code, notifications said by a station, the tools of the assistant, and signing out.
// Run: npx tsx spec/plugin.spec.ts
import assert from 'node:assert/strict';

import { LightProperty, SwitchProperty } from '@camera.ui/sdk';

import YandexPlugin from '../src/index.js';
import { OAUTH_TOKEN, X_TOKEN, baseState, fakeYandex } from './fake-yandex.js';

import type { AdoptedSensor, CameraDevice, DiscoveredCamera, FormSubmitResponse, JsonSchema, StreamingInterface } from '@camera.ui/sdk';

const realFetch = globalThis.fetch;
const errors: string[] = [];
const quiet = {
  log() {},
  warn() {},
  success() {},
  debug() {},
  trace() {},
  attention() {},
  error(...args: unknown[]) {
    errors.push(args.map(String).join(' '));
  },
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function host(values: Record<string, unknown> = {}) {
  const listeners = new Map<string, () => unknown>();
  const pushed: DiscoveredCamera[] = [];
  const hookCalls = new Map<string, number>();
  // like the storage of ViON: every setValue runs the hook of the field, detached
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
        pushed.push(...cameras);
      },
    },
  };
  const plugin = new YandexPlugin(quiet, api as never, storage as never);
  const field = (key: string) => plugin.storageSchema.find((f) => f.key === key) as JsonSchema & Record<string, any>;
  return {
    plugin,
    values,
    pushed,
    hookCalls,
    launch: async () => listeners.get('finishLaunching')?.(),
    shutdown: async () => listeners.get('shutdown')?.(),
    submit: (key: string, form: Record<string, unknown>) => field(key).onClick(form) as Promise<FormSubmitResponse | undefined>,
    press: (key: string) => field(key).onSet(undefined, undefined) as Promise<void>,
    set: (key: string, value: unknown) => field(key).onSet(value, undefined) as Promise<void>,
  };
}

function keys(response: FormSubmitResponse | undefined): string[] {
  return (response?.schema ?? []).map((f) => f.key);
}

async function main(): Promise<void> {
  const state = baseState();
  const fake = fakeYandex(state);
  globalThis.fetch = fake.fetch;

  const h = host({ clientId: 'app-1', clientSecret: 'secret' });
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
  assert.deepEqual(keys(await paste.submit('officialLogin', {})), ['tokenPage', 'pastedToken']);
  assert.equal((await paste.submit('officialLogin', { pastedToken: 'bad' }))?.toast?.type, 'error');
  assert.deepEqual(keys(await paste.submit('officialLogin', { pastedToken: OAUTH_TOKEN })), ['done']);
  assert.equal(paste.values.oauthToken, OAUTH_TOKEN);

  // ---- sensors offered and adopted
  const offered = await plugin.onDiscoverSensors();
  const ids = offered.map((s: any) => s.id).sort();
  assert.deepEqual(ids, ['button-1|button', 'door-1|open', 'lamp-1|on', 'motion-1|illumination', 'motion-1|motion', 'relay-1|on', 'scenario|sc-1']);
  assert.equal(offered.find((s: any) => s.id === 'motion-1|motion').room, 'Прихожая');

  const records: AdoptedSensor[] = offered.map((s: any, i: number) => ({ id: `s${i}`, nativeId: s.id, address: s.address, name: s.name, type: s.type }));
  const sensors = await plugin.configureAdoptedSensors(records);
  assert.equal(sensors.length, 7);
  const sensor = (nativeId: string) => sensors[records.findIndex((r) => r.nativeId === nativeId)];
  assert.equal(sensor('door-1|open').sourceState, 'connected');
  assert.equal(sensor('door-1|open').getValue('detected'), false);
  assert.equal(sensor('lamp-1|on').getValue(LightProperty.Brightness), 60);
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

  // ---- stations: listed from the official API, but the voice needs the sign-in as the app
  const devices = await plugin.getDevices(['user-1']);
  assert.deepEqual(
    devices.map((d: any) => [d.id, d.ownerUserId]),
    [['station:station-1', 'user-1']],
  );
  errors.length = 0;
  await plugin.sendNotification(['station:station-1'], { title: 'Движение', body: 'Камера во дворе' });
  assert.match(errors.join('\n'), /QR code or x_token/);

  // ---- sign-in by QR code
  const qr = await h.submit('qrLogin', {});
  assert.deepEqual(keys(qr), ['qrImage', 'qrLink']);
  assert.match(String(qr?.schema?.[0]?.defaultValue), /^data:image\/png;base64,/);
  const signed = await h.submit('qrLogin', { qrLink: qr?.schema?.[1]?.defaultValue });
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

  // the official API still reads the devices; the app lends the stations for the voice
  await plugin.read();
  await plugin.sendNotification(['station:station-1'], { title: 'Движение!', body: 'Камера во дворе' });
  const own = [...state.own.values()];
  assert.equal(own.length, 1);
  assert.equal(own[0].steps[0].parameters.items[0].value.capabilities[0].state.value.text, 'Движение. Камера во дворе');
  await plugin.sendNotification(['station:station-1'], { title: 'Тихо', silent: true });
  assert.equal(own[0].steps[0].parameters.items[0].value.capabilities[0].state.value.text, 'Движение. Камера во дворе', 'a silent notification is not said');

  // a muted station says nothing
  await plugin.updateDevice('station:station-1', { active: false, name: 'Кухня' });
  assert.deepEqual(h.values.mutedStations, ['station-1']);
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
  assert.equal(sensor('door-1|open').sourceState, 'unavailable');

  await h.shutdown();
  globalThis.fetch = realFetch;
  console.log('plugin.spec: ok');
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
