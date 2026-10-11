// The questions of modules in the assistant's tools (src/assistant.ts): a module that answers "играет в компьютер: да/нет"
// is told apart from faces and plates, counted in a day's summary, found by query_events with its answer, and
// attribute_time adds up the stretches of "yes" with the pauses between them, joined within an event or 10 minutes,
// a lone "no" not breaking them (the module answers only on the frames the detector looks at).
// Run: npx tsx spec/attributes.spec.ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { answerOf, answersOf } from '../src/assistant.js';
import VionNvr from '../src/index.js';

import type { AssistantToolContext } from '@camera.ui/sdk';
import type { RecordedEvent } from '../src/types.js';

const noop = () => undefined;
const logger = { log: noop, warn: noop, error: console.error, debug: noop, attention: noop, trace: noop };
const api = {
  storagePath: mkdtempSync(join(tmpdir(), 'nvr-attributes-')),
  on: noop,
  once: noop,
  emit: noop,
  notificationManager: { publish: async () => undefined },
  coreManager: { assistantAccess: async () => ({ allowed: false }), getFFmpegPath: () => new Promise<string>(noop), getPluginsByInterface: async () => [] },
};
const storage = { values: {} as Record<string, unknown>, getValue: async () => undefined, setValue: async () => undefined };
const nvr = new VionNvr(logger as never, api as never, storage as never);
const cameras = (nvr as unknown as { cameras: Map<string, unknown> }).cameras;
cameras.set('cam-kid', { device: { id: 'cam-kid', name: 'Детская' }, recorders: new Map(), subscriptions: [] } as never);
cameras.set('cam-door', { device: { id: 'cam-door', name: 'Дверь' }, recorders: new Map(), subscriptions: [] } as never);

const MSK = 'Europe/Moscow';
const at = (local: string) => Date.parse(`${local}+03:00`);
const ctx: AssistantToolContext = { userId: 'u1', role: 'admin', language: 'ru', timezone: MSK };
const Q = 'играет в компьютер';

/** An event with segments [from, to, answers...] in local time "HH:MM:SS" of 2026-10-10. */
function event(id: string, camera: string, segments: [string, string, ...string[]][], extra: Record<string, unknown>[] = []): RecordedEvent {
  const t = (clock: string) => at(`2026-10-10T${clock}`);
  const segs = segments.map(([from, to, ...answers]) => ({
    firstSeen: t(from),
    lastSeen: t(to),
    detections: [{ label: 'person', score: 0.9 }],
    attributes: [...answers.map((a) => ({ type: Q, label: `${Q}: ${a}`, confidence: 0.9 })), ...extra],
  }));
  return {
    id,
    cameraId: camera,
    state: 'ended',
    startTime: segs[0].firstSeen - 10_000,
    endTime: segs[segs.length - 1].lastSeen + 10_000,
    lastUpdate: segs[segs.length - 1].lastSeen,
    types: ['motion', 'person', Q],
    triggers: [],
    segmentIndex: 0,
    segments: segs,
  } as unknown as RecordedEvent;
}

const events = [
  // one long event: yes at 10:00-10:02, a still child until a yes at 10:40 (same event: one stretch), a lone "no" inside
  event('e1', 'cam-kid', [
    ['10:00:00', '10:02:00', 'да'],
    ['10:20:00', '10:20:10', 'нет'],
    ['10:40:00', '10:41:00', 'да'],
  ]),
  // a new event 5 min later: joined (under 10 min)
  event('e2', 'cam-kid', [['10:46:00', '10:50:00', 'да']]),
  // 40 min later: a new stretch, the pause between is a break
  event('e3', 'cam-kid', [['11:30:00', '11:45:00', 'да', 'да']]),
  // only "no": no play, counted as answers
  event('e4', 'cam-kid', [['12:00:00', '12:01:00', 'нет']]),
  // another camera, a face and a plate: never questions of a module
  event(
    'e5',
    'cam-door',
    [['13:00:00', '13:00:30']],
    [
      { type: 'face', label: 'Анна', confidence: 0.9 },
      { type: 'license_plate', label: 'А001АА99', confidence: 0.9 },
    ],
  ),
];
for (const ev of events) await nvr.ingestDetectionEvent(ev.cameraId, 'end' as never, ev as never);
const call = (name: string, input: Record<string, unknown>) => nvr.callAssistantTool(name, input, ctx);
const content = <T = Record<string, unknown>>(r: { content?: unknown; error?: string }) => {
  assert.equal(r.error, undefined, `unexpected error: ${r.error}`);
  return r.content as T;
};

// ---- answers ----
assert.equal(answerOf(Q, `${Q}: да`), 'yes');
assert.equal(answerOf(Q, `${Q}: нет`), 'no');
assert.equal(answerOf(Q, 'Yes'), 'yes');
assert.equal(answerOf(Q, `${Q}: может быть`), undefined);
assert.deepEqual(answersOf(events[0]), { [Q]: { yes: 2, no: 1 } });
assert.deepEqual(answersOf(events[4]), {}, 'a face and a plate are not questions of a module');

