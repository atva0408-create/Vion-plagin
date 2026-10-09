// The intercom's decisions without sound or timers: the call, whom it rings, who may open, which instruction a visitor
// is, guest codes, modes, windows of time, who is at the door. Run: npx tsx spec/core.spec.ts
import assert from 'node:assert/strict';

import { runTests, test } from '../../packages/vion-speech/spec/helpers.js';
import { newCall, step } from '../src/call.js';
import { CodeGuard, findCode, hashSecret, newCode, secretMatches } from '../src/codes.js';
import { findCompany, sameCompany } from '../src/companies.js';
import { faceIdentifications, normalizePlate, plateIdentifications } from '../src/identify.js';
import { activeInstructions, enough, expectedKinds, matchInstruction } from '../src/instructions.js';
import { DEFAULT_MODE_SETTINGS, DEFAULT_NIGHT, currentMode, expiredMode } from '../src/modes.js';
import { route } from '../src/route.js';
import { mayOpen } from '../src/rules.js';
import { activeSpan, instructionActive, nextStart } from '../src/schedule.js';

import type { Call } from '../src/call.js';
import type { GuestCode, Identification, Instruction, Person } from '../src/types.js';

const TZ = 'Europe/Moscow';
/** 2026-10-13 is a Tuesday; 12:00 in Moscow is 09:00 UTC. */
const TUE_NOON = Date.UTC(2026, 9, 13, 9, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

const ctx = (now: number, agentEnabled = true) => ({ now, agentEnabled });

function person(over: Partial<Person> = {}): Person {
  return { id: 'p1', name: 'Маша', role: 'family', faceNames: ['Маша'], plates: [], access: [], openWithoutRing: false, notifyOnArrival: [], ...over };
}

function instruction(over: Partial<Instruction> = {}): Instruction {
  return {
    id: 'i1',
    createdBy: 'u1',
    createdAt: TUE_NOON - HOUR,
    text: 'приедет курьер Озона, пусть оставит у калитки',
    panels: 'all',
    when: { kind: 'window', from: TUE_NOON - HOUR, to: TUE_NOON + 10 * HOUR },
    once: true,
    expect: { label: 'курьер Озона', category: 'delivery', companies: ['Озон'] },
    minIdentification: 'weak',
    say: 'Оставьте у калитки, за забор проходить не нужно',
    sayVerbatim: false,
    callOwner: 'if_needed',
    notify: 'normal',
    record: true,
    ...over,
  };
}

const strongFace = (personId: string, name = 'Маша'): Identification => ({ kind: 'face', value: name, personId, score: 0.7, strength: 'strong', at: TUE_NOON });

// ---- the call ----

test('a call: ringing, the mode runs out, the agent answers; with the agent off the call is missed', () => {
  const call = newCall('c1', 'v1', 'gate', ['u1', 'u2'], TUE_NOON);
  const toAgent = step(call, { type: 'ring_timeout' }, ctx(TUE_NOON + 25_000));
  assert.equal(toAgent.call.state, 'agent');
  assert.deepEqual(toAgent.effects, ['ring_stop', 'agent_start', 'update']);
  const missed = step(call, { type: 'ring_timeout' }, ctx(TUE_NOON + 25_000, false));
  assert.equal(missed.call.state, 'ended');
  assert.equal(missed.call.outcome, 'missed');
});

test('the first who answers gets the call; the second is told who; the agent stops when someone takes over', () => {
  let call: Call = newCall('c1', 'v1', 'gate', ['u1', 'u2'], TUE_NOON);
  const first = step(call, { type: 'answer', userId: 'u2' }, ctx(TUE_NOON + 3000));
  assert.equal(first.call.answeredBy, 'u2');
  assert.deepEqual(first.effects, ['ring_stop', 'update']);
  const second = step(first.call, { type: 'answer', userId: 'u1' }, ctx(TUE_NOON + 3500));
  assert.equal(second.refused, 'taken');
  assert.equal(second.takenBy, 'u2');
  call = step(call, { type: 'to_agent', userId: 'u1' }, ctx(TUE_NOON + 1000)).call;
  const taken = step(call, { type: 'take_over', userId: 'u1' }, ctx(TUE_NOON + 9000));
  assert.equal(taken.call.state, 'answered');
  assert.deepEqual(taken.effects, ['agent_stop', 'update']);
});

test('presses during a call are counted, never a second call; three within ten seconds say "insistent"', () => {
  let call = newCall('c1', 'v1', 'gate', ['u1'], TUE_NOON);
  const a = step(call, { type: 'press' }, ctx(TUE_NOON + 2000));
  assert.equal(a.call.presses, 2);
  assert.equal(a.call.state, 'ringing');
  assert.equal(a.insistent, false);
  call = a.call;
  const b = step(call, { type: 'press' }, ctx(TUE_NOON + 4000));
  assert.equal(b.insistent, true);
  const late = step(newCall('c2', 'v2', 'gate', ['u1'], TUE_NOON), { type: 'press' }, ctx(TUE_NOON + 30_000));
  assert.equal(late.insistent, false, 'presses far apart do not insist');
});

test('everyone declined: the agent answers, or the call ends declined; one decline of two keeps ringing', () => {
  const call = newCall('c1', 'v1', 'gate', ['u1', 'u2'], TUE_NOON);
  const one = step(call, { type: 'decline', userId: 'u1' }, ctx(TUE_NOON + 1000));
  assert.equal(one.call.state, 'ringing');
  const both = step(one.call, { type: 'decline', userId: 'u2' }, ctx(TUE_NOON + 2000));
  assert.equal(both.call.state, 'agent');
  const noAgent = step(one.call, { type: 'decline', userId: 'u2' }, ctx(TUE_NOON + 2000, false));
  assert.equal(noAgent.call.outcome, 'declined');
});

test('an ended call takes nothing; a restart ends a call as interrupted; a rule opening while it rings ends it opened', () => {
  const call = newCall('c1', 'v1', 'gate', ['u1'], TUE_NOON);
  const interrupted = step(call, { type: 'interrupted' }, ctx(TUE_NOON + 1000));
  assert.equal(interrupted.call.outcome, 'interrupted');
  assert.equal(step(interrupted.call, { type: 'answer', userId: 'u1' }, ctx(TUE_NOON + 2000)).refused, 'ended');
  assert.equal(step(call, { type: 'auto_open' }, ctx(TUE_NOON + 1500)).call.outcome, 'opened');
  const agent = step(call, { type: 'to_agent' }, ctx(TUE_NOON)).call;
  assert.equal(step(agent, { type: 'auto_open' }, ctx(TUE_NOON + 100)).call.state, 'agent', 'the agent finishes "opening" itself');
  assert.equal(step(agent, { type: 'hang_up', outcome: 'message' }, ctx(TUE_NOON + 60_000)).call.outcome, 'message');
});

// ---- whom a press rings ----

test('route: each mode rings whom the table says, and the agent answers at once when nobody is rung', () => {
  const base = { recipients: ['u1', 'u2'], expected: false, forceCall: false, silenced: false };
  const home = route({ ...base, mode: { mode: 'home', source: 'default' }, settings: DEFAULT_MODE_SETTINGS.home });
  assert.deepEqual(home.ring, ['u1', 'u2']);
  assert.equal(home.agentAfterMs, 25_000);
  assert.equal(home.chime, true);
  const away = route({ ...base, mode: { mode: 'away', source: 'set' }, settings: DEFAULT_MODE_SETTINGS.away });
  assert.deepEqual(away.ring, []);
  assert.equal(away.agentAfterMs, 0);
  const night = route({ ...base, mode: { mode: 'night', source: 'night' }, settings: DEFAULT_MODE_SETTINGS.night });
  assert.deepEqual(night.ring, [], 'a stranger at night: the agent');
  const nightFamily = route({
    ...base,
    known: { person: person(), strength: 'strong' },
    mode: { mode: 'night', source: 'night' },
    settings: DEFAULT_MODE_SETTINGS.night,
  });
  assert.deepEqual(nightFamily.ring, ['u1', 'u2']);
  const nightWeak = route({ ...base, known: { person: person(), strength: 'weak' }, mode: { mode: 'night', source: 'night' }, settings: DEFAULT_MODE_SETTINGS.night });
  assert.deepEqual(nightWeak.ring, [], 'a face seen once does not wake the house');
  const nightExpected = route({ ...base, expected: true, mode: { mode: 'night', source: 'night' }, settings: DEFAULT_MODE_SETTINGS.night });
  assert.deepEqual(nightExpected.ring, ['u1', 'u2']);
  const dnd = route({ ...base, mode: { mode: 'dnd', source: 'set' }, settings: DEFAULT_MODE_SETTINGS.dnd });
  assert.equal(dnd.silent, true);
  assert.equal(dnd.chime, false);
  const child = route({ ...base, mode: { mode: 'child', source: 'set' }, settings: { ...DEFAULT_MODE_SETTINGS.child, userIds: ['mom'] } });
  assert.deepEqual(child.ring, ['mom']);
  const forced = route({ ...base, forceCall: true, mode: { mode: 'away', source: 'set' }, settings: DEFAULT_MODE_SETTINGS.away });
  assert.deepEqual(forced.ring, ['u1', 'u2'], 'an instruction "call me" rings even when away');
});

test('route: a blocked person is not rung; a person who comes in without a ring is opened for; a silenced panel rings nobody', () => {
  const base = {
    recipients: ['u1'],
    expected: false,
    forceCall: false,
    silenced: false,
    mode: { mode: 'home' as const, source: 'default' as const },
    settings: DEFAULT_MODE_SETTINGS.home,
  };
  const blocked = route({ ...base, known: { person: person({ role: 'blocked', name: 'Сосед' }), strength: 'strong' } });
  assert.deepEqual(blocked.ring, []);
  assert.equal(blocked.blocked?.name, 'Сосед');
  const opener = route({ ...base, known: { person: person({ openWithoutRing: true }), strength: 'strong' }, autoOpenDoorId: 'gate' });
  assert.equal(opener.autoOpenDoorId, 'gate');
  assert.deepEqual(opener.ring, []);
  const weakOpener = route({ ...base, known: { person: person({ openWithoutRing: true }), strength: 'weak' }, autoOpenDoorId: 'gate' });
  assert.equal(weakOpener.autoOpenDoorId, undefined, 'only a strong identification comes in without a ring');
  const silenced = route({ ...base, silenced: true });
  assert.deepEqual(silenced.ring, []);
});

// ---- who may open ----

const open = (over: Partial<Parameters<typeof mayOpen>[0]> = {}) =>
  mayOpen({ doorId: 'gate', now: TUE_NOON, timeZone: TZ, identifications: [], people: [], active: [], codes: [], heard: {}, ...over });

test('mayOpen: nothing opens without a rule; an instruction that opens wants a strong match unless the owner agreed', () => {
  assert.equal(open().ok, false);
  const opening = instruction({ open: ['gate'], minIdentification: 'strong' });
  const matched = matchInstruction([opening], [], { company: 'Ozon' }).best!;
  const weak = open({ active: [opening], candidate: matched, heard: { company: 'Ozon' } });
  assert.equal(weak.ok, false);
  assert.equal(!weak.ok && weak.refusal, 'weak');
  const agreed = open({ active: [{ ...opening, openOnWeak: true }], candidate: { ...matched, instruction: { ...opening, openOnWeak: true } } });
  assert.equal(agreed.ok, true);
  assert.equal(open({ doorId: 'boiler', active: [opening], candidate: matched }).ok, false, 'another door');
});

test('mayOpen: a person known strongly in their window opens; out of it, or seen weakly, does not', () => {
  const masha = person({ access: [{ days: ['tue'], from: '10:00', to: '18:00', doors: ['gate'] }] });
  assert.equal(open({ people: [masha], identifications: [strongFace('p1')] }).ok, true);
  assert.equal(open({ people: [masha], identifications: [strongFace('p1')], now: TUE_NOON + 7 * HOUR }).ok, false, '19:00 is out of the window');
  assert.equal(open({ people: [masha], identifications: [{ ...strongFace('p1'), strength: 'weak' }] }).ok, false);
});

test('mayOpen: blocked never; "never open" of a matching instruction wins, except for family when it says so', () => {
  const masha = person({ access: [{ days: ['tue'], from: '00:00', to: '23:59', doors: ['gate'] }] });
  const blocked = person({ id: 'p2', name: 'Бывший', role: 'blocked', faceNames: ['Бывший'] });
  const refusal = open({ people: [blocked], identifications: [strongFace('p2', 'Бывший')] });
  assert.equal(!refusal.ok && refusal.refusal, 'blocked');
  const never = instruction({ id: 'never', expect: { label: '*' }, neverOpen: true, text: 'никому не открывай до утра' });
  const forbidden = open({ people: [masha], identifications: [strongFace('p1')], active: [never] });
  assert.equal(!forbidden.ok && forbidden.refusal, 'never_open');
  const exceptFamily = open({ people: [masha], identifications: [strongFace('p1')], active: [{ ...never, exceptFamily: true }] });
  assert.equal(exceptFamily.ok, true);
});

test('mayOpen: a guest code opens the doors it was given for', () => {
  const code: GuestCode = {
    id: 'g1',
    label: 'сантехник',
    hash: '',
    salt: '',
    doors: ['gate'],
    from: 0,
    to: TUE_NOON + HOUR,
    maxUses: 1,
    uses: 0,
    createdBy: 'u1',
    createdAt: 0,
  };
  const id: Identification = { kind: 'code', value: 'g1', strength: 'strong', at: TUE_NOON };
  assert.equal(open({ codes: [code], identifications: [id] }).ok, true);
  assert.equal(open({ codes: [code], identifications: [id], doorId: 'boiler' }).ok, false);
});

// ---- which instruction a visitor is ----

test('instructions: the service as said ("я с Ozon") matches "курьер Озона"; a face beats words; two alike make the agent ask', () => {
  const ozon = instruction();
  assert.equal(matchInstruction([ozon], [], { company: 'Ozon' }).best?.by, 'company');
  assert.equal(matchInstruction([ozon], [], { company: 'Wildberries' }).best, undefined);
  const masha = instruction({ id: 'i2', expect: { label: 'Маша', names: ['Маша'], personIds: ['p1'] }, minIdentification: 'strong', say: 'ключ у соседки' });
  const byFace = matchInstruction([ozon, masha], [strongFace('p1')], { company: 'Ozon' });
  assert.equal(byFace.best?.instruction.id, 'i2', 'strong beats weak');
  const byName = matchInstruction([masha], [], { name: 'маша' }).best!;
  assert.equal(byName.strength, 'weak');
  assert.equal(enough(byName), false, 'a key is not told to a name');
  const twin = instruction({ id: 'i3', text: 'ещё одна посылка Озона' });
  assert.equal(matchInstruction([ozon, twin], [], { company: 'Озон' }).ambiguous.length, 2);
});

test('instructions: only those of the panel, in their time, not done or cancelled; the kinds the agent may ask about', () => {
  const list = [
    instruction(),
    instruction({ id: 'done', doneAt: TUE_NOON - MIN }),
    instruction({ id: 'cancelled', cancelledAt: TUE_NOON - MIN }),
    instruction({ id: 'other', panels: ['door'] }),
    instruction({ id: 'later', when: { kind: 'window', from: TUE_NOON + HOUR, to: TUE_NOON + 2 * HOUR } }),
    instruction({ id: 'tuesdays', when: { kind: 'weekly', days: ['tue'], from: '10:00', to: '14:00' }, expect: { label: 'Оля', category: 'service', names: ['Оля'] } }),
  ];
  const active = activeInstructions(list, 'gate', TUE_NOON, TZ);
  assert.deepEqual(
    active.map((i) => i.id),
    ['i1', 'tuesdays'],
  );
  assert.deepEqual(expectedKinds(active).sort(), ['delivery', 'service']);
});

test('companies: forms and mishearings; whole words only', () => {
  assert.equal(findCompany('Здравствуйте, я из Wildberries')?.name, 'Wildberries');
  assert.equal(findCompany('валдберис доставка')?.name, 'Wildberries');
  assert.equal(findCompany('СДЕК')?.name, 'СДЭК');
  assert.equal(findCompany('газета'), undefined);
  assert.equal(sameCompany('Озон', 'ozon'), true);
  assert.equal(sameCompany('Озон', 'Самокат'), false);
});

// ---- guest codes ----

test('codes: six digits, kept as a hash; usable only in the window and while uses are left', () => {
  const code = newCode();
  assert.match(code, /^\d{6}$/);
  const { hash, salt } = hashSecret(code);
  assert.equal(secretMatches(code, hash, salt), true);
  assert.equal(secretMatches('000000' === code ? '111111' : '000000', hash, salt), false);
  const guest: GuestCode = {
    id: 'g1',
    label: 'гость',
    hash,
    salt,
    doors: ['gate'],
    from: TUE_NOON,
    to: TUE_NOON + HOUR,
    maxUses: 1,
    uses: 0,
    createdBy: 'u1',
    createdAt: TUE_NOON,
  };
  assert.equal(findCode([guest], code, TUE_NOON + MIN)?.id, 'g1');
  assert.equal(findCode([guest], code, TUE_NOON - MIN), undefined, 'before its window');
  assert.equal(findCode([{ ...guest, uses: 1 }], code, TUE_NOON + MIN), undefined, 'used up');
  assert.equal(findCode([{ ...guest, revokedAt: TUE_NOON }], code, TUE_NOON + MIN), undefined, 'revoked');
});

test('codes: five wrong ones in ten minutes close the panel to codes for ten minutes', () => {
  const guard = new CodeGuard();
  for (let i = 0; i < 4; i++) assert.equal(guard.fail('gate', TUE_NOON + i * MIN), false);
  assert.equal(guard.locked('gate', TUE_NOON + 4 * MIN), false);
  assert.equal(guard.fail('gate', TUE_NOON + 4 * MIN), true);
  assert.equal(guard.locked('gate', TUE_NOON + 5 * MIN), true);
  assert.equal(guard.locked('door', TUE_NOON + 5 * MIN), false, 'another panel');
  assert.equal(guard.locked('gate', TUE_NOON + 15 * MIN), false);
  const slow = new CodeGuard();
  for (let i = 0; i < 5; i++) slow.fail('gate', TUE_NOON + i * 3 * MIN);
  assert.equal(slow.locked('gate', TUE_NOON + 13 * MIN), false, 'wrong ones spread over more than ten minutes');
});

// ---- modes and time ----

test('modes: a mode set by hand holds until its end, the night replaces only home', () => {
  const night = [DEFAULT_NIGHT];
  const at2300 = TUE_NOON + 11 * HOUR;
  assert.equal(currentMode({ mode: 'home' }, night, TUE_NOON, TZ).mode, 'home');
  assert.equal(currentMode({ mode: 'home' }, night, at2300, TZ).mode, 'night');
  assert.equal(currentMode({ mode: 'away', until: at2300 + HOUR }, night, at2300, TZ).mode, 'away', 'set by hand wins over the night');
  const expired = { mode: 'away' as const, until: TUE_NOON - MIN };
  assert.equal(currentMode(expired, night, TUE_NOON, TZ).mode, 'home');
  assert.equal(expiredMode(expired, TUE_NOON), true);
});

test('windows: a morning start belongs to the day named; a night crosses midnight; the next start', () => {
  const tuesday = [{ days: ['tue' as const], from: '10:00', to: '14:00' }];
  assert.ok(activeSpan(tuesday, TUE_NOON, TZ));
  assert.equal(activeSpan(tuesday, TUE_NOON + 24 * HOUR, TZ), undefined, 'Wednesday');
  const night = [{ days: ['tue' as const], from: '23:00', to: '07:00' }];
  assert.ok(activeSpan(night, TUE_NOON + 18 * HOUR, TZ), 'Wednesday 06:00 is still Tuesday night');
  assert.equal(nextStart(tuesday, TUE_NOON + 3 * HOUR, TZ), Date.UTC(2026, 9, 20, 7, 0), 'next Tuesday 10:00');
  assert.equal(instructionActive({ kind: 'weekly', days: ['tue'], from: '10:00', to: '14:00', until: TUE_NOON }, TUE_NOON, TZ), false, 'repetition ended');
});

test('windows: a daylight-saving night is neither shorter nor longer than the wall clock says', () => {
  // Berlin, 2026-03-29: clocks jump from 02:00 to 03:00; a Sunday window 01:00–04:00 lasts two hours
  const window = [{ days: ['sun' as const], from: '01:00', to: '04:00' }];
  const span = activeSpan(window, Date.UTC(2026, 2, 29, 1, 30), 'Europe/Berlin');
  assert.ok(span);
  assert.equal(span.to - span.from, 2 * HOUR);
});

// ---- who is at the door ----

test('faces: a known face seen clearly twice is strong; once, unknown, or blurred is weak', () => {
  const people = [person()];
  const twice = faceIdentifications(
    [
      { name: 'Маша', score: 0.6, at: 1 },
      { name: 'Маша', score: 0.58, at: 2 },
    ],
    people,
  );
  assert.equal(twice[0].strength, 'strong');
  assert.equal(twice[0].personId, 'p1');
  assert.equal(faceIdentifications([{ name: 'Маша', score: 0.9, at: 1 }], people)[0].strength, 'weak');
  assert.equal(
    faceIdentifications(
      [
        { name: 'Маша', score: 0.5, at: 1 },
        { name: 'Маша', score: 0.5, at: 2 },
      ],
      people,
    )[0].strength,
    'weak',
  );
  assert.equal(faceIdentifications([{ name: 'unknown', score: 0.9, at: 1 }], people).length, 0);
  const stranger = faceIdentifications(
    [
      { name: 'Пётр', score: 0.9, at: 1 },
      { name: 'Пётр', score: 0.9, at: 2 },
    ],
    people,
  );
  assert.equal(stranger[0].strength, 'weak', 'a face the recorder knows but the directory does not');
});

test('plates: either alphabet, spaces and dashes; read twice is strong', () => {
  assert.equal(normalizePlate('а 001 аа-77'), 'A001AA77');
  assert.equal(normalizePlate('A001AA 77'), 'A001AA77');
  const people = [person({ plates: ['А001АА77'] })];
  const ids = plateIdentifications(
    [
      { plate: 'A001AA77', score: 0.95, at: 1 },
      { plate: 'А001АА 77', score: 0.93, at: 2 },
    ],
    people,
  );
  assert.equal(ids[0].strength, 'strong');
  assert.equal(ids[0].personId, 'p1');
});

void runTests();
