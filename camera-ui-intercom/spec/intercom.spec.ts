// The intercom at work, on fakes of ViON: a press rings, the first who answers gets the call, the agent answers when
// nobody does, the modes, opening with rights and a log, guest codes, "rang and ran", the blocked, the people who come
// in without a ring, the assistant's tools, panels and their hook, the agent tried in text, the archive's age.
// Run: npx tsx spec/intercom.spec.ts
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeClock, flush, runTests, test } from '../../packages/vion-speech/spec/helpers.js';
import { hashSecret } from '../src/codes.js';
import { Intercom } from '../src/intercom.js';
import { checkProfile } from '../src/panels/profile.js';
import { placeOf } from '../src/place.js';
import { Store } from '../src/store.js';
import { callTool } from '../src/tools.js';

import type { AssistantToolContext, Notification } from '@camera.ui/sdk';
import type { Actor } from '../src/access.js';
import type { DoorResult, IntercomHost } from '../src/intercom.js';
import type { PanelProfile } from '../src/panels/profile.js';
import type { Panel } from '../src/types.js';

const NOW = Date.UTC(2026, 9, 13, 11, 5); // Tuesday 14:05 in Moscow
const admin: Actor = { userId: 'admin', role: 'admin' };
const u1: Actor = { userId: 'u1', role: 'user' };
const u2: Actor = { userId: 'u2', role: 'user' };
const GREETING = 'Здравствуйте! Разговор записывается. Чем могу помочь?';

const hookProfile = checkProfile(JSON.parse(readFileSync(new URL('../profiles/generic-hook.json', import.meta.url), 'utf8'))) as PanelProfile;

class World {
  clock = new FakeClock(NOW);
  dir = mkdtempSync(join(tmpdir(), 'intercom-'));
  store = new Store(join(this.dir, 'intercom.db'));
  published: Notification[] = [];
  opened: string[] = [];
  said: string[] = [];
  recorded: string[] = [];
  announced: string[] = [];
  openResult: DoorResult = { result: 'confirmed' };
  speakProblem: string | undefined;
  person: boolean | undefined;
  host: IntercomHost = {
    clock: this.clock,
    store: this.store,
    dataDir: this.dir,
    pluginVersion: '0.1.0',
    port: () => ({
      snapshot: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      speakProblem: () => this.speakProblem,
      sound: () => ({
        prepare: async (text) => ({
          durationMs: 500,
          play: async () => {
            this.said.push(text);
            return { status: 'spoken' };
          },
        }),
        // no microphone: the agent says its greeting and closes
        listen: async () => {
          throw new Error('no microphone');
        },
        transcribe: async () => '',
      }),
      open: async (door) => {
        this.opened.push(door.id);
        return this.openResult;
      },
      personSeen: () => this.person,
    }),
    publish: async (notification) => {
      this.published.push(notification);
    },
    nvr: async () => ({
      startRecording: async (cameraId) => {
        this.recorded.push(cameraId);
      },
      events: async () => [{ id: 'e1', triggers: ['doorbell'] }],
      favorite: async () => undefined,
    }),
    announce: async (text) => {
      this.announced.push(text);
    },
    ask: () => undefined,
    saveVoicemail: async () => undefined,
    panelsChanged: () => undefined,
    panelWorld: () => ({
      cameras: [
        { id: 'cam1', name: 'Калитка' },
        { id: 'cam2', name: 'Без динамика', speakProblem: 'no talk channel' },
      ],
      sensors: [
        { id: 'bell', type: 'doorbell', name: 'Звонок' },
        { id: 'lock1', type: 'lock', name: 'Замок' },
      ],
      profile: (id) => (id === hookProfile.id ? hookProfile : undefined),
    }),
    timeZone: () => 'Europe/Moscow',
    log: () => undefined,
    warn: () => undefined,
  };
  intercom = new Intercom(this.host);

