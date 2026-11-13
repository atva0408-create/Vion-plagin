// The plugin as VION drives it, with a NIKA on a real socket (spec/fake-nika.ts), the network search fed with her
// announcement and VOICE stood in for: connecting her from the page by her code, her notices (said, silent, her own
// requests, switched off, not connected), what she asks for (read at once; more time asked of a parent who allows or
// refuses on the page or in the chat, or nobody answers; given at once in «direct»; a command switched off; wrong
// arguments; VOICE missing), «until 23:00» in the home's time zone, a restart keeping it all, she forgetting this VION,
// and disconnecting.
// Run: npx tsx spec/plugin.spec.ts
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

// «until 23:00» must be read on the home's clock (VOICE's zone, Moscow below), not the server's: a machine in Moscow
// could not tell them apart
process.env.TZ = 'America/New_York';

import { FakeNika } from './fake-nika.js';
import NikaPlugin, { parseAddress } from '../src/index.js';
import { Discovery } from '../src/discovery.js';
import { SERVICE_NAME } from '../src/protocol.js';
import { ruMinutes } from '../src/texts.js';

import type { AssistantToolResult, JsonSchema, Notification } from '@camera.ui/sdk';
import type { MdnsPacket, MulticastDns } from 'multicast-dns';
import type { VoicePort } from '../src/commands.js';
import type { Message } from '../src/protocol.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, what: string, ms = 5_000): Promise<void> {
  for (const end = Date.now() + ms; !condition() && Date.now() < end;) await sleep(10);
  assert.ok(condition(), `${what} did not come within ${ms} ms`);
}

class QuietMdns extends EventEmitter {
  query(): void {}
  destroy(): void {}
}

/** VOICE: answers its tools as it does, keeps what was asked. */
function fakeVoice() {
  const asked: { name: string; input: Record<string, unknown> }[] = [];
  const port: VoicePort = {
    async callAssistantTool(name: string, input: Record<string, unknown>): Promise<AssistantToolResult> {
      asked.push({ name, input });
      if (name === 'voice_status') {
        return {
          content: {
            cameras: [{ camera: 'Xiaomi C300', screenTime: [{ childName: 'Сыночка', enabled: true, now: 'Сыночка: Сегодня: 42 мин. Сейчас: за компьютером' }] }],
          },
        };
      }
      if (name === 'voice_report')
        return input.child === 'Никто' ? { error: 'No screen-time scenario for "Никто".' } : { content: { timezone: 'Europe/Moscow', reports: [] } };
      if (name === 'voice_extend') return { content: { done: true, camera: 'Xiaomi C300', now: 'можно ещё 60 мин' } };
      return { error: `Unknown tool ${name}` };
    },
  };
  return { port, asked };
}

class TestPlugin extends NikaPlugin {
  voicePort?: VoicePort;
  protected createDiscovery(): Discovery {
    return new Discovery({ log: () => undefined, open: () => new QuietMdns() as unknown as MulticastDns });
  }
  protected async voice(): Promise<VoicePort | undefined> {
    return this.voicePort;
  }
  get search(): Discovery {
    return (this as unknown as { discovery: Discovery }).discovery;
  }
  get grantsOf(): { pending: { id: string; expiresAt: number }[]; expire(): Promise<void> } {
    return (this as unknown as { grants: { pending: { id: string; expiresAt: number }[]; expire(): Promise<void> } }).grants;
  }
}

function host(values: Record<string, unknown> = {}) {
  const lines: string[] = [];
  const say = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  const logger = { log: say, warn: say, error: say, debug: () => {}, success: say, trace: () => {}, attention: say };
  const storage = {
    values,
    async setValue(key: string, value: unknown) {
      values[key] = value;
    },
    async setInternalValue(key: string, value: unknown) {
      values[key] = JSON.parse(JSON.stringify(value));
    },
  };
  const published: Notification[] = [];
  const voice = fakeVoice();
  const api = {
    on: () => api,
    notificationManager: { publish: async (n: Notification) => void published.push(n) },
    coreManager: { connectToPlugin: async () => undefined },
  };
  const plugin = new TestPlugin(logger as never, api as never, storage as never);
  plugin.voicePort = voice.port;
  return { plugin, values, lines, published, voice };
}

