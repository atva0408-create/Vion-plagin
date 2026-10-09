// Screen time: sessions, breaks, bedtime, escalation, daylight saving and a restart. Run: npx tsx spec/screenTime.spec.ts
import assert from 'node:assert/strict';

import { ScreenTimeEngine, freshState } from '../src/screenTime.js';
import { checkScreenTime } from '../src/settings.js';
import { replyText, templateNudge } from '../src/speech.js';
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
function pass(run: Run, ms: number, present: boolean | undefined, timeZone = MOSCOW): void {
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
  // the 90 s away keep the session but are not time at the computer (only their first 15 s, a look the detector may
  // have missed): they were counted and never taken back
  const work = run.engine.state.workMs / MINUTE;
  assert.ok(work > 29.5 && work <= 30.3, `work ${work} min`);
  assert.ok(run.engine.state.todayMs / MINUTE <= 30.3, 'nor time of the day');

  pass(run, 11 * MINUTE, false);
  assert.equal(run.engine.state.present, false);
  pass(run, 30_000, true);
  assert.equal(run.engine.state.present, true);
  assert.ok(run.engine.state.workMs < MINUTE, `a new session from zero, got ${run.engine.state.workMs / 1000}s`);
});

test('2c. a camera blind for less than a break (offline, its detector gone) stops the clock: no time counted, no session ended, no reminder', () => {
  const run = start(config(), msk('2026-10-07T15:00:00'));
  pass(run, 30 * MINUTE, true);
  const before = run.engine.state.workMs;
  // 8 minutes the camera's Wi-Fi was down: the last boxes of a still child stayed in the sensor
  pass(run, 8 * MINUTE, undefined);
  assert.equal(run.engine.state.workMs, before, 'no time at the computer while blind');
  assert.equal(speaks(run).length, 0, 'no reminder runs on time alone');
  pass(run, 16 * MINUTE, true);
  assert.equal(speaks(run).length, 1, 'back in sight, the session goes on: the reminder comes at 45 minutes of real time at the computer');
  const work = run.engine.state.workMs / MINUTE;
  assert.ok(work > 45.5 && work <= 46, `work ${work} min`);
});

test('2h. blind as long as a break or longer: the session ended where sight was lost, back in sight a new one starts', () => {
  const run = start(config(), msk('2026-10-07T15:00:00'));
  pass(run, 30 * MINUTE, true);
  pass(run, 2 * 60 * MINUTE, undefined);
  assert.ok(run.engine.state.workMs <= 30 * MINUTE + 5_000, 'no time at the computer while blind');
  assert.equal(notifies(run).length, 0);
  pass(run, 16 * MINUTE, true);
  assert.equal(speaks(run).length, 0, 'a new session: 16 minutes, no reminder');
  assert.ok(run.engine.state.workMs < 16 * MINUTE, `work ${run.engine.state.workMs / MINUTE} min`);
});

test('2i. a camera off for the night: in the morning no "the break is not over" and no notice to the parents with yesterday\'s minutes', () => {
  // the break begun in the evening: reminder at 20:45, the child left at 20:46, the camera off from 20:49 to 07:49
  const run = start(config(), msk('2026-10-07T20:00:00'));
  pass(run, 46 * MINUTE, true);
  pass(run, 3 * MINUTE, false);
  pass(run, 11 * 60 * MINUTE, undefined);
  pass(run, 2 * MINUTE, true);
  assert.equal(speaks(run).length, 1, 'only the evening reminder: the break counts as taken');
  assert.ok(run.engine.state.workMs < 3 * MINUTE, `a new session, got ${run.engine.state.workMs / MINUTE} min`);

  // the reminders under way when the camera went off: 20:45 level 1, 20:48 level 2
  const late = start(config(), msk('2026-10-07T20:00:00'));
  pass(late, 49 * MINUTE, true);
  assert.equal(speaks(late).length, 2);
  pass(late, 11 * 60 * MINUTE, undefined);
  pass(late, 5 * MINUTE, true);
  assert.equal(speaks(late).length, 2, 'no level 3 in the morning');
  assert.equal(notifies(late).length, 0, 'the parents are not told about yesterday');
});

