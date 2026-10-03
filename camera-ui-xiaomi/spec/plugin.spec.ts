// The plugin as ViON drives it: the sign-in form with the captcha and the code in the dialog that follows, the token
// kept instead of the password, the cameras offered, adopted and opened, a restart that signs in with the token, a
// session Xiaomi ended, and signing out. The host is a stand-in; the Mi servers are the stand-in of fake-xiaomi.ts.
// Run: npx tsx spec/plugin.spec.ts
import assert from 'node:assert/strict';

import XiaomiPlugin from '../src/index.js';
import { SIGN, fakeCamera } from './fake-camera.js';
import { CAPTCHA, PASSWORD, TICKET, fakeXiaomi } from './fake-xiaomi.js';
import { C300, ZOOM_CAMERA } from './miot-specs.js';

import { PTZCapability } from '@camera.ui/sdk';

import type { CameraDevice, DiscoveredCamera, FormSubmitResponse, JsonSchema, PTZControl, StreamingInterface } from '@camera.ui/sdk';
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

/** A logger that keeps what the plugin says at each level. */
function recorder() {
  const lines: Record<string, string[]> = {};
  const level =
    (name: string) =>
    (...args: unknown[]) =>
      (lines[name] ??= []).push(args.map(String).join(' '));
  return { lines, logger: { ...silent, log: level('log'), error: level('error'), warn: level('warn'), debug: level('debug') } };
}

function host(values: Record<string, unknown> = {}, logger: typeof silent = silent) {
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
  const plugin = new XiaomiPlugin(logger, api as never, storage as never);
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await sleep(5);
  assert.ok(condition(), 'the awaited step did not come');
}

/** The Mi servers answering after `ms`: time to press Sign out while a sign-in or a reading runs. */
function slow(fetch: typeof globalThis.fetch, ms: number): typeof globalThis.fetch {
  return async (input, init) => {
    await sleep(ms);
    return fetch(input, init);
  };
}

/** The launch with the timers it starts kept, to run them without waiting for them. */
async function launchKeepingTimers(h: ReturnType<typeof host>): Promise<(() => void)[]> {
  const ticks: (() => void)[] = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((tick: () => void) => {
    ticks.push(tick);
    return realSetInterval(() => {}, 2 ** 30);
  }) as typeof setInterval;
  try {
    await h.launch();
  } finally {
    globalThis.setInterval = realSetInterval;
  }
  return ticks;
}

/**
 * A camera handed to the plugin. Its storage behaves like the SDK's: values stored before, defaults of the schema
 * under them, and a changed value goes through the field's onSet. `stored` is what the camera kept from before.
 */
function device(nativeId = '1001', stored: Record<string, unknown> = {}, logger: typeof silent = silent) {
  let implementation: StreamingInterface | undefined;
  let schema: (JsonSchema & Record<string, any>)[] = [];
  const values: Record<string, unknown> = { ...stored };
  const sensors: PTZControl[] = [];
  const camera = {
    id: `cam-${nativeId}`,
    name: 'Hall',
    nativeId,
    logger,
    async implement(impl: StreamingInterface) {
      implementation = impl;
    },
    connect() {},
    createStorage(schemas: JsonSchema[]) {
      schema = schemas as typeof schema;
      for (const field of schema) if (field.store && values[field.key] === undefined) values[field.key] = field.defaultValue;
      return {
        values,
        hasSchema: (key: string) => schema.some((field) => field.key === key),
        async addSchema(field: JsonSchema) {
          schema.push(field as (typeof schema)[number]);
        },
        async removeSchema(key: string) {
          schema = schema.filter((field) => field.key !== key);
        },
        async changeSchema(key: string, field: JsonSchema) {
          schema = schema.map((current) => (current.key === key ? (field as (typeof schema)[number]) : current));
        },
      };
    },
    async addSensor(sensor: PTZControl) {
      sensors.push(sensor);
    },
    async removeSensor(id: string) {
      sensors.splice(
        sensors.findIndex((sensor) => sensor.id === id),
        1,
      );
    },
  };
  return {
    camera: camera as unknown as CameraDevice,
    stream: () => implementation!.streamUrl('source-1'),
    sensors,
    values,
    /** the fields of the camera's settings, as they are now */
    fields: () => schema,
    /** the camera's setting changed in the interface */
    set: async (key: string, value: unknown) => {
      const old = values[key];
      values[key] = value;
      await schema.find((field) => field.key === key)?.onSet?.(value, old);
    },
  };
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
  // the window ends with what was found and where to add it
  const result = done?.schema?.[0] as { key: string; title: string; description: string; defaultValue?: string; readonly?: boolean };
  assert.equal(result.title, 'Signed in to Mi Home');
  assert.match(result.description, /open Cameras in ViON and click it under Discovered/);
  assert.equal(result.defaultValue, 'Hall');
  assert.equal(result.readonly, true);
  // its button closes the window, it does not sign in again
  const before = h.values.passToken;
  assert.equal(await h.submit({ ...form, [captchaField]: CAPTCHA, [codeField.key]: TICKET, [result.key]: result.defaultValue }), undefined);
  assert.equal(h.values.passToken, before);
  assert.equal(h.values.userId, '42');
  assert.equal(h.values.passToken, 'PT-VERIFIED');
  assert.equal(h.values.username, 'user@example.com');
  assert.equal(h.values.password, undefined);
  assert.equal(JSON.stringify(h.values).includes(PASSWORD), false);
  assert.deepEqual(h.pushed, [{ id: 'xiaomi:1001', name: 'Hall', manufacturer: 'Xiaomi', model: 'chuangmi.camera.039a01', address: '192.168.1.50' }]);
  await h.shutdown();
});