const field = (plugin: NikaPlugin, key: string) => plugin.storageSchema.find((schema) => schema.key === key) as JsonSchema & Record<string, any>;
const click = (plugin: NikaPlugin, key: string, values: Record<string, unknown> = {}) => field(plugin, key).onClick(values) as Promise<Record<string, any> | undefined>;
const announce = (nika: FakeNika): MdnsPacket => ({
  type: 'response',
  answers: [{ name: SERVICE_NAME, type: 'PTR', ttl: 4500, data: `Ника.${SERVICE_NAME}` }],
  additionals: [
    { name: `Ника.${SERVICE_NAME}`, type: 'SRV', ttl: 120, data: { port: nika.port, target: 'nika.local' } },
    { name: `Ника.${SERVICE_NAME}`, type: 'TXT', ttl: 120, data: [Buffer.from(`id=${nika.id}`), Buffer.from('name=Ника'), Buffer.from('room=Детская')] },
    { name: 'nika.local', type: 'A', ttl: 120, data: '127.0.0.1' },
  ],
});
const results = (nika: FakeNika) => nika.got.filter((message) => message.t === 'result');
const decided = (nika: FakeNika) => nika.got.filter((message) => message.t === 'decided');
let callId = 0;
async function call(nika: FakeNika, name: string, args: Record<string, unknown>, speaker?: string): Promise<Message> {
  const id = `c${++callId}`;
  nika.send({ t: 'call', id, name, args, ...(speaker ? { speaker } : {}) });
  await until(() => results(nika).some((message) => message.id === id), `the result of ${name}`);
  return results(nika).find((message) => message.id === id)!;
}

// ---- small parts
{
  assert.deepEqual(parseAddress(' 192.168.1.50 '), { host: '192.168.1.50', port: 8796 });
  assert.deepEqual(parseAddress('nika.local:9000'), { host: 'nika.local', port: 9000 });
  assert.equal(parseAddress('http://x'), undefined);
  assert.equal(parseAddress('1.2.3.4:70000'), undefined);
  assert.equal(parseAddress(''), undefined);
  assert.deepEqual([1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111, 112, 240].map(ruMinutes), [
    '1 минута',
    '2 минуты',
    '4 минуты',
    '5 минут',
    '11 минут',
    '12 минут',
    '14 минут',
    '21 минута',
    '22 минуты',
    '25 минут',
    '101 минута',
    '111 минут',
    '112 минут',
    '240 минут',
  ]);
}

const nika = new FakeNika({ tries: 3 });
await nika.listen();
const { plugin, values, published, voice, lines } = host();
await plugin.start();
assert.ok(typeof values._vionId === 'string' && (values._vionId as string).length > 10, 'this VION has an id');
assert.match(await field(plugin, 'status').onGet(), /ещё не подключена/);

// ---- connecting from the page: she is found, says a code, a wrong one, then the right one
{
  const empty = await click(plugin, 'connect');
  assert.deepEqual(empty?.schema?.[0]?.enum, ['address'], 'nobody found: only by address');
  plugin.search.onPacket(announce(nika));
  assert.match(await field(plugin, 'status').onGet(), /Найдены в сети[\s\S]*Ника — Детская \(127\.0\.0\.1\)/);
  const first = await click(plugin, 'connect');
  assert.deepEqual(first?.schema?.[0]?.enum, [nika.id, 'address']);
  const second = await click(plugin, 'connect', { nika: nika.id });
  assert.equal(second?.schema?.[0]?.key, 'code');
  assert.match(nika.code ?? '', /^\d{6}$/, 'she said a code');
  const wrong = await click(plugin, 'connect', { code: nika.code === '000000' ? '111111' : '000000' });
  assert.equal(wrong?.toast?.type, 'error');
  assert.match(wrong?.toast?.message, /Осталось попыток: 2/);
  assert.equal(wrong?.schema?.[0]?.key, 'code', 'asked again');
  const right = await click(plugin, 'connect', { code: nika.code });
  assert.equal(right?.toast?.type, 'success');
  assert.equal(right?.schema, undefined, 'the dialog closes');
  const paired = values._paired as { id: string; token: string }[];
  assert.equal(paired.length, 1);
  assert.equal(paired[0].token, nika.tokens.get(values._vionId as string));
  await until(() => nika.online, 'the link');
  await until(() => nika.got.some((message) => message.t === 'offer'), 'the offer');
  const offer = nika.got.find((message) => message.t === 'offer') as Message & { commands: { name: string; grant: boolean }[] };
  assert.deepEqual(
    offer.commands.map((command) => [command.name, command.grant]),
    [
      ['screen_time_status', false],
      ['screen_time_report', false],
      ['screen_time_extend', true],
      ['screen_time_until', true],
    ],
  );
  assert.match(await field(plugin, 'status').onGet(), /Подключены:\n• Ника — Детская: на связи с/);
}