test('2d. blind for a while during a break: the break does not pass meanwhile either', () => {
  const run = start(config(), msk('2026-10-07T15:00:00'));
  pass(run, 46 * MINUTE, true);
  pass(run, 3 * MINUTE, false);
  pass(run, 8 * MINUTE, undefined);
  pass(run, 30_000, true);
  assert.ok(run.engine.state.workMs >= 46 * MINUTE, 'the child was away 3 minutes of a 10 minute break, not 11');
});

test('2e. blind in a session, then the child is gone: the gap and the break count from when the camera sees again', () => {
  const run = start(config(), msk('2026-10-07T15:00:00'));
  pass(run, 20 * MINUTE, true);
  pass(run, 8 * MINUTE, undefined);
  pass(run, MINUTE, false);
  assert.equal(run.engine.state.present, true, 'away 1 minute of a 2 minute gap: the session goes on');
  pass(run, 2 * MINUTE, false);
  assert.equal(run.engine.state.present, false);
  pass(run, 5 * MINUTE, false);
  pass(run, 30_000, true);
  const work = run.engine.state.workMs / MINUTE;
  assert.ok(work >= 19.5, `back 7 minutes into a 10 minute break: the session goes on, got ${work} min`);
});

test('2f. blind in the middle of the reminders: the next one comes 3 minutes in sight after the last, not at once', () => {
  const run = start(config(), msk('2026-10-07T15:00:00'));
  pass(run, 46 * MINUTE, true);
  assert.equal(speaks(run).length, 1);
  pass(run, 6 * MINUTE, undefined);
  pass(run, MINUTE, true);
  assert.equal(speaks(run).length, 1, 'a minute after sight came back: not yet');
  pass(run, 2.5 * MINUTE, true);
  assert.equal(speaks(run).length, 2);
});

test('2g. what the attribute said about the person ends with the session: after a restart the next person is not taken for the child', () => {
  const run = start(config(), msk('2026-10-07T15:00:00'));
  for (let i = 0; i < 12; i++) {
    run.t += 5_000;
    run.engine.tick({ now: run.t, present: true, attributeYes: true, quiet: false, timeZone: MOSCOW, language: 'ru' });
  }
  assert.equal(run.engine.state.attributeYes, true);
  pass(run, 3 * MINUTE, false);
  assert.equal(run.engine.state.present, false);
  assert.equal(run.engine.state.attributeYes, undefined);
});

test('2k. bedtime reminders under way, then blind longer than a break: back in sight they start over, the parents are not told at once', () => {
  const run = start(config(bedtime), msk('2026-10-07T21:20:00'));
  pass(run, 15 * MINUTE, true);
  // 21:30 level 1, 21:33 level 2
  assert.equal(speaks(run).length, 2);
  pass(run, 30 * MINUTE, undefined);
  pass(run, 2 * MINUTE, true);
  const after = speaks(run).slice(2);
  assert.equal(after.length, 1, 'one phrase when the child is seen again');
  assert.equal(after[0].action.type === 'speak' && after[0].action.facts.level, 1);
  assert.equal(notifies(run).length, 0);
});

