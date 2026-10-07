// The whole plugin with a fake host: cameras with and without a speaker, the notification channel, the assistant
// tools, the buttons of the camera drawer. Run: npx tsx spec/plugin.spec.ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import VoicePlugin from '../src/index.js';
import { TOOLS } from '../src/tools.js';
import { FakeEngine, flush, runTests, test } from './helpers.js';

import type { JsonSchema, Notification } from '@camera.ui/sdk';
import type { SpeechEngine } from '../src/engine.js';

class TestPlugin extends VoicePlugin {
  static engine = new FakeEngine();
  protected createEngine(): SpeechEngine {
    return TestPlugin.engine;
  }
}

function subject<T>() {
  const listeners = new Set<(value: T) => void>();
  return {
    next: (value: T) => listeners.forEach((l) => l(value)),
    subscribe: (l: (value: T) => void) => {
      listeners.add(l);
      return { unsubscribe: () => listeners.delete(l), dispose: () => listeners.delete(l) };
    },
  };
}

/** A storage of settings like the host keeps them: defaults of stored fields, onSet on every change. */
function storage(schemas: JsonSchema[]) {
  const values: Record<string, any> = {};
  for (const s of schemas) if ((s as { store?: boolean }).store && 'defaultValue' in s) values[s.key] = (s as { defaultValue?: unknown }).defaultValue;
  const store = {
    schemas,
    values,
    async setValue(key: string, value: unknown) {
      const old = values[key];
      values[key] = value;
      const field = store.schemas.find((s) => s.key === key) as { onSet?: (n: unknown, o: unknown) => Promise<void> } | undefined;
      await field?.onSet?.(value, old);
    },
    async setInternalValue() {},
    hasSchema: (key: string) => store.schemas.some((s) => s.key === key),
    async changeSchema(key: string, schema: JsonSchema) {
      store.schemas = store.schemas.map((s) => (s.key === key ? schema : s));
    },
    field: (key: string) => store.schemas.find((s) => s.key === key) as any,
  };
  return store;
}

function camera(id: string, name: string, talks: boolean) {
  const packets: Buffer[] = [];
  const events = subject<{ type: string; event: unknown }>();
  const source = {
    backchannelAudioCodec: talks ? 'opus' : undefined,
    audioCodecs: ['opus'],
    generateRTSPUrl: () => 'rtsp://127.0.0.1/none',
    snapshot: async () => new Uint8Array([0xff, 0xd8]).buffer,
    createRtpSession: () => {
      let backchannel = false;
      return {
        onError: subject<Error>(),
        onEnded: subject<void>(),
        get hasBackchannel() {
          return backchannel;
        },
        startStream: async () => undefined,
        startBackchannel: async () => {
          backchannel = talks;
        },
        sendAudioPacket: async (packet: Buffer) => void packets.push(packet),
        stop: async () => undefined,
      };
    },
  };
  const device: any = {
    id,
    name,
    connected: true,
    sources: [source],
    streamSource: source,
    snapshotSource: undefined,
    zones: {
      object: [
        {
          name: 'desk',
          points: [
            [0, 0],
            [50, 0],
            [50, 100],
            [0, 100],
          ],
          labels: ['person'],
          type: 'intersect',
          color: '',
        },
      ],
    },
    onDetectionEvent: events,
    onPropertyChange: () => subject<unknown>(),
    createStorage: (schemas: JsonSchema[]) => {
      device.storage = storage(schemas);
      return device.storage;
    },
  };
  return { device, packets, events };
}