const deviceId = `nika:${nika.id}`;

// ---- her notices
{
  assert.deepEqual(await plugin.getDevices([]), [{ id: deviceId, ownerUserId: '', name: 'Ника — Детская', active: true, metadata: { online: true, room: 'Детская' } }]);
  assert.equal((await plugin.getDevices(['u1', 'u2']))[0].ownerUserId, 'u1');
  assert.equal((await plugin.getDevice(deviceId))?.name, 'Ника — Детская');
  assert.equal(await plugin.getDevice('nika:other'), null);
  await assert.rejects(plugin.registerDevice(), /Connect NIKA/);

  const said = (await plugin.sendNotification([deviceId, 'nika:other'], {
    title: 'Сыночка не ушёл на перерыв.',
    body: 'Играет 55 мин!',
    severity: 'warn' as never,
  })) as unknown;
  assert.deepEqual(said, [
    { deviceId, ok: true },
    { deviceId: 'nika:other', ok: false, error: 'no such NIKA' },
  ]);
  const notice = nika.got.find((message) => message.t === 'notify')!;
  assert.equal(notice.text, 'Сыночка не ушёл на перерыв. Играет 55 мин');
  assert.equal(notice.severity, 'warn');

  const before = nika.got.length;
  assert.deepEqual(await plugin.sendNotification([deviceId], { title: 'banner', silent: true }), [{ deviceId, ok: true }] as never);
  assert.deepEqual(await plugin.sendNotification([deviceId], { title: 'NIKA: нужно ваше разрешение', tag: 'nika:grant:x' }), [{ deviceId, ok: true }] as never);
  await sleep(50);
  assert.equal(nika.got.length, before, 'nothing said for a silent notice or her own request');

  await plugin.updateDevice(deviceId, { active: false, name: 'Детская' });
  assert.deepEqual(await plugin.sendNotification([deviceId], { title: 'x' }), [{ deviceId, ok: false, error: 'saying notifications is off for this NIKA' }] as never);
  assert.equal((await plugin.getDevice(deviceId))?.name, 'Детская', 'renamed in Settings → Notifications');
  await plugin.updateDevice(deviceId, { active: true });
}

// ---- what she asks for: read at once
{
  const status = await call(nika, 'screen_time_status', { child: 'сыночка' });
  assert.equal(status.ok, true);
  // VOICE's own line begins with the name (seen on the bench): not said twice
  assert.equal(status.text, 'Сыночка: Сегодня: 42 мин. Сейчас: за компьютером');
  const nobody = await call(nika, 'screen_time_status', { child: 'Маша' });
  assert.deepEqual([nobody.ok, nobody.error], [false, 'В VOICE нет сценария экранного времени для этого ребёнка.']);
  const report = await call(nika, 'screen_time_report', { child: 'Сыночка', days: 2 });
  assert.equal(report.ok, true);
  assert.deepEqual(voice.asked.at(-1), { name: 'voice_report', input: { child: 'Сыночка', days: 2 } });
  const unknown = await call(nika, 'delete_everything', {});
  assert.match(String(unknown.error), /не знает команды delete_everything/);
  const bad = await call(nika, 'screen_time_extend', { child: 'Сыночка', minutes: 500 });
  assert.deepEqual([bad.ok, bad.error], [false, 'минуты: от 1 до 240']);
  const noChild = await call(nika, 'screen_time_until', { until: '23:00' });
  assert.deepEqual([noChild.ok, noChild.error], [false, 'нужно имя ребёнка']);
  const badClock = await call(nika, 'screen_time_until', { child: 'Сыночка', until: '25:00' });
  assert.deepEqual([badClock.ok, badClock.error], [false, 'время: ЧЧ:ММ, например 23:00']);
}