// ---- attribute_time ----
type Day = {
  minutes: number;
  stretches: { from: string; to: string; minutes: number }[];
  pauses: { count: number; minutes: number; list: { from: string; to: string }[] };
  answers: { yes: number; no: number };
};
const day = content<Day & { attribute: string; approximate: boolean }>(await call('attribute_time', { attribute: 'играет', date: '2026-10-10' }));
assert.equal(day.attribute, Q, 'a part of the question finds it');
assert.equal(day.approximate, true);
assert.deepEqual(
  day.stretches.map((s) => [s.from, s.to]),
  [
    ['10:00', '10:50'],
    ['11:30', '11:45'],
  ],
  'the still child inside one event and an event 5 min later are one stretch; 40 min later is another',
);
assert.equal(day.minutes, 65);
assert.deepEqual({ count: day.pauses.count, minutes: day.pauses.minutes }, { count: 1, minutes: 40 });
assert.deepEqual(day.answers, { yes: 5, no: 2 });
// the list of questions without one asked
const listed = content<{ attributes: { attribute: string; events: number }[] }>(await call('attribute_time', { date: '2026-10-10' }));
assert.deepEqual(listed.attributes, [{ attribute: Q, events: 4 }]);
assert.match((await call('attribute_time', { attribute: 'спит', date: '2026-10-10' })).error ?? '', /No module answered "спит" lately\. Known: играет в компьютер/);
// another day: nothing played
assert.equal(content<Day>(await call('attribute_time', { attribute: Q, date: '2026-10-09' })).minutes, 0);

// ---- query_events and summarize_day ----
const range = { from: new Date(at('2026-10-10T00:00:00')).toISOString(), to: new Date(at('2026-10-10T23:59:00')).toISOString() };
const ids = (r: { events: { id: string }[] }) => r.events.map((e) => e.id).sort();
assert.deepEqual(ids(content(await call('query_events', { ...range, attribute: Q }))), ['e1', 'e2', 'e3'], 'yes by default');
assert.deepEqual(ids(content(await call('query_events', { ...range, attribute: Q, answer: 'no' }))), ['e1', 'e4']);
const one = content<{ events: { id: string; answers?: unknown }[] }>(await call('query_events', { ...range, attribute: Q, answer: 'any' }));
assert.deepEqual(one.events.find((e) => e.id === 'e4')?.answers, { [Q]: { yes: 0, no: 1 } }, 'an event says what the module answered');
const summary = content<{ byAnswer: Record<string, { yes: number; no: number }> }>(await call('summarize_day', { date: '2026-10-10' }));
assert.deepEqual(summary.byAnswer, { [Q]: { yes: 3, no: 1 } }, 'events with a yes, events with only no');