  constructor(panel: Partial<Panel> = {}) {
    this.store.savePanel({
      id: 'gate',
      name: 'Калитка',
      cameraId: 'cam1',
      doorbellSensorIds: ['bell'],
      doors: [{ id: 'gate', name: 'Калитка', via: { kind: 'lock', sensorId: 'lock1' }, relockSeconds: 5 }],
      callUserIds: ['u1', 'u2'],
      ringMode: 'together',
      orderFirstSeconds: 15,
      openUserIds: [],
      enabled: true,
      ...panel,
    });
  }

  calls(kind = 'intercom.call'): Notification[] {
    return this.published.filter((n) => n.data?.kind === kind);
  }

  titles(): string[] {
    return this.published.map((n) => n.title);
  }

  async pass(ms: number): Promise<void> {
    await this.clock.advance(ms);
    // the files of a visit are written by the disk's threads, not by the fake clock
    await new Promise((resolve) => setTimeout(resolve, 10));
    await flush(20);
  }

  /** A face seen clearly twice: a strong identification. */
  seeFace(name: string): void {
    this.intercom.sighting('cam1', [{ name, score: 0.8 }], []);
    this.intercom.sighting('cam1', [{ name, score: 0.8 }], []);
  }

  callId(): string {
    return this.calls()[0]?.data?.callId ?? '';
  }
}

const ctx = (actor: Actor): AssistantToolContext => ({ userId: actor.userId, role: actor.role, language: 'ru', timezone: 'Europe/Moscow', threadId: 't1' });

test("a press rings the panel's users; presses during the call are counted, three in ten seconds is insistent", async () => {
  const w = new World();
  w.intercom.press('gate');
  await w.pass(100);
  const call = w.calls();
  assert.equal(call.length, 1);
  assert.equal(call[0].data?.recipients, 'u1,u2');
  assert.equal(call[0].deepLink, `/intercom/call/${call[0].data?.callId}`);
  assert.equal(call[0].tag, `intercom:${call[0].data?.callId}`);
  assert.ok(call[0].thumbnail?.length, 'the snapshot goes with the call');
  assert.deepEqual(w.recorded, ['cam1'], 'the recorder writes the panel camera');
  assert.deepEqual(w.announced, ['Звонок: Калитка'], 'the house hears the ring at home');
  w.intercom.press('gate');
  await w.pass(1_000);
  w.intercom.press('gate');
  await w.pass(100);
  assert.equal(w.calls().length, 1, 'no second call of the same panel');
  assert.ok(w.titles().includes('Калитка: настойчиво звонят'));
  assert.equal(w.store.queryVisits({}).visits.length, 1);
});

test('nobody answers in 25 s at home: the agent answers, the visit ends with what happened', async () => {
  const w = new World();
  w.intercom.press('gate');
  await w.pass(24_000);
  assert.deepEqual(w.said, []);
  await w.pass(2_000);
  await w.pass(1_000);
  assert.equal(w.said[0], GREETING);
  const states = w.calls('intercom.call.update').map((n) => n.data?.state);
  assert.deepEqual(states, ['agent', 'ended']);
  const visit = w.store.queryVisits({}).visits[0];
  assert.equal(visit.outcome, 'agent');
  assert.ok(visit.title, 'a title for the archive');
  assert.deepEqual(visit.nvrEventIds, ['e1'], 'the recording of the visit is linked');
  assert.equal(visit.snapshots.length, 1);
  assert.ok(existsSync(join(w.dir, 'visits', visit.id, '1.jpg')));
});

test('the first who answers gets the call, the next is told who did; the agent does not cut in', async () => {
  const w = new World();
  w.intercom.press('gate');
  await w.pass(100);
  const callId = w.callId();
  assert.deepEqual(w.intercom.answerCall({ ...u1, name: 'Маша' }, callId), { ok: true, cameraId: 'cam1' });
  assert.deepEqual(w.intercom.answerCall(u2, callId), { ok: false, taken: 'u1' });
  await w.pass(100);
  // the household is told by name, never by id
  assert.equal(w.calls('intercom.call.update').at(-1)?.title, 'Ответил(а) Маша');
  await w.pass(30_000);
  assert.deepEqual(w.said, []);
  w.intercom.hangUpCall(u1, callId);
  await w.pass(100);
  const visit = w.store.queryVisits({}).visits[0];
  assert.equal(visit.outcome, 'answered');
  assert.equal(visit.answeredBy, 'u1');
  assert.match(visit.summary ?? '', /Ответил\(а\) Маша\./);
  assert.throws(() => w.intercom.answerCall(u2, callId), /not_found/);
});

