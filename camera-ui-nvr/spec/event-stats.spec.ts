// event_stats (src/assistant.ts): the events of a period in buckets of time — hours, days, weeks, the hours of a day,
// the days of a week — counted where they began or summed up in the minutes they lasted, apart by camera, label or a
// module's answer, as series with one value per bucket that show_chart draws as they are, named in the person's
// language. The days are the person's local days (Moscow here, the server on UTC; Berlin for a clock change); an hour
// still to come and the days a capped read did not reach have no value. attribute_time takes a month and gives the
// sums of each day over a week; the days its read did not reach are unknown, not days without play.
// Run: npx tsx spec/event-stats.spec.ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { callAssistantTool } from '../src/assistant.js';
import VionNvr from '../src/index.js';

import type { AssistantToolContext } from '@camera.ui/sdk';
import type { AssistantHost } from '../src/assistant.js';
import type { RecordedEvent } from '../src/types.js';

process.env.TZ = 'UTC';

const noop = () => undefined;
const logger = { log: noop, warn: noop, error: console.error, debug: noop, attention: noop, trace: noop };
const api = {
  storagePath: mkdtempSync(join(tmpdir(), 'nvr-event-stats-')),
  on: noop,
  once: noop,
  emit: noop,
  notificationManager: { publish: async () => undefined },
  coreManager: { assistantAccess: async () => ({ allowed: false }), getFFmpegPath: () => new Promise<string>(noop), getPluginsByInterface: async () => [] },
};
const storage = { values: {} as Record<string, unknown>, getValue: async () => undefined, setValue: async () => undefined };
const nvr = new VionNvr(logger as never, api as never, storage as never);
const cameras = (nvr as unknown as { cameras: Map<string, unknown> }).cameras;
cameras.set('cam-yard', { device: { id: 'cam-yard', name: 'Двор' }, recorders: new Map(), subscriptions: [] } as never);
cameras.set('cam-door', { device: { id: 'cam-door', name: 'Дверь' }, recorders: new Map(), subscriptions: [] } as never);

const at = (local: string) => Date.parse(`${local}+03:00`);
const ctx: AssistantToolContext = { userId: 'u1', role: 'admin', language: 'ru', timezone: 'Europe/Moscow' };
const Q = 'играет в компьютер';

let n = 0;
/** An event from `start` to `end` (local time) that saw `labels`; `answers` of the module, one segment each. */
function event(camera: string, start: string, end: string, labels: string[], answers: string[] = []): RecordedEvent {
  const from = at(start);
  const to = at(end);
  const segments = [
    { firstSeen: from, lastSeen: to, detections: labels.map((label) => ({ label, score: 0.9 })), attributes: [] as unknown[] },
    ...answers.map((a) => ({ firstSeen: from, lastSeen: to, detections: [], attributes: [{ type: Q, label: `${Q}: ${a}`, confidence: 0.9 }] })),
  ];
  return {
    id: `e${++n}`,
    cameraId: camera,
    state: 'ended',
    startTime: from,
    endTime: to,
    lastUpdate: to,
    types: ['motion', ...labels, ...(answers.length ? [Q] : [])],
    triggers: [],
    segmentIndex: 0,
    segments,
  } as unknown as RecordedEvent;
}

const events = [
  // Thursday 8 October
  event('cam-yard', '2026-10-08T09:10:00', '2026-10-08T09:12:00', ['person']),
  event('cam-yard', '2026-10-08T09:40:00', '2026-10-08T09:41:00', ['person', 'vehicle']),
  event('cam-door', '2026-10-08T18:05:00', '2026-10-08T18:06:00', ['person']),
  // over midnight into Friday: one event of Thursday, its minutes on both days
  event('cam-yard', '2026-10-08T23:50:00', '2026-10-09T00:20:00', ['vehicle']),
  // Friday 9 October: 10:50-11:20, ten minutes in the hour of ten, twenty in the hour of eleven
  event('cam-door', '2026-10-09T10:50:00', '2026-10-09T11:20:00', ['person']),
  // a motion with nothing seen
  event('cam-yard', '2026-10-09T13:00:00', '2026-10-09T13:01:00', []),
  // Saturday 10 October: the module's answers
  event('cam-door', '2026-10-10T15:00:00', '2026-10-10T15:30:00', ['person'], ['да', 'нет']),
  event('cam-door', '2026-10-10T16:00:00', '2026-10-10T16:10:00', ['person'], ['нет']),
  // Tuesday 6 October, at midnight sharp: Tuesday's, not Monday's
  event('cam-yard', '2026-10-06T00:00:00', '2026-10-06T00:01:00', ['person']),
  // before the period asked: never counted
  event('cam-yard', '2026-10-01T12:00:00', '2026-10-01T12:05:00', ['person']),
];
for (const ev of events) await nvr.ingestDetectionEvent(ev.cameraId, 'end' as never, ev as never);