// ---- what broke the counts (review 2026-10-11), in September: out of the week the cases above list ----
/** An event of segments [from, to, answers...] at local "YYYY-MM-DDTHH:MM:SS"; active: still going on, no end yet. */
function eventAt(
  id: string,
  camera: string,
  segments: [string, string, ...string[]][],
  options: { active?: boolean; question?: string; labels?: string[] } = {},
): RecordedEvent {
  const question = options.question ?? Q;
  const labels = options.labels ?? ['person'];
  const segs = segments.map(([from, to, ...answers]) => ({
    firstSeen: at(from),
    lastSeen: at(to),
    detections: labels.map((label) => ({ label, score: 0.9 })),
    attributes: answers.map((a) => ({ type: question, label: `${question}: ${a}`, confidence: 0.9 })),
  }));
  const last = segs[segs.length - 1].lastSeen;
  return {
    id,
    cameraId: camera,
    state: options.active ? 'active' : 'ended',
    startTime: segs[0].firstSeen - 10_000,
    ...(options.active ? {} : { endTime: last + 10_000 }),
    lastUpdate: last,
    types: ['motion', ...labels, ...(segments.some((seg) => seg.length > 2) ? [question] : [])],
    triggers: [],
    segmentIndex: 0,
    segments: segs,
  } as unknown as RecordedEvent;
}
const homework: [string, string, ...string[]][] = [['2026-09-20T10:00:00', '2026-09-20T10:30:00', 'да']];
for (let m = 35; m <= 145; m += 10) {
  const clock = `${String(10 + Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  homework.push([`2026-09-20T${clock}:00`, `2026-09-20T${clock}:20`, 'нет']);
}
homework.push(['2026-09-20T12:30:00', '2026-09-20T13:00:00', 'да']);
const september = [
  // two hours of homework in one event: «no» all along between two stretches of play
  eventAt('h1', 'cam-kid', homework),
  // «no» twice within a minute and a half: a flicker, one stretch
  eventAt('h2', 'cam-kid', [
    ['2026-09-20T14:00:00', '2026-09-20T14:01:00', 'да'],
    ['2026-09-20T14:01:30', '2026-09-20T14:01:40', 'нет'],
    ['2026-09-20T14:02:00', '2026-09-20T14:02:10', 'нет'],
    ['2026-09-20T14:02:30', '2026-09-20T14:05:00', 'да'],
  ]),
  // at the computer since before midnight: the event has no end yet
  eventAt(
    'a1',
    'cam-kid',
    [
      ['2026-09-20T23:30:00', '2026-09-20T23:50:00', 'да'],
      ['2026-09-21T00:05:00', '2026-09-21T00:40:00', 'да'],
    ],
    { active: true },
  ),
  // two children at two computers on one day
  eventAt('k1', 'cam-kid', [['2026-09-22T10:00:00', '2026-09-22T11:00:00', 'да']]),
  eventAt('k2', 'cam-door', [['2026-09-22T14:00:00', '2026-09-22T15:00:00', 'да']]),
  // one look only: a moment
  eventAt('m1', 'cam-kid', [['2026-09-23T09:00:00', '2026-09-23T09:00:00', 'да']]),
  // another question with the same word, and a module's own label
  eventAt('b1', 'cam-door', [['2026-09-24T09:00:00', '2026-09-24T09:10:00', 'да']], { question: 'играет в мяч' }),
  eventAt('n1', 'cam-kid', [['2026-09-20T16:00:00', '2026-09-20T16:05:00']], { labels: ['ноутбук'] }),
];
for (const ev of september) await nvr.ingestDetectionEvent(ev.cameraId, (ev.state === 'active' ? 'update' : 'end') as never, ev as never);
const spans = (d: { stretches: { from: string; to: string }[] }) => d.stretches.map((x) => [x.from, x.to]);

const sept20 = content<Day>(await call('attribute_time', { attribute: Q, camera: 'Детская', date: '2026-09-20' }));
assert.deepEqual(
  spans(sept20),
  [
    ['10:00', '10:30'],
    ['12:30', '13:00'],
    ['14:00', '14:05'],
    ['23:30', '23:59'],
  ],
  'two hours of «no» in one event part the play; «no» twice in a minute and a half does not',
);
assert.deepEqual({ count: sept20.pauses.count, first: sept20.pauses.list[0] }, { count: 3, first: { from: '10:30', to: '12:30', minutes: 120 } });

// the event still going on since 23:30 is in the next day too, and its stretch over midnight is one
const sept21 = content<Day>(await call('attribute_time', { attribute: Q, camera: 'Детская', date: '2026-09-21' }));
assert.deepEqual(spans(sept21), [['00:00', '00:40']]);
assert.equal(sept21.minutes, 40);
const both = content<{ days: (Day & { date: string })[] }>(await call('attribute_time', { attribute: Q, camera: 'Детская', date: '2026-09-21', days: 2 }));
assert.deepEqual(
  both.days.map((d) => d.date),
  ['2026-09-20', '2026-09-21'],
);
assert.deepEqual(spans(both.days[1]), [['00:00', '00:40']]);

// two cameras: each its own count, never added up
const apart = content<{ camera: string; cameras: ({ camera: string } & Day)[]; hint: string }>(await call('attribute_time', { attribute: Q, date: '2026-09-22' }));
assert.equal(apart.camera, 'all');
assert.deepEqual(apart.cameras.map((c) => [c.camera, c.minutes]).sort(), [
  ['Дверь', 60],
  ['Детская', 60],
]);
assert.match(apart.hint, /each has its own count/);
const kid = content<Day & { camera: string }>(await call('attribute_time', { attribute: Q, camera: 'Детская', date: '2026-09-22' }));
assert.deepEqual({ camera: kid.camera, minutes: kid.minutes }, { camera: 'Детская', minutes: 60 });

// a lone look is a moment of play, not nothing
const moment = content<Day>(await call('attribute_time', { attribute: Q, date: '2026-09-23' }));
assert.deepEqual({ stretches: spans(moment), minutes: moment.minutes, yes: moment.answers.yes }, { stretches: [['09:00', '09:00']], minutes: 0, yes: 1 });

// two questions with the word: the person is asked which
assert.match((await call('attribute_time', { attribute: 'играет', date: '2026-09-24' })).error ?? '', /^"играет" fits several: /);

// query_events: a label no event had is said; a module's label is one; the question by a part; labels and the question both hold
const sept = { from: new Date(at('2026-09-20T00:00:00')).toISOString(), to: new Date(at('2026-09-20T23:59:00')).toISOString() };
assert.match(
  (await call('query_events', { ...sept, labels: ['people'] })).error ?? '',
  /^Unknown label "people"\. Labels seen in the last 7 days: person, vehicle, animal, ноутбук$/,
);
assert.deepEqual(ids(content(await call('query_events', { ...sept, labels: ['ноутбук'] }))), ['n1']);
assert.deepEqual(ids(content(await call('query_events', { ...range, attribute: 'компьютер' }))), ['e1', 'e2', 'e3'], 'a part of the question');
assert.deepEqual(ids(content(await call('query_events', { ...range, attribute: Q, labels: ['animal'] }))), [], 'no animal answered the question');
assert.deepEqual(ids(content(await call('query_events', { ...range, attribute: Q, labels: ['person'] }))), ['e1', 'e2', 'e3']);

console.log('attributes.spec: answers, attribute_time, query_events by answer, summarize_day byAnswer OK');
process.exit(0);
