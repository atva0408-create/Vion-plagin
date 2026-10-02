// The plugin as ViON drives it: the sign-in form with the captcha and the code in the dialog that follows, the token
// kept instead of the password, the cameras offered, adopted and opened, a restart that signs in with the token, a
// session Xiaomi ended, and signing out. The host is a stand-in; the Mi servers are the stand-in of fake-xiaomi.ts.
// Run: npx tsx spec/plugin.spec.ts
import assert from 'node:assert/strict';

import XiaomiPlugin from '../src/index.js';
import { CAPTCHA, PASSWORD, TICKET, fakeXiaomi } from './fake-xiaomi.js';

import type { CameraDevice, DiscoveredCamera, FormSubmitResponse, JsonSchema, StreamingInterface } from '@camera.ui/sdk';
import type { Scenario } from './fake-xiaomi.js';

const realFetch = globalThis.fetch;
const silent = { log() {}, error() {}, warn() {}, success() {}, debug() {}, trace() {}, attention() {} };

function scenario(patch: Partial<Scenario> = {}): Scenario {
  return {
    devices: {
      ru: [
        { did: '1001', name: 'Hall', model: 'chuangmi.camera.039a01', localip: '192.168.1.50', isOnline: true },
        { did: '1002', name: 'Kettle', model: 'yunmi.kettle.r1', localip: '192.168.1.60' },
      ],
      cn: [],
    },
    vendors: { '1001': { vendor: { vendor: 4, vendor_params: {} }, public_key: 'dd'.repeat(32), sign: 'sig' } },
    tokens: new Set(['PT1', 'PT-VERIFIED']),
    ...patch,
  };
}