// ---- more time, asked of a parent: allowed on the page
{
  voice.asked.length = 0;
  published.length = 0;
  const asked = await call(nika, 'screen_time_extend', { child: 'Сыночка', minutes: 60 }, 'Папа');
  assert.equal(asked.ok, true);
  assert.equal(asked.pending, true);
  assert.equal(asked.text, 'Попросила разрешения в VION: Сыночка: ещё 60 минут. Скажу, когда ответят.');
  assert.equal(voice.asked.length, 0, 'nothing given before a parent allows it');
  assert.equal(published.length, 1);
  const notice = published[0];
  assert.equal(notice.adminOnly, true, "a child's account must not be the one that confirms");
  assert.equal(notice.severity, 'warn');
  assert.match(notice.tag ?? '', /^nika:grant:/);
  assert.equal(notice.deepLink, '/plugins/@vionvision/camera-ui-nika');
  assert.match(notice.body ?? '', /^Ника — Детская \(просит Папа\): Сыночка: ещё 60 минут\. Ответьте в VION/);
  assert.match(await field(plugin, 'pending').onGet(), /Ника — Детская \(просит Папа\): Сыночка: ещё 60 минут — ждёт ещё 10 мин\./);

  // asked twice: one request
  await call(nika, 'screen_time_extend', { child: 'Сыночка', minutes: 60 }, 'Папа');
  assert.equal(plugin.grantsOf.pending.length, 1, 'the same request asked again replaces the first');

  const step = await click(plugin, 'answer');
  const request = step?.schema?.[0]?.defaultValue as string;
  assert.ok(request);
  const done = await click(plugin, 'answer', { request, decision: 'allow' });
  assert.equal(done?.toast?.type, 'success');
  assert.deepEqual(voice.asked, [{ name: 'voice_extend', input: { child: 'Сыночка', minutes: 60 } }]);
  await until(() => decided(nika).length === 1, 'her answer');
  assert.equal(decided(nika)[0].approved, true);
  assert.equal(decided(nika)[0].text, 'Разрешили: Сыночка: ещё 60 минут. можно ещё 60 мин', 'allowed, and what VOICE says of the time now, once');
  assert.equal(plugin.grantsOf.pending.length, 0);
  assert.equal((await click(plugin, 'answer', { request, decision: 'allow' }))?.toast?.type, 'info', 'nothing waits any more');
  assert.match(await field(plugin, 'journal').onGet(), /Ника — Детская \(Папа\): Сыночка: ещё 60 минут — разрешили, на странице/);
}

// ---- refused in the chat; nobody answers
{
  voice.asked.length = 0;
  await call(nika, 'screen_time_extend', { child: 'Сыночка', skipBreak: true });
  const request = plugin.grantsOf.pending[0].id;
  const refused = await plugin.callAssistantTool('nika_answer', { request, allow: false }, {} as never);
  assert.match(String((refused.content as { told?: string }).told), /^Не разрешили: Сыночка: без следующего перерыва/);
  await until(() => decided(nika).length === 2, 'her answer');
  assert.equal(decided(nika)[1].approved, false);
  assert.equal(voice.asked.length, 0, 'nothing given');
  assert.match(String((await plugin.callAssistantTool('nika_answer', { request, allow: true }, {} as never)).error), /no such request/);

  await call(nika, 'screen_time_extend', { child: 'Сыночка', minutes: 15 });
  plugin.grantsOf.pending[0].expiresAt = Date.now() - 1;
  await plugin.grantsOf.expire();
  await until(() => decided(nika).length === 3, 'the expiry said');
  assert.equal(decided(nika)[2].approved, false);
  assert.match(String(decided(nika)[2].text), /Разрешение не пришло за 10 минут/);
  assert.equal(voice.asked.length, 0);
}

// ---- given at once in «direct», the parents told; «until» in the home's time zone
{
  values.grants = 'direct';
  voice.asked.length = 0;
  published.length = 0;
  const given = await call(nika, 'screen_time_extend', { child: 'Сыночка', minutes: 30 }, 'Мама');
  assert.equal(given.ok, true);
  assert.equal(given.pending, undefined);
  assert.equal(given.text, 'Готово: Сыночка: ещё 30 минут. можно ещё 60 мин');
  assert.deepEqual(voice.asked, [{ name: 'voice_extend', input: { child: 'Сыночка', minutes: 30 } }]);
  assert.equal(published.length, 1);
  assert.equal(published[0].severity, 'info');
  assert.match(published[0].tag ?? '', /^nika:done:/);
  assert.match(published[0].body ?? '', /\(попросил Мама\)/);

  voice.asked.length = 0;
  const inMoscow = (ms: number) =>
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
  const until90 = await call(nika, 'screen_time_until', { child: 'Сыночка', until: inMoscow(Date.now() + 90 * 60_000) });
  assert.equal(until90.ok, true);
  const extend = voice.asked.find((asked) => asked.name === 'voice_extend')!;
  assert.ok([89, 90].includes(extend.input.minutes as number), `90 minutes in Moscow time, got ${String(extend.input.minutes)}`);
  const past = await call(nika, 'screen_time_until', { child: 'Сыночка', until: inMoscow(Date.now() - 10 * 60_000) });
  assert.deepEqual([past.ok, past.error], [false, 'это время уже наступило']);
  const far = await call(nika, 'screen_time_until', { child: 'Сыночка', until: inMoscow(Date.now() + 6 * 60 * 60_000) });
  assert.deepEqual([far.ok, far.error], [false, 'не больше 4 часов от текущего времени']);
  const noScenario = await call(nika, 'screen_time_until', { child: 'Никто', until: '23:00' });
  assert.deepEqual([noScenario.ok, noScenario.error], [false, 'No screen-time scenario for "Никто".']);
  values.grants = 'confirm';
}