test("the panel ends its call: ringing stops as missed; a hook's end leaves a call a person answered, a SIP end does not", async () => {
  const w = new World();
  w.intercom.press('gate');
  await w.pass(100);
  w.intercom.panelHungUp('gate', false);
  await w.pass(100);
  assert.equal(w.store.queryVisits({}).visits[0].outcome, 'missed');
  w.intercom.press('gate');
  await w.pass(100);
  const callId = w.calls().at(-1)?.data?.callId ?? '';
  w.intercom.answerCall(u1, callId);
  w.intercom.panelHungUp('gate', false);
  assert.equal(w.intercom.callState(u1, callId).state, 'answered', "the panel's own call with its monitors ended, not ViON's");
  w.intercom.panelHungUp('gate', true);
  await w.pass(100);
  assert.equal(w.intercom.callState(u1, callId).state, 'ended');
  assert.equal(w.store.queryVisits({}).visits[0].outcome, 'answered');
});

test('every user declined: the agent takes the call at once', async () => {
  const w = new World();
  w.intercom.press('gate');
  await w.pass(100);
  w.intercom.declineCall(u1, w.callId());
  await w.pass(100);
  assert.deepEqual(w.said, []);
  w.intercom.declineCall(u2, w.callId());
  await w.pass(1_000);
  assert.equal(w.said[0], GREETING);
});

test('away: nobody is rung and the agent answers at once; a mode set with an end comes back to home by itself', async () => {
  const w = new World();
  assert.throws(() => w.intercom.setMode(u1, 'away'), /forbidden/);
  w.intercom.setMode(admin, 'away', NOW + 60 * 60_000);
  w.intercom.press('gate');
  await w.pass(1_000);
  assert.equal(w.calls().length, 0);
  assert.equal(w.said[0], GREETING);
  assert.deepEqual(w.announced, [], 'the house stays quiet when nobody is home');
  await w.pass(60 * 60_000);
  w.intercom.tick();
  assert.equal(w.intercom.currentMode().mode, 'home');
  assert.ok(w.titles().includes('Домофон: режим «дома» вернулся'));
  w.intercom.setSettings(admin, { modeUserIds: ['u1'] });
  assert.equal(w.intercom.setMode(u1, 'dnd').mode, 'dnd');
});

test('opening: a user needs the right of the panel; the opening is logged and told; an unconfirmed command says so', async () => {
  const w = new World();
  await assert.rejects(w.intercom.openDoorAs(u1, 'gate', 'gate'), /forbidden/);
  assert.deepEqual(await w.intercom.openDoorAs(admin, 'gate', 'Калитка'), { result: 'confirmed' });
  assert.deepEqual(w.opened, ['gate']);
  const log = w.store.doorLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].by, 'admin');
  assert.equal(w.published.at(-1)?.title, 'Калитка: открыто — Калитка');
  w.store.savePanel({ ...w.store.panel('gate')!, openUserIds: ['u1'] });
  w.openResult = { result: 'sent' };
  assert.equal((await w.intercom.openDoorAs(u1, 'gate', 'gate')).result, 'sent');
  assert.match(w.published.at(-1)?.body ?? '', /команда отправлена, подтверждения нет/);
  assert.match(w.published.at(-1)?.body ?? '', /открыл\(а\) пользователь/, 'a user whose name is not known is not named by id');
  await w.intercom.openDoorAs({ ...u1, name: 'Маша' }, 'gate', 'gate');
  assert.match(w.published.at(-1)?.body ?? '', /открыл\(а\) Маша/);
});