test('a mistyped code is typed again in the same window, and Xiaomi does not send a second one', async () => {
  const fake = fakeXiaomi(scenario({ verify: true }));
  globalThis.fetch = fake.fetch;
  const h = host();
  const form = { username: 'user@example.com', password: PASSWORD };
  const sent = () => fake.calls.filter((c) => c.url.includes('/identity/auth/sendPhoneTicket')).length;

  const first = await h.submit(form);
  const field = first?.schema?.[0] as { key: string; title: string };
  assert.equal(field.title, 'Confirmation code');

  const typo = await h.submit({ ...form, [field.key]: '000000' });
  // the window stays (a schema comes back) and says why
  const again = typo?.schema?.[0] as { key: string; title: string; placeholder?: string } | undefined;
  assert.equal(again?.title, 'Confirmation code');
  assert.equal(again?.placeholder, '+7*****12');
  assert.equal(typo?.toast?.type, 'error');
  assert.match(typo?.toast?.message ?? '', /The code was not accepted: wrong code/);

  const done = await h.submit({ ...form, [again!.key]: TICKET });
  assert.equal((done?.schema?.[0] as { title: string }).title, 'Signed in to Mi Home');
  assert.equal(h.values.passToken, 'PT-VERIFIED');
  assert.equal(sent(), 1);
  await h.shutdown();
});

test('a sign-in left waiting for the code is given up after 10 minutes, and the password with it', async () => {
  const fake = fakeXiaomi(scenario({ verify: true }));
  globalThis.fetch = fake.fetch;
  const { lines, logger } = recorder();
  const h = host({}, logger);
  const form = { username: 'user@example.com', password: PASSWORD };
  const sent = () => fake.calls.filter((c) => c.url.includes('/identity/auth/sendPhoneTicket')).length;

  // the timer of the waiting sign-in is kept to be run at once; the other timers run as usual
  const giveUps: (() => void)[] = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    if (ms !== 10 * 60_000) return realSetTimeout(fn, ms);
    giveUps.push(fn);
    return realSetTimeout(() => {}, 2 ** 30);
  }) as typeof setTimeout;
  let first: FormSubmitResponse | undefined;
  try {
    first = await h.submit(form);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  const field = (first?.schema?.[0] as { key: string }).key;
  const plugin = h.plugin as unknown as { pending?: { cloud: object } };
  const waiting = plugin.pending?.cloud;
  assert.ok(waiting && JSON.stringify(waiting).includes(PASSWORD), 'the waiting sign-in holds the password for its next step');

  assert.equal(giveUps.length, 1);
  for (const giveUp of giveUps) giveUp();
  assert.equal(plugin.pending, undefined);
  assert.equal(JSON.stringify(waiting).includes(PASSWORD), false);
  assert.equal(lines.warn?.filter((line) => /waited too long/.test(line)).length, 1);

  // the code typed after that does not start a new sign-in, which would make Xiaomi send another code
  const late = await h.submit({ ...form, [field]: TICKET });
  assert.equal(late?.schema, undefined);
  assert.equal(late?.toast?.type, 'error');
  assert.match(late?.toast?.message ?? '', /waited too long and was cancelled. Click Sign in to start again/);
  assert.equal(sent(), 1);
  assert.equal(h.values.passToken, undefined);
  await h.shutdown();
});