type Stats = {
  labels: string[];
  keys?: string[];
  firstHour?: string;
  series: { name: string; values: (number | null)[]; total: number }[];
  total: number;
  bucket: string;
  from: string;
  daysPerBucket?: number[];
  labelNote?: string;
  note?: string;
  capped?: boolean;
};
const call = (input: Record<string, unknown>) => nvr.callAssistantTool('event_stats', input, ctx);
const stats = async (input: Record<string, unknown>) => {
  const result = await call(input);
  assert.equal(result.error, undefined, `unexpected error: ${result.error}`);
  return result.content as Stats;
};
const series = (s: Stats, name: string) => s.series.find((row) => row.name === name)?.values;

// ---- by day: counted on the day an event began, the local day of Moscow
{
  const s = await stats({ date: '2026-10-10', days: 3 });
  assert.equal(s.bucket, 'day');
  assert.deepEqual(s.keys, ['2026-10-08', '2026-10-09', '2026-10-10']);
  assert.equal(s.labels.length, 3);
  assert.match(s.labels[0], /^8 окт/);
  assert.deepEqual(series(s, 'события'), [4, 2, 2], 'the event over midnight is Thursday\'s');
  assert.equal(s.total, 8, 'the event of 1 October is outside the period');
}

// ---- apart by camera, by label (an event with two labels in both), by the module's answer
{
  const byCamera = await stats({ date: '2026-10-10', days: 3, group_by: 'camera' });
  assert.deepEqual(series(byCamera, 'Двор'), [3, 1, 0]);
  assert.deepEqual(series(byCamera, 'Дверь'), [1, 1, 2]);
  const byLabel = await stats({ date: '2026-10-10', days: 3, group_by: 'label' });
  assert.deepEqual(series(byLabel, 'человек'), [3, 1, 2], 'named in the person\'s language');
  assert.deepEqual(series(byLabel, 'транспорт'), [2, 0, 0]);
  assert.deepEqual(series(byLabel, 'без объекта'), [0, 1, 0], 'a motion with nothing seen is counted, not lost');
  assert.match(byLabel.labelNote ?? '', /counts in each/);
  // with labels asked, only those: the car beside the person of 09:40 is not a car asked for
  const people = await stats({ date: '2026-10-10', days: 3, group_by: 'label', labels: ['person'] });
  assert.deepEqual(people.series.map((row) => row.name), ['человек']);
  const byAnswer = await stats({ date: '2026-10-10', days: 3, group_by: 'answer', attribute: 'играет' });
  assert.deepEqual(series(byAnswer, 'да'), [0, 0, 1], 'yes when the module said yes at least once');
  assert.deepEqual(series(byAnswer, 'нет'), [0, 0, 1], 'no when it said only no');
  const onlyYes = await stats({ date: '2026-10-10', days: 3, attribute: 'играет' });
  assert.equal(onlyYes.total, 1);
  // as query_events: an event where it said no at least once, also one where it said yes too
  const saidNo = await stats({ date: '2026-10-10', days: 3, attribute: 'играет', answer: 'no' });
  assert.equal(saidNo.total, 2);
}

// ---- filtered by label and camera
{
  const vehicles = await stats({ date: '2026-10-10', days: 3, labels: ['vehicle'] });
  assert.equal(vehicles.total, 2);
  const door = await stats({ date: '2026-10-10', days: 3, camera: 'Дверь' });
  assert.equal(door.total, 4);
}

// ---- by hour, and the minutes cut at the hours and at midnight
{
  const hours = await stats({ date: '2026-10-09', days: 1 });
  assert.equal(hours.bucket, 'hour', 'one day is drawn by hour');
  assert.equal(hours.labels.length, 24);
  assert.equal(hours.labels[10], '10:00');
  assert.equal(hours.keys, undefined, 'no 24 ISO times the chart does not need');
  assert.equal(hours.firstHour, new Date(at('2026-10-09T00:00:00')).toISOString());
  assert.equal(series(hours, 'события')![10], 1);
  assert.equal(series(hours, 'события')![13], 1);
  assert.equal(series(hours, 'события')![0], 0, 'the event over midnight began on Thursday');
  const minutes = await stats({ date: '2026-10-09', days: 1, measure: 'minutes' });
  const m = series(minutes, 'минуты')!;
  assert.equal(m[0], 20, 'the part after midnight is Friday\'s');
  assert.equal(m[10], 10);
  assert.equal(m[11], 20);
  assert.equal(m[13], 1);
  const thursday = await stats({ date: '2026-10-08', days: 1, measure: 'minutes' });
  assert.equal(series(thursday, 'минуты')![23], 10, 'and the part before it Thursday\'s');
}

