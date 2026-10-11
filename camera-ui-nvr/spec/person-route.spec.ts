// Where a person went, camera after camera (personRoute, person_route): around a recorded moment, the moments whose
// people look like them, in time order, one stay per camera while they stay there (another camera in between starts a
// new one). Unlike people stay out, the window bounds it, a moment of two people follows both or the one named. The
// assistant says the stays in the person's clock with a button each, and which cameras saw nobody.
// Run: npx tsx spec/person-route.spec.ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { routeOf } from '../src/people.js';
import VionNvr from '../src/index.js';

import type { AssistantToolContext } from '@camera.ui/sdk';

const dim = 8;
/** A unit vector between two looks: share 1 is the first, 0 the second. */
function look(a: number, b: number, share: number): number[] {
  const v = Array.from({ length: dim }, () => 0);
  v[a] = share;
  v[b] = Math.sqrt(Math.max(0, 1 - share * share));
  return v;
}
const RED = look(0, 1, 1);
const RED_TOO = look(0, 1, 0.9); // cosine 0.9 with RED
const RED_ISH = look(0, 1, 0.5); // 0.5: under the middle of the band (0.525)
const BLUE = look(2, 3, 1); // 0

const noop = () => undefined;
const logger = { log: noop, warn: noop, error: console.error, debug: noop, attention: noop, trace: noop };
const api = {
  storagePath: mkdtempSync(join(tmpdir(), 'nvr-route-')),
  on: noop,
  once: noop,
  emit: noop,
  notificationManager: { publish: async () => undefined },
  coreManager: { assistantAccess: async () => ({ allowed: false }), getFFmpegPath: () => new Promise<string>(noop), getPluginsByInterface: async () => [] },
};
const storage = { values: {} as Record<string, unknown>, getValue: async () => undefined, setValue: async () => undefined };
const nvr = new VionNvr(logger as never, api as never, storage as never);
const cameras = (nvr as unknown as { cameras: Map<string, unknown> }).cameras;
for (const [id, name] of [
  ['door', 'Входная дверь'],
  ['lift', 'Лифт'],
  ['yard', 'Двор'],
  ['garage', 'Гараж'],
  ['attic', 'Чердак'],
]) {
  cameras.set(id, { device: { id, name }, recorders: new Map(), subscriptions: [] } as never);
}

const MIN = 60_000;
// 10:00 Moscow two hours ago, so that nothing is pruned
const T0 = Date.now() - 2 * 3_600_000;
const at = (minutes: number) => T0 + minutes * MIN;
type People = { trackId: number; embedding: number[]; embeddingModel: string }[];
const person = (trackId: number, embedding: number[]) => ({ trackId, embedding, embeddingModel: 'reid-test' });
async function moment(id: string, cameraId: string, minutes: number, people: People) {
  const t = at(minutes);
  const segment = { firstSeen: t, lastSeen: t + 4000, zones: [], detections: [{ label: 'person', score: 0.9, trackId: 1 }], attributes: [], personEmbeddings: people };
  const event = { id, cameraId, state: 'ended', startTime: t, endTime: t + 5000, lastUpdate: t + 5000, types: ['object'], triggers: [], segmentIndex: 0, segments: [segment] };
  await nvr.ingestDetectionEvent(cameraId, 'segment-end' as never, event as never);
}

// the corridor at 10:00 and again at 10:01:30, the lift at 10:03 and 10:05, someone alike in the yard at 10:10, a
// stranger in the lift at 10:20, the same person back at the door at 11:00 (out of the half hour)
await moment('ev-door-1', 'door', 0, [person(1, RED)]);
await moment('ev-door-2', 'door', 1.5, [person(1, RED)]);
await moment('ev-lift-1', 'lift', 3, [person(4, RED_TOO)]);
await moment('ev-lift-2', 'lift', 5, [person(2, RED)]);
await moment('ev-yard', 'yard', 10, [person(7, RED_ISH)]);
await moment('ev-lift-blue', 'lift', 20, [person(3, BLUE)]);
await moment('ev-door-late', 'door', 60, [person(1, RED)]);
// a moment of two: the red one and the blue one
await moment('ev-two', 'yard', 25, [person(1, RED), person(2, BLUE)]);
// someone on the attic two hours later: out of any half hour around 10:00
await moment('ev-attic', 'attic', 120, [person(1, BLUE)]);
// an event whose first segment has nobody, its second the red one
await nvr.ingestDetectionEvent(
  'yard',
  'segment-end' as never,
  {
    id: 'ev-late-seg',
    cameraId: 'yard',
    state: 'ended',
    startTime: at(44),
    endTime: at(46),
    types: ['object'],
    triggers: [],
    segments: [
      { firstSeen: at(44), detections: [] },
      { firstSeen: at(45), detections: [{ label: 'person', score: 0.9, trackId: 5 }], personEmbeddings: [person(5, RED)] },
    ],
  } as never,
);
// an event with nobody to follow
await nvr.ingestDetectionEvent(
  'garage',
  'segment-end' as never,
  { id: 'ev-car', cameraId: 'garage', state: 'ended', startTime: at(2), endTime: at(2) + 5000, types: ['object'], triggers: [], segments: [{ firstSeen: at(2), detections: [] }] } as never,
);

const stays = (route: Awaited<ReturnType<typeof nvr.personRoute>>) =>
  route.visits.map((v) => `${v.cameraId} ${(v.from - T0) / MIN}-${(v.to - T0) / MIN} ${v.eventId}${v.origin ? ' *' : ''}`);