test('an account without cameras says so and what to check', async () => {
  globalThis.fetch = fakeXiaomi(scenario({ devices: Object.fromEntries(['cn', 'de', 'i2', 'ru', 'sg', 'us'].map((region) => [region, []])) })).fetch;
  const h = host();
  const done = await h.submit({ username: 'user@example.com', password: PASSWORD });
  const result = done?.schema?.[0] as { title: string; description: string };
  assert.equal(result.title, 'Signed in to Mi Home, no cameras found');
  assert.match(result.description, /in the Mi Home app/);
  await h.shutdown();
});

const UNPLAYABLE = {
  ru: [
    { did: '1001', name: 'Hall', model: 'chuangmi.camera.039a01', localip: '192.168.1.50' },
    { did: '1003', name: 'Garage', model: 'chuangmi.camera.069a01', localip: '192.168.1.53' },
    { did: '1004', name: 'Porch', model: 'isa.camera.hlc7', localip: '192.168.1.54' },
  ],
  cn: [],
};
const UNPLAYABLE_VENDORS = {
  '1003': { vendor: { vendor: 6 }, public_key: 'dd'.repeat(32), sign: 'sig' },
  '1004': { vendor: { vendor: 3 }, public_key: 'dd'.repeat(32), sign: 'sig' },
};

test('cameras ViON cannot play are not offered; the sign-in names them and why, the log says it once', async () => {
  const fake = fakeXiaomi(scenario({ devices: UNPLAYABLE, vendors: { ...scenario().vendors, ...UNPLAYABLE_VENDORS } }));
  globalThis.fetch = fake.fetch;
  const { lines, logger } = recorder();
  const h = host({}, logger);

  const done = await h.submit({ username: 'user@example.com', password: PASSWORD });
  const [found, leftOut] = done?.schema as { key: string; title: string; defaultValue?: string }[];
  assert.equal(found?.title, 'Signed in to Mi Home');
  assert.equal(found?.defaultValue, 'Hall');
  assert.equal(leftOut?.title, 'Cameras ViON cannot play');
  assert.equal(
    leftOut?.defaultValue,
    'Garage (chuangmi.camera.069a01) connects over MTP, which ViON cannot play\nPorch (isa.camera.hlc7) connects over Agora, which ViON cannot play',
  );
  assert.deepEqual(
    h.pushed.map((c) => c.id),
    ['xiaomi:1001'],
  );

  // the cloud is asked once per camera, the log names each one once
  const asked = () => fake.calls.filter((c) => c.path === '/v2/device/miss_get_vendor').length;
  assert.equal(asked(), 3);
  assert.deepEqual(
    (await h.plugin.onDiscoverCameras()).map((c) => c.id),
    ['xiaomi:1001'],
  );
  assert.equal(asked(), 3);
  assert.deepEqual(lines.warn?.sort(), [
    'Not offered for adding: Garage (chuangmi.camera.069a01) connects over MTP, which ViON cannot play',
    'Not offered for adding: Porch (isa.camera.hlc7) connects over Agora, which ViON cannot play',
  ]);

  // added all the same (an older version offered it): opening it says why, the engine gets no address it refuses
  const { camera, stream } = device('1003');
  await h.plugin.onCameraAdded(camera);
  await assert.rejects(stream(), /Garage \(chuangmi\.camera\.069a01\) connects over MTP, which ViON cannot play/);
  assert.equal(asked(), 3);
  await h.shutdown();
});

