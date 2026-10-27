// Levels of events (VION 2.6.46): the server raises an event to yellow or red by the rules of its camera and keeps the
// level on the event; the recorder stores it with the event and finds events by it. An event of no level — recorded
// before levels, or one of the recorder's own (a thing left behind) — is green.
// Run: npx tsx spec/levels.spec.ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { matchesEvent } from '../src/filter.js';
import VionNvr from '../src/index.js';

import type { EventLevel, GetEventsOptions, RecordedEvent } from '../src/types.js';

const dir = mkdtempSync(join(tmpdir(), 'nvr-levels-'));
const noop = () => undefined;
const logger = { log: noop, warn: (...a: unknown[]) => console.warn('[warn]', ...a), error: console.error, debug: noop, attention: noop, trace: noop };
const api = {
  storagePath: dir,
  on: noop,
  once: noop,
  emit: noop,
  notificationManager: { publish: async () => undefined },
  coreManager: {
    assistantAccess: async () => ({ allowed: false }),
    getFFmpegPath: () => new Promise<string>(noop),
    getPluginsByInterface: async () => [],
  },
};
const storage = { values: {} as Record<string, unknown>, getValue: async () => undefined, setValue: async () => undefined };
const nvr = new VionNvr(logger as never, api as never, storage as never);

function event(id: string, start: number, level?: EventLevel): RecordedEvent {
  return {
    id,
    cameraId: 'cam1',
    state: 'ended',
    startTime: start,
    endTime: start + 5000,
    lastUpdate: start + 5000,
    types: ['motion', 'person'],
    triggers: [{ type: 'motion', firstSeen: start, lastSeen: start + 1000 }],
    segmentIndex: 0,
    segments: [{ firstSeen: start, lastSeen: start + 5000, detections: [{ label: 'person', score: 0.9, maxCount: 1 }], attributes: [] }],
    ...(level ? { level, levelReasons: level === 'green' ? [] : [{ rule: `${level}-rule`, name: level, level, notify: false, at: start }] } : {}),
  } as unknown as RecordedEvent;
}

const events = [event('old', 1000), event('green', 2000, 'green'), event('door', 3000, 'yellow'), event('scream', 4000, 'red')];
const pick = (opts: GetEventsOptions) => events.filter((e) => matchesEvent(e, opts)).map((e) => e.id);

// ------------------------------------------------------------ the matcher alone
assert.deepEqual(pick({}), ['old', 'green', 'door', 'scream'], 'no level asked: every event');
assert.deepEqual(pick({ levels: [] }), ['old', 'green', 'door', 'scream'], 'an empty list asks nothing');
assert.deepEqual(pick({ levels: ['red'] }), ['scream'], 'the alarms');
assert.deepEqual(pick({ levels: ['yellow', 'red'] }), ['door', 'scream'], 'what needs a look');
assert.deepEqual(pick({ levels: ['green'] }), ['old', 'green'], 'an event of no level is green');
// joined with the other filters as one more condition
assert.deepEqual(pick({ levels: ['yellow', 'red'], types: ['person'] }), ['door', 'scream']);
assert.deepEqual(pick({ levels: ['red'], types: ['vehicle'] }), []);

// --------------------------------------------------------- through the plugin
for (const e of events) await nvr.ingestDetectionEvent('cam1', 'end' as never, e as never);
// many green ones newer than the alarm: the level filter scans past a full batch of them
for (let i = 0; i < 450; i++) await nvr.ingestDetectionEvent('cam1', 'end' as never, event(`filler-${i}`, 10_000 + i, 'green') as never);

const ids = async (opts: GetEventsOptions) => (await nvr.getEvents({ limit: 10, ...opts })).events.map((e) => e.id);
assert.deepEqual(await ids({ levels: ['red'] }), ['scream'], 'the alarm, past 450 newer green events');
assert.deepEqual(await ids({ levels: ['yellow', 'red'] }), ['scream', 'door']);
// what the recorder stored keeps the level and its reasons, for the cards and the assistant
const stored = (await nvr.getEvents({ levels: ['red'], limit: 1 })).events[0] as RecordedEvent & { levelReasons?: unknown[] };
assert.equal(stored.level, 'red');
assert.deepEqual(stored.levelReasons, [{ rule: 'red-rule', name: 'red', level: 'red', notify: false, at: 4000 }]);