test('a guest code: opening wants it, it is given once, typed at the panel it opens once; guessing closes the panel', async () => {
  const w = new World();
  await assert.rejects(
    () => w.intercom.addInstruction(admin, { text: 'сантехник, открой', expect: { label: 'сантехник' }, open: ['Калитка'] }),
    /face, a plate or a guest code/,
  );
  const made = await w.intercom.addInstruction(admin, { text: 'сантехник, открой', expect: { label: 'сантехник' }, open: ['Калитка'], guestCode: true });
  assert.ok(made.code && /^\d{6}$/.test(made.code.digits));
  assert.ok(made.code.text.includes(`${made.code.digits.slice(0, 3)} ${made.code.digits.slice(3)}`));
  const stored = JSON.stringify(w.store.codes());
  assert.ok(!stored.includes(made.code.digits), 'only the hash is kept');
  assert.equal(await w.intercom.panelInput('cam1', made.code.digits), true);
  assert.deepEqual(w.opened, ['gate']);
  assert.equal(w.store.codes()[0].uses, 1);
  await w.pass(100);
  // a guest with a code needs nobody: no ring, no call in the state, a visit of its own in the archive
  assert.equal(w.calls().length, 0, 'a code typed with no call rings nobody');
  const entry = w.store.queryVisits({}).visits[0];
  assert.deepEqual([entry.trigger, entry.outcome, entry.title], ['code', 'opened', 'Вход по коду: сантехник']);
  assert.equal(await w.intercom.panelInput('cam1', made.code.digits), false, 'used up');
  const wrong = made.code.digits === '000000' ? '111111' : '000000';
  assert.equal(await w.intercom.panelInput('cam1', wrong), false);
  assert.equal(await w.intercom.panelInput('cam1', wrong), false, 'the third try of the visit');
  assert.equal((w.intercom.intercomState(admin).calls as unknown[]).length, 0, 'the quiet visit is no call');
  await w.pass(61_000);
  assert.equal(w.store.queryVisits({}).visits[0].title, 'Неверный код на клавиатуре');
  // the visitor rings after a wrong code: the ring is a call
  await w.intercom.panelInput('cam1', wrong);
  w.intercom.press('gate');
  await w.pass(100);
  assert.equal(w.calls().length, 1);
  w.intercom.hangUpCall(admin, w.calls().at(-1)?.data?.callId ?? '');
  await w.pass(100);
  assert.equal(await w.intercom.panelInput('cam1', wrong), false);
  assert.equal(await w.intercom.panelInput('cam1', wrong), false);
  assert.ok(w.titles().includes('Калитка: подбирали код'), 'five wrong codes on the panel within ten minutes');
  // the visit tells the codes in the household's language
  const details = w.store
    .queryVisits({})
    .visits.flatMap((v) => v.actions)
    .filter((a) => a.kind === 'code')
    .map((a) => a.detail);
  assert.ok(details.some((d) => d?.startsWith('код гостя «')));
  assert.ok(details.includes('неверный код'));
});

test('"rang and ran" three times: the panel stops calling for ten minutes, with one notice', async () => {
  const w = new World();
  w.person = false;
  for (let i = 0; i < 3; i++) {
    w.intercom.press('gate');
    await w.pass(26_000);
    await w.pass(1_000);
  }
  assert.deepEqual(w.said, [], 'the agent does not talk to an empty street');
  assert.equal(w.store.queryVisits({ outcomes: ['nobody'] }).visits.length, 3);
  assert.equal(w.titles().filter((t) => t === 'Калитка: звонят и убегают').length, 1);
  const rang = w.calls().length;
  w.intercom.press('gate');
  await w.pass(1_000);
  assert.equal(w.calls().length, rang, 'silenced');
});

