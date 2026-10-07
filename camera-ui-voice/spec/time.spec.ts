// Local time of the server: wall-clock times around daylight saving, nights over midnight. Run: npx tsx spec/time.spec.ts
import assert from 'node:assert/strict';

import { activeInterval, dayOf, formatClock, instantOf, nextIntervalStart } from '../src/time.js';
import { runTests, test } from './helpers.js';

test('the day of the week of a date', () => {
  assert.equal(dayOf('2026-10-07'), 'wed');
  assert.equal(dayOf('2026-10-11'), 'sun');
  assert.equal(dayOf('2024-02-29'), 'thu');
});

test('a wall-clock time is the instant of that zone, on both sides of daylight saving', () => {
  assert.equal(instantOf('2026-10-07', '21:30', 'Europe/Moscow'), Date.parse('2026-10-07T18:30:00Z'));
  assert.equal(instantOf('2026-03-28', '21:30', 'Europe/Berlin'), Date.parse('2026-03-28T20:30:00Z'));
  assert.equal(instantOf('2026-03-29', '21:30', 'Europe/Berlin'), Date.parse('2026-03-29T19:30:00Z'));
  // 02:30 does not exist on the spring day: the first instant after the gap
  assert.equal(formatClock(instantOf('2026-03-29', '02:30', 'Europe/Berlin'), 'Europe/Berlin'), '03:00');
  // 02:30 happens twice in autumn: the first one (still summer time)
  assert.equal(instantOf('2026-10-25', '02:30', 'Europe/Berlin'), Date.parse('2026-10-25T00:30:00Z'));
});

test('a night from Sunday to Thursday evenings; the moment after midnight belongs to the evening before', () => {
  const rules = [{ days: ['sun', 'mon', 'tue', 'wed', 'thu'] as const, from: '21:30', to: '07:30' }].map((r) => ({ ...r, days: [...r.days] }));
  const zone = 'Europe/Moscow';
  assert.ok(activeInterval(rules, Date.parse('2026-10-07T21:45:00+03:00'), zone));
  assert.ok(activeInterval(rules, Date.parse('2026-10-08T06:00:00+03:00'), zone));
  assert.equal(activeInterval(rules, Date.parse('2026-10-09T22:00:00+03:00'), zone), undefined, 'Friday evening is free');
  assert.ok(activeInterval(rules, Date.parse('2026-10-09T06:00:00+03:00'), zone), 'Friday morning ends Thursday night');
  assert.equal(activeInterval(rules, Date.parse('2026-10-10T06:00:00+03:00'), zone), undefined, 'Saturday morning: no school night before');
  assert.equal(formatClock(nextIntervalStart(rules, Date.parse('2026-10-09T12:00:00+03:00'), zone)!, zone), '21:30');
});

test('a day interval (quiet hours 13:00-15:00) does not wrap', () => {
  const rules = [{ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as ('mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun')[], from: '13:00', to: '15:00' }];
  assert.ok(activeInterval(rules, Date.parse('2026-10-07T14:00:00+03:00'), 'Europe/Moscow'));
  assert.equal(activeInterval(rules, Date.parse('2026-10-07T16:00:00+03:00'), 'Europe/Moscow'), undefined);
});

void runTests();