async function setup(asks: (request: any) => any = () => ({ ok: false, reason: 'unconfigured', message: '' })) {
  TestPlugin.engine = new FakeEngine();
  const published: Notification[] = [];
  const logs: string[] = [];
  const logger = {
    log: (m: string) => logs.push(m),
    warn: (m: string) => logs.push(m),
    error: (m: string) => logs.push(m),
    debug() {},
    success() {},
    trace() {},
    attention() {},
  };
  const listeners = new Map<string, () => void>();
  const api = {
    storagePath: mkdtempSync(join(tmpdir(), 'voice-')),
    on: (event: string, listener: () => void) => listeners.set(event, listener),
    coreManager: {
      assistantAsk: async (request: unknown) => asks(request),
      assistantAccess: async () => ({ allowed: true, model: 'ollama/qwen', vision: false, language: null }),
      getFFmpegPath: async () => 'ffmpeg',
    },
    notificationManager: { publish: async (n: Notification) => void published.push(n) },
  };
  const plugin = new TestPlugin(logger as never, api as never, storage([]) as never);
  // the host builds the plugin storage from storageSchema
  const pluginStorage = storage(plugin.storageSchema);
  (plugin as any).storage = pluginStorage;
  const kids = camera('kids', 'Детская', true);
  const door = camera('door', 'Входная дверь', false);
  await plugin.configureCameras([kids.device, door.device]);
  return {
    plugin,
    kids,
    door,
    published,
    logs,
    pluginStorage,
    engine: TestPlugin.engine,
    launch: () => listeners.get('finishLaunching')?.(),
    stop: () => listeners.get('shutdown')?.(),
  };
}

const ctx = { userId: 'u', role: 'admin' as const, language: 'ru', timezone: 'Europe/Moscow' };

test('9. a camera without a talk channel: no scenario there, voice_speakers says why, voice_say answers no_backchannel', async () => {
  const s = await setup();
  await s.door.device.storage.setValue('screenTime', [{ childName: 'Артём', zone: 'desk' }]);
  assert.equal((s.plugin as any).voice.scenariosOf('door').length, 0, 'the scenario is not switched on');
  assert.ok(
    s.logs.some((l) => /cannot speak here/.test(l)),
    s.logs.join('\n'),
  );

  const speakers = (await s.plugin.callAssistantTool('voice_speakers', {}, ctx)).content as any[];
  assert.deepEqual(
    speakers.map((x) => [x.camera, x.canSpeak]),
    [
      ['Детская', true],
      ['Входная дверь', false],
    ],
  );
  assert.match(speakers[1].why, /no speaker channel/);

  const said = await s.plugin.callAssistantTool('voice_say', { camera: 'Входная дверь', text: 'Привет' }, ctx);
  assert.equal((said.content as any).status, 'no_backchannel');
  assert.equal(s.engine.said.length, 0);

  const drawer = await s.door.device.storage.field('speaker').onGet();
  assert.equal(drawer, 'Этой камерой говорить нельзя: у неё нет канала звука в динамик');
  // the speaker lists of the plugin page offer only cameras that talk
  assert.deepEqual(s.pluginStorage.field('channelSpeakers').enum, ['kids']);
});

test('12. notifications: a speaker that is off says nothing, one that is on says only what is addressed to it, silent ones never', async () => {
  const s = await setup();
  const devices = await s.plugin.getDevices(['owner']);
  assert.deepEqual(
    devices.map((d) => [d.id, d.active]),
    [['voice:kids', false]],
    'listed as inactive: the server sends general notifications only to active devices',
  );
  assert.equal(await s.plugin.getDevice('voice:door'), null, 'a camera without a speaker is no device');
  assert.equal(await s.plugin.getDevice('yandex:1'), null);

  await s.plugin.sendNotification(['voice:kids'], { title: 'Ужин', body: 'готов' });
  assert.equal(s.engine.said.length, 0, 'the speaker is off');

  await s.plugin.updateDevice('voice:kids', { active: true });
  assert.deepEqual(s.pluginStorage.values.channelSpeakers, ['kids']);
  await s.plugin.sendNotification(['voice:kids'], { title: 'Ужин', body: 'готов' });
  assert.deepEqual(s.engine.said, ['Ужин. готов']);

  assert.deepEqual(
    (await s.plugin.getDevices(['owner'])).map((d) => d.active),
    [false],
    'still inactive when it speaks',
  );

  await s.plugin.sendNotification(['voice:kids'], { title: 'Тихо', silent: true });
  await s.plugin.sendNotification(['voice:door', 'other:1'], { title: 'Не сюда' });
  assert.deepEqual(s.engine.said, ['Ужин. готов']);
  assert.ok(s.kids.packets.length > 0, 'the phrase went to the camera as RTP');
  assert.equal(s.kids.packets[0][1] & 0x7f, 8);
});