test('a blocked person known by face: no ring, a short answer, the owners are told', async () => {
  const w = new World();
  w.intercom.setPerson(admin, { name: 'Вася', role: 'blocked', faceNames: ['vasya'], blockedSeverity: 'critical' });
  w.seeFace('vasya');
  w.intercom.press('gate');
  await w.pass(1_000);
  assert.equal(w.calls().length, 0);
  assert.equal(w.said[0], 'Хозяева не могут подойти.');
  const notice = w.published.find((n) => n.title === 'Калитка: Вася');
  assert.equal(notice?.severity, 'critical');
});

test('a person who comes in without a ring: known by face, with access now, the door opens and nobody is called', async () => {
  const w = new World();
  const { person, warnings } = w.intercom.setPerson(admin, {
    name: 'Маша',
    role: 'family',
    faceNames: ['masha'],
    access: [{ doors: ['Калитка'] }],
    openWithoutRing: true,
  });
  assert.deepEqual(warnings, []);
  assert.equal(person.access[0].doors[0], 'gate');
  w.seeFace('masha');
  w.intercom.press('gate');
  await w.pass(1_000);
  assert.deepEqual(w.opened, ['gate']);
  assert.deepEqual(w.said, ['Маша, открываю.']);
  assert.equal(w.calls().length, 0);
  assert.equal(w.store.doorLog()[0].by, `rule:${person.id}`);
  assert.equal(w.store.queryVisits({}).visits[0].outcome, 'opened');
});

test("the assistant's tools: an instruction in words, the archive with links to visits, errors the model can repair", async () => {
  const w = new World();
  const added = await callTool(
    w.intercom,
    'intercom_add_instruction',
    { text: 'приедет курьер Озона, пусть оставит у калитки', label: 'курьер Озона', companies: ['Озон'], say: 'Оставьте, пожалуйста, у калитки.' },
    ctx(u1),
  );
  const created = (added.content as { created: { expect: string; recognizedBy: string } }).created;
  assert.equal(created.expect, 'курьер Озона');
  assert.equal(created.recognizedBy, 'what the visitor says');
  assert.equal(w.store.instructions()[0].threadId, 't1', 'the result goes back to the thread');
  w.intercom.press('gate');
  await w.pass(100);
  w.intercom.hangUpCall(u1, w.callId());
  await w.pass(100);
  const visits = await callTool(w.intercom, 'intercom_visits', {}, ctx(u1));
  assert.equal((visits.content as { visits: unknown[] }).visits.length, 1);
  assert.equal((visits.references?.[0] as unknown as { kind: string }).kind, 'intercom-visit');
  const open = await callTool(w.intercom, 'intercom_open', { panel: 'Калитка' }, ctx(u1));
  assert.match(open.error ?? '', /forbidden/);
  assert.match((await callTool(w.intercom, 'intercom_set_mode', { mode: 'party' }, ctx(admin))).error ?? '', /mode: one of/);
  const listed = await callTool(w.intercom, 'intercom_instructions', {}, ctx(u2));
  assert.deepEqual(listed.content, [], "another user's instructions are not listed");
});

