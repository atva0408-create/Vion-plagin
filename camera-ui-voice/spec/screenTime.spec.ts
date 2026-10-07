// Screen time: sessions, breaks, bedtime, escalation, daylight saving and a restart. Run: npx tsx spec/screenTime.spec.ts
import assert from 'node:assert/strict';

import { ScreenTimeEngine, freshState } from '../src/screenTime.js';
import { checkScreenTime } from '../src/settings.js';
import { templateAnswer, templateNudge } from '../src/speech.js';
import { MINUTE } from '../src/time.js';
import { msk, runTests, test } from './helpers.js';

import type { ScreenTimeAction, ScreenTimeConfig } from '../src/screenTime.js';
import type { ScreenTimeValues } from '../src/settings.js';

const MOSCOW = 'Europe/Moscow';

function config(values: ScreenTimeValues = {}): ScreenTimeConfig {
  const checked = checkScreenTime({ childName: 'Артём', zone: 'desk', schoolFrom: '', schoolTo: '', freeFrom: '', freeTo: '', ...values }, ['desk']);
  assert.ok(checked.value, checked.errors.join('; '));
  return checked.value;
}

interface Run {
  engine: ScreenTimeEngine;
  t: number;
  actions: { at: number; action: ScreenTimeAction }[];
}

function start(c: ScreenTimeConfig, at: number): Run {
  return { engine: new ScreenTimeEngine(c, freshState('2000-01-01')), t: at, actions: [] };
}

/** Looks every 5 s for `ms`, with the child there or not. */
function pass(run: Run, ms: number, present: boolean, timeZone = MOSCOW): void {
  const end = run.t + ms;
  while (run.t < end) {
    run.t += 5_000;
    for (const action of run.engine.tick({ now: run.t, present, quiet: false, timeZone, language: 'ru' })) run.actions.push({ at: run.t, action });
  }
}

const speaks = (run: Run) => run.actions.filter((a) => a.action.type === 'speak');
const notifies = (run: Run) => run.actions.filter((a) => a.action.type === 'notify');

test('1. 45 minutes at the computer: soft phrase, after 3 min a firm one, after 3 more the parents; leaving resets', () => {
  const t0 = msk('2026-10-07T15:00:00');
  const run = start(config(), t0);
  pass(run, 44 * MINUTE, true);
  assert.equal(speaks(run).length, 0);
  pass(run, 2 * MINUTE, true);
  assert.equal(speaks(run).length, 1);
  const first = speaks(run)[0];
  assert.ok(first.at - t0 >= 45 * MINUTE && first.at - t0 <= 45 * MINUTE + 25_000, `first phrase at ${(first.at - t0) / 1000}s`);
  assert.equal(first.action.type === 'speak' && first.action.facts.level, 1);
  assert.equal(first.action.type === 'speak' && first.action.facts.reason, 'break');

  pass(run, 3 * MINUTE, true);
  assert.equal(speaks(run).length, 2);
  assert.equal(speaks(run)[1].action.type === 'speak' && speaks(run)[1].action.facts.level, 2);
  assert.equal(notifies(run).length, 0);

  pass(run, 3 * MINUTE, true);
  assert.equal(speaks(run).length, 3);
  assert.equal(notifies(run).length, 1, 'the parents are told at the third step');
  assert.equal(speaks(run)[2].action.type === 'speak' && speaks(run)[2].action.facts.level, 3);

  pass(run, 3 * MINUTE, false);
  assert.equal(run.engine.state.escalation, undefined, 'leaving resets the escalation');
  assert.equal(run.engine.state.present, false);
});

test('1b. after the notice the phrase repeats every repeatMinutes, at most maxRepeats times', () => {
  const run = start(config({ maxRepeats: 2 }), msk('2026-10-07T15:00:00'));
  pass(run, 60 * MINUTE, true);
  // 45: level 1, 48: level 2 + notify, 51: level 3, 54 and 57: repeats → 5, and no more
  assert.equal(speaks(run).length, 5);
  assert.equal(notifies(run).length, 1);
});