test('13. the tools: confirmation for every change, none for reading', () => {
  for (const tool of TOOLS) {
    const reads = tool.name === 'voice_status' || tool.name === 'voice_speakers';
    assert.equal(Boolean(tool.approval), !reads, tool.name);
    assert.equal(Boolean(tool.adminOnly), !reads, tool.name);
  }
  assert.deepEqual(TOOLS.map((t) => t.name).sort(), [
    'voice_disable',
    'voice_extend',
    'voice_say',
    'voice_set_door',
    'voice_set_screen_time',
    'voice_speakers',
    'voice_status',
  ]);
});

test('13b. wrong input gets an error that says what to fix', async () => {
  const s = await setup();
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ['voice_set_screen_time', { camera: 'Кухня', child: 'Артём' }, /Unknown camera "Кухня". Cameras: "Детская", "Входная дверь"/],
    ['voice_set_screen_time', { camera: 'Детская', child: 'Артём', zone: 'sofa' }, /zone: "sofa" is not a zone of this camera \(desk\)/],
    ['voice_set_screen_time', { camera: 'Детская', child: 'Артём', zone: 'desk', schoolFrom: '25:00' }, /schoolFrom: a time HH:MM/],
    ['voice_set_screen_time', { camera: 'Детская', child: 'Артём', zone: 'desk', sessionMinutes: 1 }, /sessionMinutes: a number from 5 to 240/],
    ['voice_set_screen_time', { camera: 'Входная дверь', child: 'Артём', zone: 'desk' }, /cannot speak through "Входная дверь"/],
    ['voice_extend', { child: 'Артём' }, /give minutes/],
    ['voice_set_door', { doorCameras: ['Входная дверь'], speakers: ['Входная дверь'] }, /speakers: camera door cannot speak/],
    ['voice_say', { camera: 'Детская' }, /give text/],
  ];
  for (const [name, input, expected] of cases) {
    const result = await s.plugin.callAssistantTool(name, input, ctx);
    assert.match(result.error ?? '', expected, `${name} ${JSON.stringify(input)} → ${JSON.stringify(result)}`);
  }
  assert.deepEqual(s.kids.device.storage.values.screenTime, [], 'nothing was written');
});

test('13c. "перерыв каждые 45 минут на 10, спать в будни в 21:30, в выходные в 22:30": one call, the values the camera drawer shows', async () => {
  const s = await setup();
  // the one call the assistant makes for the owner's sentence
  const result = await s.plugin.callAssistantTool(
    'voice_set_screen_time',
    { camera: 'Детская', child: 'Артём', zone: 'desk', sessionMinutes: 45, breakMinutes: 10, schoolFrom: '21:30', freeFrom: '22:30' },
    ctx,
  );
  assert.equal(result.error, undefined, result.error);
  const stored = s.kids.device.storage.values.screenTime;
  assert.equal(stored.length, 1);
  assert.deepEqual(
    {
      childName: stored[0].childName,
      zone: stored[0].zone,
      sessionMinutes: stored[0].sessionMinutes,
      breakMinutes: stored[0].breakMinutes,
      schoolFrom: stored[0].schoolFrom,
      schoolTo: stored[0].schoolTo,
      freeFrom: stored[0].freeFrom,
      freeTo: stored[0].freeTo,
    },
    { childName: 'Артём', zone: 'desk', sessionMinutes: 45, breakMinutes: 10, schoolFrom: '21:30', schoolTo: '07:30', freeFrom: '22:30', freeTo: '08:30' },
  );
  // every value written is a field of the camera drawer: one truth for the chat and the settings
  const fields = new Set((s.kids.device.storage.field('screenTime').items.properties as { key: string }[]).map((p) => p.key));
  for (const key of Object.keys(stored[0])) assert.ok(fields.has(key), `${key} is not a field of the drawer`);
  const scenario = (s.plugin as any).voice.scenariosOf('kids')[0];
  assert.equal(scenario.engine.config.childName, 'Артём');

  // and the other way round: what the owner changes in the drawer is what the tools read
  await s.kids.device.storage.setValue('screenTime', [{ ...stored[0], breakMinutes: 15 }]);
  const status = (await s.plugin.callAssistantTool('voice_status', { camera: 'Детская' }, ctx)).content as any;
  assert.equal(status.cameras[0].screenTime[0].breakMinutes, 15);
  assert.equal((s.plugin as any).voice.scenariosOf('kids')[0].engine.config.breakMinutes, 15);

  // a second call changes the same child, it does not add one
  await s.plugin.callAssistantTool('voice_set_screen_time', { camera: 'Детская', child: 'артём', dailyMinutes: 120 }, ctx);
  assert.equal(s.kids.device.storage.values.screenTime.length, 1);
  assert.equal(s.kids.device.storage.values.screenTime[0].dailyMinutes, 120);
  assert.equal(s.kids.device.storage.values.screenTime[0].breakMinutes, 15);
});