// ---- from the corridor: the corridor, then the lift; the alike one, the stranger and the late return stay out
{
  const route = await nvr.personRoute({ eventId: 'ev-door-1' });
  assert.equal(route.mode, 'person');
  assert.deepEqual(stays(route), ['door 0-1.5 ev-door-1 *', 'lift 3-5 ev-lift-2', 'yard 25-25 ev-two']);
  assert.equal(route.windowMs, 30 * MIN);
  assert.equal(route.minScore, 0.525);
  assert.deepEqual(route.origin, { eventId: 'ev-door-1', segment: 0, cameraId: 'door', time: at(0), people: 1 });
  // the events of the stays for their cards, each once, with their recording said
  assert.deepEqual(route.events.map((ev) => [ev.id, typeof ev.hasRecording]), [['ev-door-1', 'boolean'], ['ev-lift-2', 'boolean'], ['ev-two', 'boolean']]);
  assert.deepEqual([...route.camerasWithPeople].sort(), ['door', 'lift', 'yard'], 'the garage filed nobody, the attic nobody in the window');
}

// ---- from the lift: where they came from
{
  const route = await nvr.personRoute({ eventId: 'ev-lift-1' });
  // the lift's person is a little less red: the one alike in the yard is close enough to them (cosine 0.83)
  assert.deepEqual(stays(route), ['door 0-1.5 ev-door-1', 'lift 3-5 ev-lift-1 *', 'yard 10-10 ev-yard', 'yard 25-25 ev-two'], 'the stay of the moment asked shows that moment');
}

// ---- a longer window takes the return; never more than three hours
{
  assert.deepEqual(stays(await nvr.personRoute({ eventId: 'ev-door-1' }, { minutes: 90 })).at(-1), 'door 60-60 ev-door-late');
  assert.equal((await nvr.personRoute({ eventId: 'ev-door-1' }, { minutes: 10_000 })).windowMs, 180 * MIN);
}

// ---- a moment of two follows both, or the one named
{
  const both = await nvr.personRoute({ eventId: 'ev-two' });
  assert.equal(both.origin!.people, 2);
  assert.ok(stays(both).includes('lift 20-20 ev-lift-blue'), JSON.stringify(stays(both)));
  const red = await nvr.personRoute({ eventId: 'ev-two', trackId: 1 });
  assert.equal(red.origin!.people, 1);
  assert.ok(!stays(red).some((stay) => stay.includes('ev-lift-blue')), JSON.stringify(stays(red)));
}

// ---- an event asked without a segment: its first with people
{
  const route = await nvr.personRoute({ eventId: 'ev-late-seg' });
  assert.equal(route.mode, 'person');
  assert.deepEqual(route.origin, { eventId: 'ev-late-seg', segment: 1, cameraId: 'yard', time: at(45), people: 1 });
}

// ---- nothing to follow
{
  assert.equal((await nvr.personRoute({ eventId: 'ev-car' })).reason, 'no-vectors');
  assert.equal((await nvr.personRoute({ eventId: 'no-such' })).reason, 'no-vectors');
  assert.equal((await nvr.personRoute({ eventId: '' })).reason, 'unsupported');
}

// ---- a stay ends where another camera saw them in between, or after three minutes away
{
  const origin = { eventId: 'a', cameraId: 'door', seg: 0, trackId: 1, ts: 0, score: 1 };
  const hit = (eventId: string, cameraId: string, minutes: number, score = 0.9) => ({ eventId, cameraId, seg: 0, trackId: 1, ts: minutes * MIN, score });
  const route = routeOf(origin, [hit('b', 'lift', 2), hit('c', 'door', 2.5), hit('d', 'door', 6), hit('e', 'door', 8.5, 0.95)], 3 * MIN);
  assert.deepEqual(
    route.map((v) => `${v.cameraId} ${v.from / MIN}-${v.to / MIN} ${v.eventId}`),
    // 2.5 → 6 is more than three minutes apart; 6 → 8.5 one stay, shown by its better moment
    ['door 0-0 a', 'lift 2-2 b', 'door 2.5-2.5 c', 'door 6-8.5 e'],
  );
}

// ---- the assistant: the stays in the person's clock, a button each, the cameras that saw nobody
{
  const ctx: AssistantToolContext = { userId: 'u1', role: 'admin', language: 'ru', timezone: 'Europe/Moscow' };
  const result = await nvr.callAssistantTool('person_route', { event: 'ev-door-1' }, ctx);
  assert.equal(result.error, undefined, String(result.error));
  const content = result.content as { route: { camera: string; from: string; to: string; event: string; asked?: true }[]; camerasWithoutPeople?: string[]; people: number };
  const clock = (minutes: number) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(at(minutes));
  assert.deepEqual(content.route.map((stay) => [stay.camera, stay.from, stay.to, stay.asked ?? false]), [
    ['Входная дверь', clock(0), clock(1.5), true],
    ['Лифт', clock(3), clock(5), false],
    ['Двор', clock(25), clock(25), false],
  ]);
  assert.deepEqual(content.camerasWithoutPeople, ['Гараж', 'Чердак']);
  assert.equal(result.references?.length, 3);
  const two = await nvr.callAssistantTool('person_route', { event: 'ev-two' }, ctx);
  assert.match((two.content as { hint?: string }).hint ?? '', /2 people/);
  assert.match((await nvr.callAssistantTool('person_route', {}, ctx)).error ?? '', /event is required/);
  assert.match((await nvr.callAssistantTool('person_route', { event: 'ev-car' }, ctx)).error ?? '', /no person to follow/);
  assert.match((await nvr.callAssistantTool('person_route', { event: 'nope' }, ctx)).error ?? '', /No event/);
}

console.log('person-route.spec: stays in time order, joined per camera, window, two people, nothing to follow, the assistant OK');
process.exit(0);