test('2. away 90 s with a gap of 120 s: the session goes on; away 11 min with a 10 min break: the break counts', () => {
  const run = start(config(), msk('2026-10-07T15:00:00'));
  pass(run, 10 * MINUTE, true);
  pass(run, 90_000, false);
  assert.equal(run.engine.state.present, true, 'a short absence does not end the session');
  pass(run, 20 * MINUTE, true);
  assert.ok(run.engine.state.workMs >= 31 * MINUTE, `work ${run.engine.state.workMs / MINUTE} min`);

  pass(run, 11 * MINUTE, false);
  assert.equal(run.engine.state.present, false);
  pass(run, 30_000, true);
  assert.equal(run.engine.state.present, true);
  assert.ok(run.engine.state.workMs < MINUTE, `a new session from zero, got ${run.engine.state.workMs / 1000}s`);
});

test('2b. a person passing by for 15 s starts no session', () => {
  const run = start(config(), msk('2026-10-07T15:00:00'));
  pass(run, 15_000, true);
  pass(run, MINUTE, false);
  assert.equal(run.engine.state.present, false);
  assert.equal(run.engine.state.todayMs, 0);
});

test('3. back 4 minutes into a 10 minute break: "осталось 6 минут"', () => {
  const run = start(config(), msk('2026-10-07T15:00:00'));
  pass(run, 46 * MINUTE, true);
  assert.equal(speaks(run).length, 1);
  pass(run, 4 * MINUTE, false);
  pass(run, 30_000, true);
  const back = speaks(run)[1];
  assert.ok(back && back.action.type === 'speak');
  assert.equal(back.action.kind, 'remaining');
  assert.equal(back.action.facts.breakMinutesLeft, 6);
  assert.match(templateNudge(back.action.facts, 'ru', back.action.kind), /осталось 6 минут/);
});

test('3b. with the reminder off the child back too early gets the usual break phrase', () => {
  const run = start(config({ breakReminder: false }), msk('2026-10-07T15:00:00'));
  pass(run, 46 * MINUTE, true);
  pass(run, 4 * MINUTE, false);
  pass(run, 30_000, true);
  const back = speaks(run)[1];
  assert.ok(back && back.action.type === 'speak');
  assert.equal(back.action.kind, 'nudge');
});

const bedtime: ScreenTimeValues = { schoolFrom: '21:30', schoolTo: '07:30', freeFrom: '22:30', freeTo: '08:30', sessionMinutes: 240 };

test('4. 21:30 on a school evening: phrase about sleep, "when can I play" → tomorrow at 07:30', () => {
  const run = start(config(bedtime), msk('2026-10-07T21:00:00')); // Wednesday
  pass(run, 29 * MINUTE, true);
  assert.equal(speaks(run).length, 0);
  pass(run, 2 * MINUTE, true);
  const phrase = speaks(run)[0];
  assert.ok(phrase && phrase.action.type === 'speak');
  assert.equal(phrase.action.facts.reason, 'bedtime');
  assert.ok(phrase.at >= msk('2026-10-07T21:30:00'));
  assert.equal(phrase.action.facts.nextAllowedAt, '07:30');
  assert.equal(phrase.action.facts.nextAllowedDay, 'tomorrow');
  assert.equal(templateAnswer(phrase.action.facts, 'ru'), 'Артём, играть можно будет завтра в 07:30.');
});

test('4b. Friday evening follows the weekend bedtime; the night runs over midnight', () => {
  const run = start(config(bedtime), msk('2026-10-09T21:00:00')); // Friday
  pass(run, 60 * MINUTE, true);
  assert.equal(speaks(run).length, 0, 'no bedtime at 21:30 on a Friday');
  pass(run, 31 * MINUTE, true);
  const phrase = speaks(run)[0];
  assert.ok(phrase && phrase.action.type === 'speak');
  assert.equal(phrase.action.facts.reason, 'bedtime');
  assert.ok(phrase.at >= msk('2026-10-09T22:30:00'));
  assert.equal(phrase.action.facts.nextAllowedAt, '08:30');

  const night = new ScreenTimeEngine(config(bedtime), freshState('2026-10-10'));
  assert.equal(night.reason(msk('2026-10-10T02:00:00'), MOSCOW), 'bedtime', 'Saturday 02:00 is still Friday night');
  assert.equal(night.reason(msk('2026-10-10T09:00:00'), MOSCOW), undefined);
  assert.equal(night.reason(msk('2026-10-08T00:30:00'), MOSCOW), 'bedtime', 'Thursday 00:30 belongs to Wednesday night');
  assert.equal(night.reason(msk('2026-10-08T07:30:00'), MOSCOW), undefined, 'the night ends at 07:30');
});