test('an account with only cameras ViON cannot play says that, not that it has none', async () => {
  globalThis.fetch = fakeXiaomi(scenario({ devices: { ru: UNPLAYABLE.ru.slice(1), cn: [] }, vendors: UNPLAYABLE_VENDORS })).fetch;
  const h = host();
  const done = await h.submit({ username: 'user@example.com', password: PASSWORD });
  const [found, leftOut] = done?.schema as { title: string; defaultValue?: string }[];
  assert.equal(found?.title, 'Signed in to Mi Home, no camera ViON can play');
  assert.equal(leftOut?.title, 'Cameras ViON cannot play');
  assert.match(leftOut?.defaultValue ?? '', /^Garage .*MTP.*\nPorch .*Agora/);
  assert.deepEqual(await h.plugin.onDiscoverCameras(), []);
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

test('a session the API ends with a plain error answer is renewed as well', async () => {
  const fake = fakeXiaomi(scenario({ endedSession: 'plain' }));
  globalThis.fetch = fake.fetch;
  const h = host({ userId: '42', passToken: 'PT1' });
  const { camera, stream } = device();
  await h.plugin.configureCameras([camera]);
  await h.launch();

  const plugin = h.plugin as unknown as { cloud?: { cookies: string } };
  plugin.cloud!.cookies = 'userId=42; cUserId=c42; serviceToken=EXPIRED';
  assert.equal(new URL(await stream()).host, '192.168.1.50');
  await h.shutdown();
});

test('two connections right after Xiaomi ended the session share one renewal, and both open', async () => {
  const fake = fakeXiaomi(
    scenario({
      devices: { ru: [...scenario().devices.ru!, { did: '1005', name: 'Yard', model: 'chuangmi.camera.039a01', localip: '192.168.1.55' }], cn: [] },
      vendors: { ...scenario().vendors, '1005': { vendor: { vendor: 4, vendor_params: {} }, public_key: 'dd'.repeat(32), sign: 'sig' } },
    }),
  );
  globalThis.fetch = fake.fetch;
  const h = host({ userId: '42', passToken: 'PT1' });
  const hall = device('1001');
  const yard = device('1005');
  await h.plugin.configureCameras([hall.camera, yard.camera]);
  await h.launch();

  const plugin = h.plugin as unknown as { cloud?: { cookies: string } };
  plugin.cloud!.cookies = 'userId=42; cUserId=c42; serviceToken=EXPIRED';
  const logins = () => fake.calls.filter((c) => c.url.includes('/pass/serviceLogin?')).length;
  const before = logins();
  const opened = await Promise.allSettled([hall.stream(), yard.stream()]);
  assert.deepEqual(
    opened.map((result) => (result.status === 'fulfilled' ? new URL(result.value).host : String(result.reason))),
    ['192.168.1.50', '192.168.1.55'],
  );
  assert.equal(logins(), before + 1);

  // a caller whose answer on the ended session comes after the renewal takes the renewed session, it does not renew again
  plugin.cloud!.cookies = 'userId=42; cUserId=c42; serviceToken=EXPIRED';
  globalThis.fetch = async (input, init) => {
    if (String(input instanceof Request ? input.url : input).includes('device_list_page')) await sleep(100);
    return fake.fetch(input, init);
  };
  const again = logins();
  const [list, url] = await Promise.all([h.plugin.onDiscoverCameras(), hall.stream()]);
  assert.deepEqual(list, []);
  assert.equal(new URL(url).host, '192.168.1.50');
  assert.equal(logins(), again + 1);
  await h.shutdown();
});

test('an old address is used at once, the device list is read again on the side', async () => {
  const fake = fakeXiaomi(scenario());
  globalThis.fetch = fake.fetch;
  const h = host({ userId: '42', passToken: 'PT1' });
  const { camera, stream } = device();
  await h.plugin.configureCameras([camera]);
  await h.launch();

  // the list was read long ago and reading it again is slow now
  const plugin = h.plugin as unknown as { camerasReadAt: number; refreshing?: Promise<void> };
  plugin.camerasReadAt = 0;
  const slow = fakeXiaomi(scenario({ deviceListDelayMs: 1500 }));
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    return url.includes('device_list_page') ? slow.fetch(input, init) : fake.fetch(input, init);
  };

  const started = Date.now();
  assert.equal(new URL(await stream()).host, '192.168.1.50');
  assert.ok(Date.now() - started < 1000, `the stream waited ${Date.now() - started} ms for the device list`);
  await plugin.refreshing;
  await h.shutdown();
});

test('cameras handed over after the start get their stream at once', async () => {
  globalThis.fetch = fakeXiaomi(scenario()).fetch;
  const h = host({ userId: '42', passToken: 'PT1' });
  await h.launch();
  const { camera, stream } = device();
  await h.plugin.configureCameras([camera]);
  assert.equal(new URL(await stream()).host, '192.168.1.50');
  await h.shutdown();
});

test('a camera removed from the account is no longer offered, unless a region could not be read', async () => {
  globalThis.fetch = fakeXiaomi(scenario()).fetch;
  const h = host({ userId: '42', passToken: 'PT1' });
  await h.launch();
  assert.deepEqual(
    (await h.plugin.onDiscoverCameras()).map((c) => c.id),
    ['xiaomi:1001'],
  );

  // only China answers, the other regions fail: nothing is dropped
  globalThis.fetch = fakeXiaomi(scenario({ devices: { cn: [] } })).fetch;
  assert.deepEqual(
    (await h.plugin.onDiscoverCameras()).map((c) => c.id),
    ['xiaomi:1001'],
  );

  // every region read, the camera is gone from the account
  globalThis.fetch = fakeXiaomi(scenario({ devices: Object.fromEntries(['cn', 'de', 'i2', 'ru', 'sg', 'us'].map((region) => [region, []])) })).fetch;
  assert.deepEqual(await h.plugin.onDiscoverCameras(), []);
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

test('after signing out the cameras of the account are neither offered nor adopted', async () => {
  globalThis.fetch = fakeXiaomi(scenario()).fetch;
  const h = host();
  await h.submit({ username: 'user@example.com', password: PASSWORD });
  const offered = await h.plugin.onDiscoverCameras();
  assert.deepEqual(
    offered.map((c) => c.id),
    ['xiaomi:1001'],
  );

  await h.logout();
  assert.deepEqual(await h.plugin.onDiscoverCameras(), []);
  await assert.rejects(h.plugin.onAdoptCamera(offered[0]!, {}), /sign in again/);
  await h.shutdown();
});

test('Sign out while the stored sign-in of the start runs: the token does not come back, nothing is offered', async () => {
  const fake = fakeXiaomi(scenario());
  globalThis.fetch = slow(fake.fetch, 30);
  const h = host({ userId: '42', passToken: 'PT1' });
  const launching = h.launch();
  await until(() => fake.calls.some((c) => c.url.includes('/pass/serviceLogin?')));
  await h.logout();
  await launching;
  assert.equal(h.values.userId, '');
  assert.equal(h.values.passToken, '');
  assert.deepEqual(await h.plugin.onDiscoverCameras(), []);
  assert.deepEqual(h.pushed, []);
  await h.shutdown();
});

test('Sign out while an ended session is renewed for a connection: the token does not come back', async () => {
  const fake = fakeXiaomi(scenario());
  globalThis.fetch = fake.fetch;
  const h = host({ userId: '42', passToken: 'PT1' });
  const { camera, stream } = device();
  await h.plugin.configureCameras([camera]);
  await h.launch();

  const plugin = h.plugin as unknown as { cloud?: { cookies: string } };
  plugin.cloud!.cookies = 'userId=42; cUserId=c42; serviceToken=EXPIRED';
  const logins = () => fake.calls.filter((c) => c.url.includes('/pass/serviceLogin?')).length;
  const before = logins();
  globalThis.fetch = slow(fake.fetch, 30);
  const opening = stream();
  await until(() => logins() > before);
  await h.logout();
  await assert.rejects(opening, /sign in in the settings of the plugin/);
  assert.equal(h.values.userId, '');
  assert.equal(h.values.passToken, '');
  await h.shutdown();
});

test('Sign out while the device list is read: what it brings is not offered', async () => {
  const fake = fakeXiaomi(scenario());
  globalThis.fetch = fake.fetch;
  const h = host();
  await h.submit({ username: 'user@example.com', password: PASSWORD });
  const pushed = h.pushed.length;

  globalThis.fetch = fakeXiaomi(scenario({ deviceListDelayMs: 100 })).fetch;
  const discovering = h.plugin.onDiscoverCameras();
  await sleep(20);
  await h.logout();
  assert.deepEqual(await discovering, []);
  assert.deepEqual(await h.plugin.onDiscoverCameras(), []);
  assert.equal(h.pushed.length, pushed);
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

test('a token Xiaomi refused is not presented again: the log says once to sign in, a new sign-in brings the cameras back', async () => {
  const fake = fakeXiaomi(scenario({ tokens: new Set() }));
  globalThis.fetch = fake.fetch;
  const { lines, logger } = recorder();
  const h = host({ userId: '42', passToken: 'OLD' }, logger);
  const { camera, stream } = device();
  await h.plugin.configureCameras([camera]);
  const ticks = await launchKeepingTimers(h);
  const tokenLogins = () => fake.calls.filter((c) => c.url.includes('/pass/serviceLogin?')).length;
  assert.equal(tokenLogins(), 1);
  // the settings no longer show an account the plugin is not signed in to
  assert.equal(h.values.passToken, '');
  assert.equal(h.values.userId, '');

  // connections, discovery and the half-hourly reading of the list do not send it to Xiaomi again
  await assert.rejects(stream(), /no longer accepts the stored sign-in: sign in again in the settings of the plugin/);
  await assert.rejects(stream(), /no longer accepts the stored sign-in/);
  assert.deepEqual(await h.plugin.onDiscoverCameras(), []);
  assert.equal(ticks.length, 1);
  for (const tick of ticks) tick();
  await sleep(50);
  assert.equal(tokenLogins(), 1);
  assert.equal(lines.error?.filter((line) => /refused the sign-in of the plugin.*sign in again in the settings/.test(line)).length, 1);

  await h.submit({ username: 'user@example.com', password: PASSWORD });
  assert.equal(h.values.passToken, 'PT1');
  assert.equal(new URL(await stream()).host, '192.168.1.50');
  await h.shutdown();
});

const NO_DNS = (async () => {
  throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND account.xiaomi.com') });
}) as typeof fetch;

test('a stored sign-in that breaks on the way (no network) keeps the token for the next try, the log says why', async () => {
  globalThis.fetch = NO_DNS;
  const { lines, logger } = recorder();
  const h = host({ userId: '42', passToken: 'PT1' }, logger);
  await h.launch();
  assert.equal(h.values.userId, '42');
  assert.equal(h.values.passToken, 'PT1');
  assert.deepEqual(lines.error, ['Could not sign in to Mi Home with the stored sign-in: fetch failed: getaddrinfo ENOTFOUND account.xiaomi.com']);
  await h.shutdown();
});

test('a sign-in that breaks on the way says why, in the message and in the log', async () => {
  globalThis.fetch = NO_DNS;
  const { lines, logger } = recorder();
  const h = host({}, logger);
  const answer = await h.submit({ username: 'user@example.com', password: PASSWORD });
  assert.equal(answer?.toast?.type, 'error');
  assert.equal(answer?.toast?.message, 'Sign-in failed: fetch failed: getaddrinfo ENOTFOUND account.xiaomi.com');
  assert.deepEqual(lines.error, ['Mi Home sign-in failed: fetch failed: getaddrinfo ENOTFOUND account.xiaomi.com']);
});

test('a door viewer that could not be woken is named in the log with the reason, and opened all the same', async () => {
  globalThis.fetch = fakeXiaomi(
    scenario({
      devices: { ru: [{ did: '2001', name: 'Door', model: 'loock.cateye.v02', localip: '192.168.1.70' }], cn: [] },
      vendors: { '2001': { vendor: { vendor: 4, vendor_params: {} }, public_key: 'dd'.repeat(32), sign: 'sig' } },
      wakeUpError: 'device offline',
    }),
  ).fetch;
  const { lines, logger } = recorder();
  const h = host({ userId: '42', passToken: 'PT1' }, logger);
  const { camera, stream } = device('2001');
  await h.plugin.configureCameras([camera]);
  await h.launch();
  assert.equal(new URL(await stream()).host, '192.168.1.70');
  assert.deepEqual(lines.warn, ['Could not wake up Door, connecting all the same: Xiaomi: device offline']);
  await h.shutdown();
});

test('pan and tilt are off until switched on in the settings of the camera; on adds the PTZ control, off removes it', async () => {
  globalThis.fetch = fakeXiaomi(scenario()).fetch;
  const h = host({ userId: '42', passToken: 'PT1' });
  const hall = device('1001');
  await h.plugin.configureCameras([hall.camera]);
  await h.launch();
  assert.equal(hall.values.ptz, false);
  assert.equal(hall.sensors.length, 0);
  await hall.set('ptz', true);
  assert.equal(hall.sensors.length, 1);
  assert.equal(hall.sensors[0].type, 'ptz');
  await hall.set('ptz', true);
  assert.equal(hall.sensors.length, 1, 'switched on twice, added twice');
  await hall.set('ptz', false);
  assert.equal(hall.sensors.length, 0);
  await h.shutdown();
});

test('a camera with pan and tilt switched on has its PTZ control again after a restart', async () => {
  globalThis.fetch = fakeXiaomi(scenario()).fetch;
  const h = host({ userId: '42', passToken: 'PT1' });
  const hall = device('1001', { ptz: true });
  await h.plugin.configureCameras([hall.camera]);
  await h.launch();
  // the lens is read first, without holding up the start
  await until(() => hall.sensors.length === 1);
  await h.shutdown();
});

test("a step turns the camera over a session of the plugin's own, with keys the cloud signs for that session", async () => {
  const camera = await fakeCamera();
  try {
    const fake = fakeXiaomi(
      scenario({
        devices: { ru: [{ did: '1001', name: 'Hall', model: 'xiaomi.camera.c01a01', localip: '127.0.0.1', isOnline: true }], cn: [] },
        vendors: { '1001': { vendor: { vendor: 4, vendor_params: {} }, public_key: camera.devicePublic, sign: SIGN } },
      }),
    );
    globalThis.fetch = fake.fetch;
    const h = host({ userId: '42', passToken: 'PT1' });
    const hall = device('1001', { ptz: true });
    await h.plugin.configureCameras([hall.camera]);
    await h.launch();
    await until(() => hall.sensors.length === 1);
    await hall.sensors[0].setRelativeMove({ panDelta: 0.4, tiltDelta: 0, zoomDelta: 0 });
    await until(() => camera.operations.length === 1);
    assert.deepEqual(camera.operations, [2]);
    // the key the camera was signed in with is the one the cloud signed
    const asked = fake.calls.filter((call) => call.path === '/v2/device/miss_get_vendor').at(-1)?.params as { app_pubkey?: string };
    assert.equal(camera.auths[0].public_key, asked.app_pubkey);
    await h.shutdown();
  } finally {
    await camera.close();
  }
});

test('a camera the plugin cannot turn says why in its log at the first step', async () => {
  globalThis.fetch = fakeXiaomi(
    scenario({ vendors: { '1001': { vendor: { vendor: 1, vendor_params: { p2p_id: 'TUTK1' } }, public_key: 'dd'.repeat(32), sign: 'sig' } } }),
  ).fetch;
  const { lines, logger } = recorder();
  const h = host({ userId: '42', passToken: 'PT1' });
  const hall = device('1001', { ptz: true }, logger);
  await h.plugin.configureCameras([hall.camera]);
  await h.launch();
  await until(() => hall.sensors.length === 1);
  await hall.sensors[0].setRelativeMove({ panDelta: -1, tiltDelta: 0, zoomDelta: 0 });
  assert.deepEqual(lines.error, ['Could not turn the camera left: Hall (chuangmi.camera.039a01) connects over tutk: the plugin turns cameras over CS2 only']);
  await h.shutdown();
});

test('a camera gone from the account with pan and tilt on does not hold up the start of the others', async () => {
  globalThis.fetch = fakeXiaomi(scenario()).fetch;
  const h = host({ userId: '42', passToken: 'PT1' });
  const hall = device('1001', { ptz: true });
  const gone = device('9999', { ptz: true });
  await h.plugin.configureCameras([hall.camera, gone.camera]);
  const launched = await Promise.race([h.launch().then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 5000))]);
  assert.equal(launched, true, 'the start hung');
  await until(() => hall.sensors.length === 1);
  await h.shutdown();
});

test('a camera with a zoom lens zooms and focuses through the Mi Home cloud once pan and tilt are on; off hides the focus', async () => {
  const fake = fakeXiaomi(
    scenario({
      devices: { ru: [{ did: '1001', name: 'Hall', model: 'xiaomi.camera.zoom01', localip: '192.168.1.50', isOnline: true, spec_type: ZOOM_CAMERA.type }], cn: [] },
      specs: { [ZOOM_CAMERA.type]: ZOOM_CAMERA },
      miot: { '1001.9.1': 1 },
    }),
  );
  globalThis.fetch = fake.fetch;
  const { lines, logger } = recorder();
  const h = host({ userId: '42', passToken: 'PT1' });
  const hall = device('1001', {}, logger);
  await h.plugin.configureCameras([hall.camera]);
  await h.launch();
  const keys = () => hall.fields().map((field) => field.key);
  assert.deepEqual(keys(), ['ptz']);

  await hall.set('ptz', true);
  const ptz = hall.sensors[0]!;
  assert.ok(ptz.capabilities.includes(PTZCapability.Zoom));
  assert.deepEqual(lines.log, ['The camera has a lens ViON can drive: zoom and focus']);
  assert.deepEqual(keys(), ['ptz', 'focusNear', 'focusFar', 'focusAuto']);

  await ptz.setRelativeMove({ panDelta: 0, tiltDelta: 0, zoomDelta: 0.5 });
  const set = fake.calls.find((call) => call.path === '/miotspec/prop/set');
  assert.deepEqual(set?.params, { params: [{ did: '1001', siid: 9, piid: 1, value: 4 }] });

  await hall
    .fields()
    .find((field) => field.key === 'focusFar')!
    .onSet();
  assert.deepEqual(fake.calls.find((call) => call.path === '/miotspec/action')?.params, { params: { did: '1001', siid: 9, aiid: 2, in: [] } });

  await hall.set('ptz', false);
  assert.deepEqual(keys(), ['ptz']);
  await h.shutdown();
});

test('a camera with a fixed lens turns without zoom; a description that cannot be read is said and the camera turns all the same', async () => {
  const c300 = { did: '1001', name: 'Hall', model: 'xiaomi.camera.c01a01', localip: '192.168.1.50', isOnline: true, spec_type: C300.type };
  globalThis.fetch = fakeXiaomi(scenario({ devices: { ru: [c300], cn: [] }, specs: { [C300.type]: C300 } })).fetch;
  let h = host({ userId: '42', passToken: 'PT1' });
  let hall = device('1001', { ptz: true });
  await h.plugin.configureCameras([hall.camera]);
  await h.launch();
  await until(() => hall.sensors.length === 1);
  assert.equal(hall.sensors[0]!.capabilities.includes(PTZCapability.Zoom), false);
  assert.deepEqual(
    hall.fields().map((field) => field.key),
    ['ptz'],
  );
  await h.shutdown();

  // miot-spec.org does not know the model
  globalThis.fetch = fakeXiaomi(scenario({ devices: { ru: [{ ...c300, spec_type: undefined }], cn: [] } })).fetch;
  const { lines, logger } = recorder();
  h = host({ userId: '42', passToken: 'PT1' });
  hall = device('1001', { ptz: true }, logger);
  await h.plugin.configureCameras([hall.camera]);
  await h.launch();
  await until(() => hall.sensors.length === 1);
  assert.equal(hall.sensors[0]!.capabilities.includes(PTZCapability.Zoom), false);
  assert.deepEqual(lines.warn, [
    'Could not read whether the camera can zoom (switch pan and tilt off and on to try again): miot-spec.org has no spec of xiaomi.camera.c01a01',
  ]);
  await h.shutdown();
});

// a step that hangs (a session never closed keeps the process alive) ends the run red, instead of leaving a
// process that holds the stand-in camera's port 32108 for the next run
setTimeout(() => {
  console.log('not ok - the run did not end within 150 s');
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
    globalThis.fetch = realFetch;
  }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);