// a level only rises: a message read late — sent before the one that raised the event — leaves the alarm red with
// every reason, and one of an older server (no level at all) leaves it as it was
const door = { rule: 'door', name: 'У двери', level: 'yellow', notify: false, at: 20_100 };
const fall = { rule: 'fall', name: 'Падение', level: 'red', notify: true, at: 20_200 };
const going = (levelPart: object) => ({ ...event('late', 20_000), state: 'active', endTime: undefined, ...levelPart }) as never;
await nvr.ingestDetectionEvent('cam1', 'update' as never, going({ level: 'red', levelReasons: [door, fall] }));
await nvr.ingestDetectionEvent('cam1', 'update' as never, going({ level: 'yellow', levelReasons: [door] }));
await nvr.ingestDetectionEvent('cam1', 'update' as never, going({}));
const late = (await nvr.getEvents({ levels: ['red'], limit: 1 })).events[0] as RecordedEvent & { levelReasons?: unknown[] };
assert.equal(late.id, 'late');
assert.equal(late.level, 'red');
assert.deepEqual(late.levelReasons, [door, fall]);
// a new reason of the same event is added to those it had
const run = { rule: 'run', name: 'Бег', level: 'yellow', notify: false, at: 20_300 };
await nvr.ingestDetectionEvent('cam1', 'update' as never, going({ level: 'red', levelReasons: [door, fall, run] }));
assert.deepEqual(((await nvr.getEvents({ levels: ['red'], limit: 1 })).events[0] as RecordedEvent & { levelReasons?: unknown[] }).levelReasons, [door, fall, run]);

// ------------------------------------------------- the assistant's query_events
const ctx = { userId: 'u1', role: 'admin', language: 'ru', timezone: 'UTC' } as never;
const range = { from: new Date(0).toISOString(), to: new Date(60_000).toISOString(), limit: 50 };
type Brief = { id: string; level?: string; rules?: string[] };
const asked = async (input: Record<string, unknown>) => {
  const result = await nvr.callAssistantTool('query_events', { ...range, ...input }, ctx);
  assert.equal(result.error, undefined, String(result.error));
  return (result.content as { events: Brief[] }).events;
};
const alarms = await asked({ levels: ['red'] });
assert.deepEqual(
  alarms.map((e) => e.id),
  ['late', 'scream'],
);
// a raised event says how and by what, for «что было тревожного»
assert.deepEqual(alarms[0], { ...alarms[0], level: 'red', rules: ['У двери', 'Падение', 'Бег'] });
assert.deepEqual(
  (await asked({ levels: ['YELLOW'] })).map((e) => e.id),
  ['door'],
  'a level in capitals is that level',
);
// a green event names no level: most events are green, and a word on each would only be noise
const greens = await asked({ levels: ['green'] });
assert.ok(greens.length > 2 && greens.every((e) => e.level === undefined && e.rules === undefined));
assert.match((await nvr.callAssistantTool('query_events', { ...range, levels: ['orange'] }, ctx)).error ?? '', /Unknown level "orange"/);
const declared = (await import('../src/assistant.js')).ASSISTANT_TOOLS.find((tool) => tool.name === 'query_events');
assert.deepEqual((declared?.inputSchema.properties as Record<string, { items?: { enum?: string[] } }>).levels?.items?.enum, ['green', 'yellow', 'red']);

// ------------------------------------------------------- what the lists ask too
// a raised event is content of its own: a scream or a crying child heard with nobody in the picture is the alarm the
// lists show (they ask hasDetections to leave out bare motion), while a green event of a sound alone stays out
const heardOnly = (id: string, level?: EventLevel) => ({ ...event(id, 30_000, level), types: ['audio'], segments: [] }) as unknown as RecordedEvent;
assert.equal(matchesEvent(heardOnly('cry', 'red'), { hasDetections: true }), true, 'a red event of a sound alone is listed');
assert.equal(matchesEvent(heardOnly('knock', 'yellow'), { hasDetections: true }), true);
assert.equal(matchesEvent(heardOnly('hum', 'green'), { hasDetections: true }), false, 'a green one of a sound alone is not');
assert.equal(matchesEvent(heardOnly('hum2'), { hasDetections: true }), false);

// the count of the page («N из M») counts by level as the list does
const stats = async (opts: GetEventsOptions) => (await nvr.getEventStats(['cam1'], opts)).total;
assert.equal(await stats({ levels: ['red'] }), 2, 'scream and late');
assert.equal(await stats({ levels: ['yellow'] }), 1);
assert.equal(await stats({ levels: ['yellow', 'red'] }), 3);
assert.equal(await stats({}), events.length + 450 + 1);

// a client asks the recorder whether it knows levels: an older one leaves `levels` out and lists every event
assert.equal((await nvr.getNvrFeatures()).eventLevels, true);

console.log('levels.spec: event levels stored and found OK');
process.exit(0);