test('5. daylight saving: accounting loses and doubles no hour (Berlin, spring and autumn)', () => {
  const berlin = 'Europe/Berlin';
  const spring = start(config({ sessionMinutes: 240 }), Date.parse('2026-03-29T00:00:00Z')); // 01:00 CET
  pass(spring, 2 * 60 * MINUTE, true, berlin); // until 04:00 CEST: two real hours
  assert.equal(Math.round(spring.engine.state.todayMs / MINUTE), 120);
  assert.equal(Math.round(spring.engine.state.history['2026-03-29']), 120);

  const autumn = start(config({ sessionMinutes: 240 }), Date.parse('2026-10-24T23:00:00Z')); // 01:00 CEST
  pass(autumn, 3 * 60 * MINUTE, true, berlin); // 01:00 → 03:00 CET: three real hours, one wall-clock hour twice
  assert.equal(Math.round(autumn.engine.state.todayMs / MINUTE), 180);
});

test("6. a restart in the middle of a session: today's time and the escalation carry on", () => {
  const c = config({ sessionMinutes: 20 });
  const run = start(c, msk('2026-10-07T15:00:00'));
  pass(run, 21 * MINUTE, true);
  assert.equal(speaks(run).length, 1);
  const saved = JSON.parse(JSON.stringify(run.engine.state));

  // the plugin is down for 30 s
  const after: Run = { engine: new ScreenTimeEngine(c, saved), t: run.t + 30_000, actions: [] };
  pass(after, 3 * MINUTE, true);
  assert.equal(speaks(after).length, 1);
  assert.equal(speaks(after)[0].action.type === 'speak' && speaks(after)[0].action.facts.level, 2, 'the next step, not the soft phrase again');
  assert.ok(after.engine.state.todayMs >= 24 * MINUTE - 5_000, `today ${after.engine.state.todayMs / MINUTE} min`);
});

test('6b. downtime is not counted as time at the computer', () => {
  const c = config();
  const run = start(c, msk('2026-10-07T15:00:00'));
  pass(run, 10 * MINUTE, true);
  const saved = JSON.parse(JSON.stringify(run.engine.state));
  const after: Run = { engine: new ScreenTimeEngine(c, saved), t: run.t + 60 * MINUTE, actions: [] };
  pass(after, 5_000, true);
  assert.ok(after.engine.state.todayMs < 12 * MINUTE, `today ${after.engine.state.todayMs / MINUTE} min`);
});

test('daily limit: past it the reason is the limit and the child may play tomorrow', () => {
  const run = start(config({ dailyMinutes: 60, sessionMinutes: 240 }), msk('2026-10-07T15:00:00'));
  pass(run, 61 * MINUTE, true);
  const phrase = speaks(run)[0];
  assert.ok(phrase && phrase.action.type === 'speak');
  assert.equal(phrase.action.facts.reason, 'daily_limit');
  assert.equal(phrase.action.facts.nextAllowedDay, 'tomorrow');
  assert.equal(phrase.action.facts.nextAllowedAt, '00:00');
});

test('a parent gives 30 minutes: the limits wait, then come back', () => {
  const run = start(config(), msk('2026-10-07T15:00:00'));
  pass(run, 46 * MINUTE, true);
  assert.equal(speaks(run).length, 1);
  run.engine.extend(30, run.t);
  pass(run, 29 * MINUTE, true);
  assert.equal(speaks(run).length, 1);
  pass(run, 2 * MINUTE, true);
  assert.equal(speaks(run).length, 2);
});

test('quiet hours: no break phrase, but bedtime is still said', () => {
  const engine = new ScreenTimeEngine(config({ ...bedtime, sessionMinutes: 5 }), freshState('2026-10-07'));
  let t = msk('2026-10-07T15:00:00');
  const said: ScreenTimeAction[] = [];
  for (let i = 0; i < 12 * 10; i++) said.push(...engine.tick({ now: (t += 5_000), present: true, quiet: true, timeZone: MOSCOW, language: 'ru' }));
  assert.equal(said.length, 0);
  t = msk('2026-10-07T21:40:00');
  said.push(...engine.tick({ now: t, present: true, quiet: true, timeZone: MOSCOW, language: 'ru' }));
  assert.equal(said.length, 1);
  assert.equal(said[0].type === 'speak' && said[0].facts.reason, 'bedtime');
});

void runTests();