test('panels: checked on save; a camera that cannot speak is a warning; a hook model gives its address once, the password stays apart', async () => {
  const w = new World();
  const draft = { name: 'Ворота', cameraId: 'cam2', driver: { profileId: hookProfile.id, host: '10.0.0.5', username: 'admin', password: 'secret-1' } };
  assert.throws(() => w.intercom.savePanel(u1, draft), /forbidden/);
  assert.throws(() => w.intercom.savePanel(admin, { ...draft, cameraId: 'nope' }), /cameraId/);
  const saved = w.intercom.savePanel(admin, draft);
  assert.ok(saved.warnings.some((warning) => warning.includes('no talk channel')));
  const token = saved.hookPath?.split('/').at(-1) ?? '';
  assert.match(saved.hookPath ?? '', new RegExp(`^/api/intercom/hook/${saved.panel.id}/[a-f0-9]{32}$`));
  assert.equal(await w.intercom.hookTokenMatches(saved.panel, token), true);
  assert.equal(await w.intercom.hookTokenMatches(saved.panel, 'f'.repeat(32)), false);
  assert.match(w.store.panel(saved.panel.id)?.driver?.hookTokenHash ?? '', /^sha256:[a-f0-9]{64}$/, 'a fast hash: the address is open to anyone');
  // a token hashed by scrypt before: still taken, and kept as the fast hash from then on
  const legacy = { ...saved.panel, driver: { ...saved.panel.driver!, hookTokenHash: hashSecret(token, saved.panel.id).hash } };
  w.store.savePanel(legacy);
  assert.equal(await w.intercom.hookTokenMatches(legacy, 'f'.repeat(32)), false);
  assert.equal(await w.intercom.hookTokenMatches(legacy, token), true);
  assert.match(w.store.panel(saved.panel.id)?.driver?.hookTokenHash ?? '', /^sha256:/);
  assert.ok(!JSON.stringify(w.store.panels()).includes('secret-1'), 'the password is not in the panel');
  assert.equal(w.intercom.panelPassword(saved.panel.id), 'secret-1');
  assert.equal(w.intercom.savePanel(admin, { id: saved.panel.id, name: 'Ворота у дороги' }).hookPath, undefined, 'the address is given once');
});

test('the agent tried in text: it answers and tells what it would do, and does nothing', async () => {
  const w = new World();
  await w.intercom.addInstruction(admin, { text: 'курьер Озона', expect: { label: 'курьер Озона', companies: ['Озон'] }, say: 'Оставьте у калитки.' });
  const first = await w.intercom.simulate(admin, 's1', '');
  assert.equal(first.say, GREETING);
  const reply = await w.intercom.simulate(admin, 's1', 'Здравствуйте, я из Озона');
  assert.equal(reply.say, 'Хозяева просили передать: Оставьте у калитки.');
  assert.equal((reply.matched as { label: string }).label, 'курьер Озона');
  assert.deepEqual(w.published, []);
  assert.deepEqual(w.store.doorLog(), []);
  assert.equal(w.store.instructions()[0].doneAt, undefined, 'a test does not use the instruction up');
  await assert.rejects(w.intercom.simulate(u1, 's2', ''), /forbidden/);
});

test('settings are checked; old visits go with their files', async () => {
  const w = new World();
  assert.throws(() => w.intercom.setSettings(u1, { retentionDays: 1 }), /forbidden/);
  assert.throws(() => w.intercom.setSettings(admin, { agent: { speed: 5 } }), /agent.speed/);
  w.intercom.setSettings(admin, { retentionDays: 1 });
  w.intercom.press('gate');
  await w.pass(100);
  w.intercom.hangUpCall(u1, w.callId());
  await w.pass(100);
  const visit = w.store.queryVisits({}).visits[0];
  assert.ok(existsSync(join(w.dir, 'visits', visit.id)));
  await w.pass(2 * 24 * 60 * 60_000);
  w.intercom.tick();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(w.store.queryVisits({}).visits.length, 0);
  assert.ok(!existsSync(join(w.dir, 'visits', visit.id)));
});

test('where a panel stands, from the floor plan: the rooms on both sides of its passage and the notes', () => {
  const panel = new World().store.panel('gate')!;
  const plan = {
    rooms: {
      rooms: [
        { id: 'street', name: 'Улица', outdoor: true },
        { id: 'yard', name: 'Двор' },
      ],
    },
    plan: {
      connections: [{ id: 'c1', fromRoomId: 'street', toRoomId: 'yard', note: 'почтовый ящик слева' }],
      sensors: [{ sensorId: 'bell', roomId: 'street', connectionId: 'c1', note: '' }],
    },
  };
  assert.equal(placeOf(panel, plan), 'between "Улица" (outdoors) and "Двор"; почтовый ящик слева');
  assert.equal(placeOf(panel, { ...plan, plan: { ...plan.plan, sensors: [] } }), undefined, 'not on the plan');
  assert.equal(placeOf(panel, undefined), undefined);
});

void runTests();