function host(values: Record<string, unknown> = {}) {
  const listeners = new Map<string, () => unknown>();
  const pushed: DiscoveredCamera[] = [];
  const storage = {
    values,
    async setValue(key: string, value: unknown) {
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
  const plugin = new XiaomiPlugin(silent, api as never, storage as never);
  const field = (key: string) => plugin.storageSchema.find((f) => f.key === key) as JsonSchema & Record<string, any>;
  return {
    plugin,
    values,
    pushed,
    launch: async () => listeners.get('finishLaunching')?.(),
    shutdown: async () => listeners.get('shutdown')?.(),
    submit: (form: Record<string, unknown>) => field('login').onClick(form) as Promise<FormSubmitResponse | undefined>,
    logout: () => field('logout').onSet(undefined, undefined) as Promise<void>,
  };
}

function device(nativeId = '1001') {
  let implementation: StreamingInterface | undefined;
  const camera = {
    id: `cam-${nativeId}`,
    name: 'Hall',
    nativeId,
    logger: silent,
    async implement(impl: StreamingInterface) {
      implementation = impl;
    },
    connect() {},
  };
  return { camera: camera as unknown as CameraDevice, stream: () => implementation!.streamUrl('source-1') };
}

const tests: [string, () => Promise<void>][] = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

test('the sign-in asks for the captcha and the code in the dialog, keeps the token and never the password', async () => {
  globalThis.fetch = fakeXiaomi(scenario({ captcha: true, verify: true })).fetch;
  const h = host();
  const form = { username: 'user@example.com', password: PASSWORD };

  const first = await h.submit(form);
  const picture = first?.schema?.find((f) => (f as { format?: string }).format === 'image') as { defaultValue?: string } | undefined;
  assert.match(picture?.defaultValue ?? '', /^data:image\/jpeg;base64,/);
  const captchaField = first?.schema?.find((f) => (f as { required?: boolean }).required)?.key;
  assert.ok(captchaField);

  // the dialog sends the page values along with its own
  const second = await h.submit({ ...form, [captchaField]: CAPTCHA });
  const codeField = second?.schema?.[0] as { key: string; placeholder?: string; title: string };
  assert.equal(codeField.title, 'Confirmation code');
  assert.equal(codeField.placeholder, '+7*****12');

  const done = await h.submit({ ...form, [captchaField]: CAPTCHA, [codeField.key]: TICKET });
  assert.deepEqual(done, { toast: { type: 'success', message: 'Signed in to Mi Home. Cameras in the account: 1' } });
  assert.equal(h.values.userId, '42');
  assert.equal(h.values.passToken, 'PT-VERIFIED');
  assert.equal(h.values.username, 'user@example.com');
  assert.equal(h.values.password, undefined);
  assert.equal(JSON.stringify(h.values).includes(PASSWORD), false);
  assert.deepEqual(h.pushed, [{ id: 'xiaomi:1001', name: 'Hall', manufacturer: 'Xiaomi', model: 'chuangmi.camera.039a01', address: '192.168.1.50' }]);
  await h.shutdown();
});

test('a wrong password ends in an error, without a dialog', async () => {
  globalThis.fetch = fakeXiaomi(scenario()).fetch;
  const h = host();
  const answer = await h.submit({ username: 'user@example.com', password: 'nope' });
  assert.equal(answer?.schema, undefined);
  assert.equal(answer?.toast?.type, 'error');
  assert.match(answer?.toast?.message ?? '', /Wrong account or password/);
  assert.equal(h.values.passToken, undefined);
});

test('an adopted camera opens over the local network with keys asked for each connection', async () => {
  const fake = fakeXiaomi(scenario());
  globalThis.fetch = fake.fetch;
  const h = host();
  await h.submit({ username: 'user@example.com', password: PASSWORD });

  const offered = await h.plugin.onDiscoverCameras();
  assert.deepEqual(
    offered.map((c) => c.id),
    ['xiaomi:1001'],
  );
  const config = await h.plugin.onAdoptCamera(offered[0]!, {});
  assert.equal(config.nativeId, '1001');
  assert.equal(config.isCloud, false);
  assert.deepEqual(
    config.sources.map((s) => [s.name, s.role]),
    [['P2P', 'high-resolution']],
  );

  const { camera, stream } = device();
  await h.plugin.onCameraAdded(camera);
  const first = new URL(await stream());
  const second = new URL(await stream());
  assert.equal(first.host, '192.168.1.50');
  assert.equal(first.searchParams.get('vendor'), 'cs2');
  assert.notEqual(first.searchParams.get('client_private'), second.searchParams.get('client_private'));
  // an added camera is no longer offered
  assert.deepEqual(await h.plugin.onDiscoverCameras(), []);
  await h.shutdown();
});

test('after a restart the token signs in, and a session Xiaomi ended is renewed once', async () => {
  const fake = fakeXiaomi(scenario());
  globalThis.fetch = fake.fetch;
  const h = host({ userId: '42', passToken: 'PT1', quality: 'sd' });
  const { camera, stream } = device();
  await h.plugin.configureCameras([camera]);
  await h.launch();

  const url = new URL(await stream());
  assert.equal(url.searchParams.get('subtype'), 'sd');

  // Xiaomi ends the session: the next request signs in again with the token
  const plugin = h.plugin as unknown as { cloud?: { cookies: string } };
  plugin.cloud!.cookies = 'userId=42; cUserId=c42; serviceToken=EXPIRED';
  const logins = () => fake.calls.filter((c) => c.url.includes('/pass/serviceLogin?')).length;
  const before = logins();
  assert.equal(new URL(await stream()).host, '192.168.1.50');
  assert.equal(logins(), before + 1);
  await h.shutdown();
});

test('signing out forgets the token; cameras then say how to get them back', async () => {
  globalThis.fetch = fakeXiaomi(scenario()).fetch;
  const h = host();
  await h.submit({ username: 'user@example.com', password: PASSWORD });
  const { camera, stream } = device();
  await h.plugin.onCameraAdded(camera);

  await h.logout();
  assert.equal(h.values.passToken, '');
  assert.equal(h.values.userId, '');
  await assert.rejects(stream(), /sign in in the settings of the plugin/);
  await h.shutdown();
});

test('a stored token Xiaomi no longer accepts is reported, the plugin keeps running', async () => {
  globalThis.fetch = fakeXiaomi(scenario({ tokens: new Set() })).fetch;
  const h = host({ userId: '42', passToken: 'OLD' });
  const { camera, stream } = device();
  await h.plugin.configureCameras([camera]);
  await h.launch();
  assert.deepEqual(await h.plugin.onDiscoverCameras(), []);
  // the added camera has its stream all the same, and says what is wrong when it is opened
  await assert.rejects(stream(), /no longer accepts the stored sign-in/);
  await h.shutdown();
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed++;
    console.error(`not ok - ${name}\n`, error);
  } finally {
    globalThis.fetch = realFetch;
  }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);