test('2j. a look the detector missed now and then is still time at the computer', () => {
  const run = start(config(), msk('2026-10-07T15:00:00'));
  // every sixth look (one in 30 s) without the child
  for (let i = 0; i < 360; i++) pass(run, 5_000, i % 6 !== 5);
  const work = run.engine.state.workMs / MINUTE;
  assert.ok(work > 29.5, `30 minutes at the computer, counted ${work}`);
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
  assert.equal(replyText(run.engine.standing(run.t, MOSCOW), 'Артём', 'ru'), 'Артём, играть можно будет завтра в 07:30.');
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

test('the daily limit reached at 15:11: playing again tomorrow at 00:00 local, not at midnight UTC (03:00 in Moscow)', () => {
  const moscow = start(config({ dailyMinutes: 10 }), msk('2026-10-07T15:00:00'));
  pass(moscow, 11 * MINUTE, true);
  const phrase = speaks(moscow)[0];
  assert.ok(phrase && phrase.action.type === 'speak');
  assert.equal(phrase.action.facts.reason, 'daily_limit');
  assert.equal(phrase.action.facts.nextAllowedAt, '00:00');
  assert.equal(phrase.action.facts.nextAllowedDay, 'tomorrow');
  assert.equal(replyText(moscow.engine.standing(moscow.t, MOSCOW), 'Артём', 'ru'), 'Артём, играть можно будет завтра в 00:00.');

  // half an hour off UTC: no whole hour from 15:11 is midnight
  const kolkata = start(config({ dailyMinutes: 10 }), Date.parse('2026-10-07T15:00:00+05:30'));
  pass(kolkata, 11 * MINUTE, true, 'Asia/Kolkata');
  const there = kolkata.engine.facts(kolkata.t, { timeZone: 'Asia/Kolkata', language: 'ru' });
  assert.equal(there.reason, 'daily_limit');
  assert.equal(there.nextAllowedAt, '00:00');
});

const answer = (run: Run) => replyText(run.engine.standing(run.t, MOSCOW), 'Артём', 'ru');

test('"how long": minutes of play before the break, of the break once away, the whole break at the computer', () => {
  const run = start(config(), msk('2026-10-07T15:00:00'));
  pass(run, 20 * MINUTE, true);
  assert.equal(answer(run), 'Артём, можно играть. До перерыва 25 минут.');
  pass(run, 26 * MINUTE, true);
  assert.equal(run.engine.reason(run.t, MOSCOW), 'break');
  assert.equal(answer(run), 'Артём, сейчас перерыв: 10 минут без компьютера, потом можно играть.');
  pass(run, 3 * MINUTE, false);
  const left = (run.engine.state.leftAt ?? 0) + 10 * MINUTE - run.t;
  assert.ok(left > 6 * MINUTE && left < 8 * MINUTE, `${left / 1000} s left`);
  assert.equal(answer(run), `Артём, до конца перерыва ${Math.ceil(left / MINUTE)} минут.`);
  pass(run, left - 5_000, false);
  assert.equal(answer(run), 'Артём, до конца перерыва 1 минута.', 'the last seconds still count as a minute, never "0 minutes"');
  pass(run, 5_000, false);
  assert.equal(answer(run), 'Артём, можно играть. До перерыва 45 минут.', 'the break is over: a whole session ahead');
});

test('"how long": back during the break, the answer names the minutes the reminder named', () => {
  const run = start(config(), msk('2026-10-07T15:00:00'));
  pass(run, 46 * MINUTE, true);
  pass(run, 5 * MINUTE, false);
  pass(run, 30_000, true);
  const reminder = speaks(run).find((a) => a.action.type === 'speak' && a.action.kind === 'remaining');
  assert.ok(reminder && reminder.action.type === 'speak', 'the reminder of the rest of the break');
  const left = reminder.action.facts.breakMinutesLeft;
  assert.ok(left !== undefined && left > 0);
  assert.equal(left, 5, '10 minutes of break, 5 of them (and the seconds before a look) taken before coming back');
  assert.equal(answer(run), 'Артём, сейчас перерыв: 5 минут без компьютера, потом можно играть.');
});

test('a break is added up over the absences: back early and away again, the child takes only the rest of it', () => {
  const run = start(config(), msk('2026-10-07T15:00:00'));
  pass(run, 46 * MINUTE, true);
  pass(run, 4 * MINUTE, false);
  pass(run, MINUTE, true);
  assert.equal(speaks(run).filter((a) => a.action.type === 'speak' && a.action.kind === 'remaining').length, 1);
  assert.equal(run.engine.state.workMs >= 45 * MINUTE, true, 'back early: the break is still due');
  const said = speaks(run).length;
  // away again a little longer than what was left: the break is taken, the session starts over
  pass(run, 6 * MINUTE + 5_000, false);
  assert.equal(answer(run), 'Артём, можно играть. До перерыва 45 минут.', 'the rest taken while away');
  pass(run, MINUTE, true);
  assert.equal(speaks(run).length, said, 'no reminder: the break was taken in two parts');
  assert.ok(run.engine.state.workMs < 2 * MINUTE, `${run.engine.state.workMs / 1000} s since the break`);
  assert.equal(run.engine.state.restMs, undefined);
});

test('the next break after a whole one: its first reminder names no "left", nothing of it is taken yet', () => {
  const run = start(config(), msk('2026-10-07T15:00:00'));
  pass(run, 46 * MINUTE, true);
  pass(run, 11 * MINUTE, false);
  pass(run, 46 * MINUTE, true);
  const nudge = speaks(run)[speaks(run).length - 1].action;
  assert.ok(nudge.type === 'speak' && nudge.kind === 'nudge' && nudge.facts.reason === 'break');
  assert.equal(nudge.facts.breakMinutesLeft, undefined);
});

test('a break a parent let go takes its taken part with it: the next break is a whole one', () => {
  const run = start(config(), msk('2026-10-07T15:00:00'));
  pass(run, 46 * MINUTE, true);
  pass(run, 4 * MINUTE, false);
  pass(run, MINUTE, true);
  run.engine.skipBreak();
  pass(run, 46 * MINUTE, true);
  const said = speaks(run).length;
  pass(run, 7 * MINUTE, false);
  pass(run, MINUTE, true);
  assert.equal(speaks(run).length, said + 1, '7 minutes away are not the 4 of the let-go break plus 7');
});

test('a break added up: away again too short, the reminder names what is still left', () => {
  const run = start(config(), msk('2026-10-07T15:00:00'));
  pass(run, 46 * MINUTE, true);
  pass(run, 4 * MINUTE, false);
  pass(run, MINUTE, true);
  pass(run, 3 * MINUTE, false);
  pass(run, MINUTE, true);
  const reminders = speaks(run).filter((a) => a.action.type === 'speak' && a.action.kind === 'remaining');
  assert.equal(reminders.length, 2);
  const last = reminders[1].action;
  assert.ok(last.type === 'speak');
  assert.equal(last.facts.breakMinutesLeft, 3, '10 minutes less 4 and 3 away (and the seconds before a look)');
});

test('"how long": less than a minute is said so, never "1 minute"; time from a parent is rounded down', () => {
  const run = start(config(), msk('2026-10-07T15:00:00'));
  pass(run, 44 * MINUTE + 30_000, true);
  assert.equal(answer(run), 'Артём, можно играть. До перерыва меньше минуты.');
  run.engine.extend(10, run.t - 50_000);
  assert.equal(answer(run), 'Артём, можно играть, родители дали время. До его конца 9 минут.', '9 minutes 10 s left');
  assert.equal(replyText({ kind: 'play', minutes: 0, until: 'bedtime' }, 'Artem', 'en'), 'Artem, you can play: less than a minute until bedtime.');
});

test('"how long": the limit that comes first is named; play is rounded down, never promising more', () => {
  const daily = start(config({ dailyMinutes: 30 }), msk('2026-10-07T15:00:00'));
  pass(daily, 20 * MINUTE, true);
  assert.equal(answer(daily), 'Артём, можно играть. До конца времени на сегодня 10 минут.');
  pass(daily, 30_000, true);
  assert.equal(answer(daily), 'Артём, можно играть. До конца времени на сегодня 9 минут.', '9.5 minutes left are 9');

  const evening = start(config(bedtime), msk('2026-10-07T21:10:00'));
  pass(evening, MINUTE, true);
  assert.equal(answer(evening), 'Артём, можно играть. До времени сна 19 минут.');
  pass(evening, 20 * MINUTE, true);
  assert.equal(answer(evening), 'Артём, играть можно будет завтра в 07:30.', 'a time for the morning, not 600 minutes');
});

test('"how long": time given by a parent is counted down in minutes', () => {
  const run = start(config(), msk('2026-10-07T15:00:00'));
  pass(run, 50 * MINUTE, true);
  run.engine.extend(15, run.t);
  pass(run, 5 * MINUTE, true);
  assert.equal(answer(run), 'Артём, можно играть, родители дали время. До его конца 10 минут.');
});

test('"how long": the word for minutes agrees with the number', () => {
  const said = (minutes: number) => replyText({ kind: 'break', minutes }, 'Артём', 'ru');
  assert.equal(said(1), 'Артём, до конца перерыва 1 минута.');
  assert.equal(said(2), 'Артём, до конца перерыва 2 минуты.');
  assert.equal(said(5), 'Артём, до конца перерыва 5 минут.');
  assert.equal(said(11), 'Артём, до конца перерыва 11 минут.');
  assert.equal(said(21), 'Артём, до конца перерыва 21 минута.');
  assert.equal(said(22), 'Артём, до конца перерыва 22 минуты.');
  assert.equal(replyText({ kind: 'break', minutes: 1 }, 'Artem', 'en'), 'Artem, 1 minute of the break left.');
  assert.equal(replyText({ kind: 'play', minutes: 3, until: 'bedtime' }, 'Artem', 'de'), 'Artem, du kannst spielen. Noch 3 Minuten bis zur Schlafenszeit.');
});

void runTests();