test('the buttons of the camera drawer: give time, say a phrase, test the speaker', async () => {
  const s = await setup();
  await s.kids.device.storage.setValue('screenTime', [{ childName: 'Артём', zone: 'desk' }]);
  const give = s.kids.device.storage.field('giveTime');
  const form = await give.onClick({});
  assert.deepEqual(
    form.schema.map((f: { key: string }) => f.key),
    ['child', 'minutes', 'skipBreak'],
  );
  const done = await give.onClick({ child: form.schema[0].defaultValue, minutes: 30, skipBreak: false });
  assert.equal(done.toast.type, 'success');
  assert.match(done.toast.message, /Артём: Сегодня: 0 мин. Сейчас: родители дали время до \d\d:\d\d/);

  const sayForm = await s.kids.device.storage.field('sayPhrase').onClick({});
  assert.deepEqual(
    sayForm.schema.map((f: { key: string }) => f.key),
    ['phrase', 'instruction'],
  );
  assert.deepEqual(await s.kids.device.storage.field('sayPhrase').onClick({ phrase: 'Ужин готов' }), { toast: { type: 'success', message: 'Said' } });
  assert.deepEqual(await s.kids.device.storage.field('testPhrase').onClick(), { toast: { type: 'success', message: 'Said' } });
  assert.deepEqual(s.engine.said, ['Ужин готов', 'Проверка голоса. Меня хорошо слышно?']);
  const recent = await s.pluginStorage.field('recent').onGet();
  assert.match(recent, /Детская: «Проверка голоса. Меня хорошо слышно\?»/);
  assert.match(recent, /Детская: «Ужин готов»/);
  const fail = await s.door.device.storage.field('testPhrase').onClick();
  assert.equal(fail.toast.type, 'error');
  assert.match(fail.toast.message, /no_backchannel/);
});

test('a phrase the assistant writes from an instruction, from the drawer', async () => {
  const s = await setup((request) => {
    assert.match(request.prompt, /скажи Артёму, что ужин готов/);
    return { ok: true, text: '', json: { say: 'Артём, ужин готов!' }, usage: { promptTokens: 1, completionTokens: 1 } };
  });
  const done = await s.kids.device.storage.field('sayPhrase').onClick({ phrase: 'скажи Артёму, что ужин готов', instruction: true });
  assert.deepEqual(done, { toast: { type: 'success', message: 'Said: Артём, ужин готов!' } });
  assert.deepEqual(s.engine.said, ['Артём, ужин готов!']);
});

test('the drawer offers the zones of the camera, and the speaker state in plain words', async () => {
  const s = await setup();
  const zone = (s.kids.device.storage.field('screenTime').items.properties as { key: string; enum?: string[] }[]).find((p) => p.key === 'zone');
  assert.deepEqual(zone?.enum, ['desk']);
  assert.equal(await s.kids.device.storage.field('speaker').onGet(), 'Этой камерой можно говорить.');
  assert.match(await s.pluginStorage.field('assistant').onGet(), /Allowed, model: ollama\/qwen/);
});

test('door events of the cameras reach the door rules', async () => {
  const s = await setup();
  await s.pluginStorage.setValue('doorRules', [{ enabled: true, doorCameras: ['door'], speakers: ['kids'], describe: false, cooldownSeconds: 120 }]);
  s.door.events.next({
    type: 'start',
    event: {
      id: 'x',
      cameraId: 'door',
      state: 'active',
      startTime: 0,
      lastUpdate: 0,
      types: ['person'],
      triggers: [{ type: 'object', label: 'person', firstSeen: 0, lastSeen: 0 }],
      segments: [{ firstSeen: 0, lastSeen: 0, detections: [{ label: 'person', score: 1, maxCount: 1 }], attributes: [{ type: 'face', label: 'unknown' }] }],
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 2_700));
  await flush();
  assert.deepEqual(s.engine.said, ['У двери незнакомый человек.']);
});

void runTests();