// ---- a command switched off; VOICE missing
{
  values.commands = ['screen_time_status'];
  const off = await call(nika, 'screen_time_extend', { child: 'Сыночка', minutes: 10 });
  assert.deepEqual([off.ok, off.error], [false, 'Эта команда выключена для NIKA в VION.']);
  const offers = () => nika.got.filter((message) => message.t === 'offer');
  const count = offers().length;
  await field(plugin, 'commands').onSet(values.commands, undefined);
  await until(() => offers().length === count + 1, 'the new offer');
  assert.deepEqual(
    (offers().at(-1) as Message & { commands: { name: string }[] }).commands.map((command) => command.name),
    ['screen_time_status'],
  );
  delete values.commands;

  plugin.voicePort = undefined;
  const missing = await call(nika, 'screen_time_status', {});
  assert.match(String(missing.error), /VOICE в VION не установлено или не запущено/);
  plugin.voicePort = voice.port;
}

// ---- the assistant: status, settings, say
{
  const status = (await plugin.callAssistantTool('nika_status', {}, {} as never)).content as Record<string, any>;
  assert.equal(status.connected[0].online, true);
  assert.equal(status.grants, 'confirm');
  const settings = await plugin.callAssistantTool('nika_settings', { grants: 'sometimes' }, {} as never);
  assert.match(String(settings.error), /grants: confirm or direct/);
  await plugin.callAssistantTool('nika_settings', { grants: 'direct', commands: ['screen_time_status', 'screen_time_extend'] }, {} as never);
  assert.equal(values.grants, 'direct');
  assert.deepEqual(values.commands, ['screen_time_status', 'screen_time_extend']);
  delete values.commands;
  values.grants = 'confirm';
  const said = await plugin.callAssistantTool('nika_say', { text: 'Ужин готов' }, {} as never);
  assert.equal((said.content as { said?: boolean }).said, true);
  assert.ok(nika.got.some((message) => message.t === 'say' && message.text === 'Ужин готов'));
}

// ---- a restart keeps NIKA, the journal and what waits
{
  await call(nika, 'screen_time_extend', { child: 'Сыночка', minutes: 5 });
  plugin.stop();
  await until(() => !nika.online, 'the link closed');
  const again = host(values);
  await again.plugin.start();
  again.plugin.search.onPacket(announce(nika));
  await until(() => nika.online, 'the link after the restart', 8_000);
  assert.equal(again.plugin.grantsOf.pending.length, 1, 'the request still waits');
  assert.match(await field(again.plugin, 'journal').onGet(), /спросила родителей/);

  // ---- disconnecting: she forgets the key too
  const step = await click(again.plugin, 'disconnect');
  assert.equal(step?.schema?.[0]?.defaultValue, nika.id);
  const done = await click(again.plugin, 'disconnect', { nika: nika.id });
  assert.equal(done?.toast?.type, 'success');
  await until(() => nika.tokens.size === 0, 'she forgot the key');
  assert.deepEqual(values._paired, []);
  assert.equal(again.plugin.grantsOf.pending.length, 0, 'her requests go with her');
  again.plugin.stop();
}

// ---- she forgot this VION on her side: taken off the list, said in the log
{
  const forgetful = new FakeNika({ id: 'nika-reset' });
  await forgetful.listen();
  const values2: Record<string, unknown> = {
    _vionId: 'v2',
    _paired: [{ id: 'nika-reset', name: 'Ника', room: 'Кухня', token: 'f'.repeat(64), host: '127.0.0.1', port: forgetful.port, manual: true, speaks: true, pairedAt: 1 }],
  };
  const { plugin: third, lines: thirdLines } = host(values2);
  await third.start();
  await until(() => (values2._paired as unknown[]).length === 0, 'taken off');
  assert.ok(thirdLines.some((line) => /no longer knows this VION/.test(line)));
  third.stop();
  await forgetful.close();
}

assert.ok(!lines.some((line) => line.includes(String(values._vionId)) && /[0-9a-f]{64}/.test(line)), 'no token in a log line');
await nika.close();
console.log('plugin: ok');
process.exit(0);