// ---- the profile of a day and of a week, added up over the period
{
  const profile = await stats({ date: '2026-10-10', days: 3, bucket: 'hour_of_day' });
  assert.equal(profile.labels.length, 24);
  assert.equal(series(profile, 'события')![9], 2);
  assert.equal(series(profile, 'события')![15], 1);
  const week = await stats({ date: '2026-10-10', days: 7, bucket: 'weekday' });
  assert.deepEqual(week.keys, ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
  assert.match(week.labels[0], /пн/i);
  assert.deepEqual(week.daysPerBucket, [1, 1, 1, 1, 1, 1, 1]);
  assert.deepEqual(series(week, 'события'), [0, 1, 0, 4, 2, 2, 0]);
}

// ---- an event at midnight sharp is of the day it begins
{
  const s = await stats({ date: '2026-10-06', days: 2 });
  assert.deepEqual(series(s, 'события'), [0, 1]);
}

// ---- by week, a week beginning on Monday and cut by the period
{
  const weeks = await stats({ date: '2026-10-10', days: 14, bucket: 'week' });
  assert.deepEqual(weeks.keys, ['2026-09-27', '2026-09-28', '2026-10-05']);
  assert.deepEqual(series(weeks, 'события'), [0, 1, 9]);
  assert.match(weeks.labels[2], /5 окт.* – 11 окт|5 окт.* – 10 окт/);
}

// ---- what a chart cannot read, and what makes no sense, is said
{
  assert.match((await call({ date: '2026-10-10', days: 17, bucket: 'hour' })).error ?? '', /at most 16 days by hour/);
  assert.match((await call({ date: '2026-10-10', days: 3, group_by: 'answer' })).error ?? '', /needs `attribute`/);
  assert.match((await call({ date: '2026-10-10', labels: ['dragon'] })).error ?? '', /Unknown label "dragon"/);
  assert.match((await call({ date: '2099-01-01' })).error ?? '', /has not come yet/);
}

// ---- an hour still to come has no value; more than seven groups end in «other»
{
  const realNow = Date.now;
  Date.now = () => at('2026-10-10T15:30:00');
  try {
    const today = await stats({ date: '2026-10-10', days: 1 });
    const values = series(today, 'события')!;
    assert.equal(values[15], 1, 'the hour going on has its value');
    assert.equal(values[16], null, 'the hour to come has none');
    assert.equal(values[23], null);
  } finally {
    Date.now = realNow;
  }
  for (let i = 0; i < 9; i++) cameras.set(`cam-${i}`, { device: { id: `cam-${i}`, name: `Камера ${i}` }, recorders: new Map(), subscriptions: [] } as never);
  for (let i = 0; i < 9; i++) await nvr.ingestDetectionEvent(`cam-${i}`, 'end' as never, event(`cam-${i}`, '2026-10-07T12:00:00', '2026-10-07T12:01:00', ['person']) as never);
  const many = await stats({ date: '2026-10-07', days: 1, bucket: 'day', group_by: 'camera' });
  assert.equal(many.series.length, 8);
  assert.equal(many.series.at(-1)!.name, 'прочее');
  assert.equal(many.series.at(-1)!.total, 2);
  assert.equal(many.total, 9);
}

// ---- attribute_time takes a month, and gives each day's sums over a week
{
  const month = await nvr.callAssistantTool('attribute_time', { attribute: 'играет', date: '2026-10-10', days: 31 }, ctx);
  assert.equal(month.error, undefined);
  const days = (month.content as { days: { date: string; minutes: number; stretches: unknown; pauses: { list?: unknown } }[] }).days;
  assert.equal(days.length, 31);
  assert.equal(days.at(-1)!.date, '2026-10-10');
  assert.equal(typeof days.at(-1)!.stretches, 'number', 'a count, not the list');
  assert.equal((month.content as { capped?: boolean }).capped, undefined);
  assert.equal(days.at(-1)!.pauses.list, undefined);
  const week = await nvr.callAssistantTool('attribute_time', { attribute: 'играет', date: '2026-10-10', days: 7 }, ctx);
  const weekDays = (week.content as { days: { stretches: unknown; pauses: { list?: unknown } }[] }).days;
  assert.ok(Array.isArray(weekDays.at(-1)!.stretches), 'a week keeps the stretches one by one');
  assert.ok(Array.isArray(weekDays.at(-1)!.pauses.list));
}

// ---- a host of its own: the read capped, a clock change, a zone across the date line, the mean of a weekday
const camerasOf = [{ id: 'cam-a', name: 'Камера А' }];
/** A host whose scan reads `list` newest first, stopping after `max` events (capped) as the store's rows would. */
function host(list: RecordedEvent[], max = Infinity): AssistantHost {
  return {
    cameras: () => camerasOf,
    eventTypes: (_ids, _from, _to, attributes) => new Map(attributes ? [[Q, 1]] : [['person', 1]]),
    scan: async (_ids, opts, visit) => {
      const inRange = list
        .filter((ev) => (ev.endTime ?? ev.startTime) >= (opts.startMs ?? -Infinity) && ev.startTime <= (opts.endMs ?? Infinity))
        .filter((ev) => opts.startedSinceMs === undefined || ev.startTime >= opts.startedSinceMs)
        .sort((a, b) => b.startTime - a.startTime);
      const read = inRange.slice(0, max);
      read.forEach(visit);
      return { scanned: read.length, capped: inRange.length > max, oldestMs: read.at(-1)?.startTime };
    },
  } as unknown as AssistantHost;
}
const daily = (zone: string, first: string, days: number, clock = '12:00:00') =>
  Array.from({ length: days }, (_, i) => {
    const date = new Date(Date.parse(`${first}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
    const start = zone === 'UTC' ? Date.parse(`${date}T${clock}Z`) : at(`${date}T${clock}`);
    return { ...event('cam-a', `${date}T${clock}`, `${date}T${clock}`, ['person']), startTime: start, endTime: start + 60_000 };
  });
const call2 = async (h: AssistantHost, input: Record<string, unknown>, c: AssistantToolContext = ctx) => {
  const result = await callAssistantTool(h, 'event_stats', input, c);
  assert.equal(result.error, undefined, `unexpected error: ${result.error}`);
  return result.content as Stats;
};

{
  // ten days, one event a day: Thursday to Saturday came twice, the mean says one a day all the same
  const ten = host(daily('MSK', '2026-10-01', 10));
  const sums = await call2(ten, { date: '2026-10-10', days: 10, bucket: 'weekday' });
  assert.deepEqual(series(sums, 'события'), [1, 1, 1, 2, 2, 2, 1]);
  assert.deepEqual(sums.daysPerBucket, [1, 1, 1, 2, 2, 2, 1], 'how many of each weekday the sums hold');
  const mean = await call2(ten, { date: '2026-10-10', days: 10, bucket: 'weekday', average: true });
  assert.deepEqual(series(mean, 'события'), [1, 1, 1, 1, 1, 1, 1]);
  const hourly = await call2(ten, { date: '2026-10-10', days: 10, bucket: 'hour_of_day', average: true });
  assert.equal(series(hourly, 'события')![12], 1);
  assert.equal(hourly.daysPerBucket![12], 10);
  assert.match((await callAssistantTool(ten, 'event_stats', { date: '2026-10-10', days: 3, average: true }, ctx)).error ?? '', /average is for hour_of_day and weekday/);
}

{
  // the read stopped at the newest 4 events of 10 days: the days it did not reach have no value, never a zero
  const capped = await call2(host(daily('MSK', '2026-10-01', 10), 4), { date: '2026-10-10', days: 10 });
  assert.equal(capped.capped, true);
  const values = series(capped, 'события')!;
  assert.deepEqual(values.slice(-3), [1, 1, 1], 'the days read in full');
  assert.ok(values.slice(0, 7).every((v) => v === null), `the days not read are unknown: ${JSON.stringify(values)}`);
  assert.equal(capped.from, '2026-10-08', 'it says from which day it read');
  const profile = await call2(host(daily('MSK', '2026-10-01', 10), 4), { date: '2026-10-10', days: 10, bucket: 'weekday' });
  assert.deepEqual(profile.daysPerBucket, [0, 0, 0, 1, 1, 1, 0], 'a profile holds only the days read');
  // stopped inside the last day: no day was read in full, and the hint does not claim the whole period
  const busy = [...daily('MSK', '2026-10-01', 10), ...daily('MSK', '2026-10-10', 1, '13:00:00')];
  const lastDay = await call2(host(busy, 1), { date: '2026-10-10', days: 10 });
  assert.ok(series(lastDay, 'события')!.every((v) => v === null), JSON.stringify(series(lastDay, 'события')));
  assert.match((lastDay as { hint?: string }).hint ?? '', /from 2026-10-10/, (lastDay as { hint?: string }).hint);
}

{
  // Berlin goes from 2:00 to 3:00 on 29 March 2026: an event at 10:00 is in the hour of ten, the day has 23 hours
  const berlin: AssistantToolContext = { ...ctx, timezone: 'Europe/Berlin' };
  const start = Date.parse('2026-03-29T10:00:00+02:00');
  const ev = { ...event('cam-a', '2026-03-29T10:00:00', '2026-03-29T10:01:00', ['person']), startTime: start, endTime: start + 60_000 };
  const profile = await call2(host([ev]), { date: '2026-03-29', days: 1, bucket: 'hour_of_day' }, berlin);
  assert.equal(series(profile, 'события')![10], 1, 'the hour of the clock, not the hours since midnight');
  const hours = await call2(host([ev]), { date: '2026-03-29', days: 1 }, berlin);
  assert.equal(hours.labels.length, 23);
  assert.equal(hours.labels[2], '03:00', 'two o\'clock never came');
  assert.equal(series(hours, 'события')![hours.labels.indexOf('10:00')], 1);
}

{
  // Auckland is UTC+13 in October: Monday is called Monday
  const auckland: AssistantToolContext = { ...ctx, timezone: 'Pacific/Auckland', language: 'en' };
  const week = await call2(host([]), { date: '2026-10-10', days: 7, bucket: 'weekday' }, auckland);
  assert.equal(week.labels[0], 'Mon');
  assert.equal(week.labels[6], 'Sun');
}

{
  // an event still going on lasts until its last update; a camera gone is named so, not by its id
  const startedAt = at('2026-10-09T10:00:00');
  const going = { ...event('cam-gone-1234567', '2026-10-09T10:00:00', '2026-10-09T10:00:00', ['person']), endTime: undefined, lastUpdate: startedAt + 30 * 60_000 };
  const minutes = await call2(host([going as unknown as RecordedEvent]), { date: '2026-10-09', days: 1, measure: 'minutes', group_by: 'camera' });
  assert.equal(minutes.series[0].name, 'удалённая камера cam-gone');
  assert.equal(minutes.series[0].values[10], 30);
  assert.match(minutes.note ?? '', /add up/);
}

{
  // the real store over more than one page of 2000 rows
  const busy = Array.from({ length: 2100 }, (_, i) => {
    const t = at('2026-09-20T08:00:00') + i * 10_000;
    return { ...event('cam-door', '2026-09-20T08:00:00', '2026-09-20T08:00:01', ['person']), id: `busy-${i}`, startTime: t, endTime: t + 1000, lastUpdate: t + 1000 };
  });
  for (const ev of busy) await nvr.ingestDetectionEvent(ev.cameraId, 'end' as never, ev as never);
  const all = await stats({ date: '2026-09-20', days: 1, bucket: 'day', camera: 'Дверь' });
  assert.equal(all.total, 2100, 'every row of both pages');
}

{
  // attribute_time: a read that stopped marks the days it did not reach unknown
  const looks = daily('MSK', '2026-10-01', 10, '20:00:00').map((ev) => ({
    ...ev,
    segments: [{ firstSeen: ev.startTime, lastSeen: ev.startTime + 30 * 60_000, detections: [], attributes: [{ type: Q, label: `${Q}: да`, confidence: 0.9 }] }],
  }));
  const result = await callAssistantTool(host(looks as unknown as RecordedEvent[], 4), 'attribute_time', { attribute: 'играет', date: '2026-10-10', days: 10 }, ctx);
  const content = result.content as { capped?: boolean; days: { date: string; minutes: number | null; unknown?: boolean }[] };
  assert.equal(content.capped, true);
  assert.deepEqual(content.days.slice(-3).map((day) => day.minutes), [30, 30, 30]);
  assert.ok(content.days.slice(0, 7).every((day) => day.unknown === true && day.minutes === null), JSON.stringify(content.days.slice(0, 7)));
}

console.log('event-stats.spec: events by hour, day, week, hour of day and weekday, counted and in minutes, apart and filtered OK');
process.exit(0);
