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

// ---- hops: across cameras re-ID is weak, but the next camera a few minutes after a stay narrows it to a few people.
// Looks of their own (other models, never compared with the ones above), hours before them.
const hopStays = (route: Awaited<ReturnType<typeof nvr.personRoute>>, base: number) =>
  route.visits.map((v) => `${v.cameraId} ${(v.from - at(base)) / MIN}-${(v.to - at(base)) / MIN} ${v.eventId}${v.origin ? ' *' : ''}${v.hop ? ` hop ${v.score}` : ''}`);
{
  const B = -400;
  const hopper = (embedding: number[]) => [{ trackId: 1, embedding, embeddingModel: 'reid-hop' }];
  const GREEN = look(0, 1, 1);
  // the same person at the end of their stay at the door, turned away: 0.6 with GREEN
  const DOOR2 = look(0, 7, 0.6);
  // someone else at the door a minute later: 0.5 with DOOR2, 0.4 with GREEN; a hop never stays on the camera
  const DOOR3 = [0.4, 0, 0, 0, 0, Math.sqrt(1 - 0.16 - 0.325 ** 2), 0, 0.325];
  // the lift: 0.45 with DOOR2, 0.3 with GREEN; reached from the vectors seen at the end of the stay
  const FAR = [0.3, Math.sqrt(1 - 0.09 - 0.3375 ** 2), 0, 0, 0, 0, 0, 0.3375];
  // 0.5 with FAR, 0 with GREEN: reached through the lift only, as sure as the weaker link (0.45)
  const YARD = look(1, 2, 0.5 / FAR[1]);
  const OTHER = look(0, 3, 0.2); // someone else: 0.2
  const BACK = look(0, 4, 0.36); // where they came from
  const LATE = look(0, 3, 0.4); // 0.4 with GREEN, nine minutes after the last stay
  // alike to the yard (0.41) and to the garage (0.47), but four minutes from them: a hop is three
  const SLOW = look(2, 5, 0.5);
  const EARLY = look(4, 6, 0.5);
  await moment('hop-early', 'yard', B - 6, hopper(EARLY));
  await moment('hop-back', 'garage', B - 2, hopper(BACK));
  await moment('hop-door-1', 'door', B, hopper(GREEN));
  await moment('hop-door-2', 'door', B + 2, hopper(DOOR2));
  await moment('hop-door-3', 'door', B + 3, hopper(DOOR3));
  await moment('hop-garage', 'garage', B + 3, hopper(OTHER));
  // four minutes after the moment asked, two after the end of its stay
  await moment('hop-lift', 'lift', B + 4, hopper(FAR));
  await moment('hop-yard', 'yard', B + 6, hopper(YARD));
  await moment('hop-slow', 'attic', B + 10, hopper(SLOW));
  await moment('hop-attic', 'attic', B + 15, hopper(LATE));
  const route = await nvr.personRoute({ eventId: 'hop-door-1' });
  assert.deepEqual(hopStays(route, B), ['garage -2--2 hop-back hop 0.36', 'door 0-2 hop-door-1 *', 'lift 4-4 hop-lift hop 0.45', 'yard 6-6 hop-yard hop 0.45']);
  assert.equal(route.hopScore, 0.35);
  assert.equal(route.minScore, 0.525, 'the window keeps its floor');
  // the strangers at the door and in the garage between the stays, and the ones four and nine minutes later, stay out
  assert.deepEqual(route.events.map((ev) => ev.id).sort(), ['hop-back', 'hop-door-1', 'hop-lift', 'hop-yard']);
  // the assistant says which stays are hops, and how sure a hop is
  const told = await nvr.callAssistantTool('person_route', { event: 'hop-door-1' }, { userId: 'u1', role: 'admin', language: 'ru', timezone: 'Europe/Moscow' });
  const content = told.content as { route: { event: string; hop?: true }[]; note: string };
  assert.deepEqual(content.route.map((stay) => `${stay.event}${stay.hop ? ' hop' : ''}`), ['hop-back hop', 'hop-door-1', 'hop-lift hop', 'hop-yard hop']);
  assert.match(content.note, /`hop`.*from 0\.35/);
  // from the lift: the door is where they came from (its stay as the door saw them), the yard where they went
  assert.deepEqual(hopStays(await nvr.personRoute({ eventId: 'hop-lift' }), B), [
    'garage -2--2 hop-back hop 0.36',
    'door 0-2 hop-door-1 hop 0.45',
    'lift 4-4 hop-lift *',
    'yard 6-6 hop-yard hop 0.5',
  ]);
  // never out of the window asked
  assert.deepEqual(
    hopStays(await nvr.personRoute({ eventId: 'hop-door-1' }, { minutes: 5 }), B).map((stay) => stay.split(' ')[0]),
    ['garage', 'door', 'lift'],
  );
  assert.deepEqual(hopStays(await nvr.personRoute({ eventId: 'hop-door-1' }, { minutes: 1 }), B), ['door 0-0 hop-door-1 *']);

  // «точнее» on the page made only the stays stricter: the hops stayed at 0.35. They move with it as much as the
  // window's floor: at the top of the band (0.65) a hop needs 0.475, the lift (0.45) and the garage (0.36) are left
  const strict = await nvr.personRoute({ eventId: 'hop-door-1' }, { minScore: 0.65 });
  assert.deepEqual(hopStays(strict, B), ['door 0-0 hop-door-1 *']);
  assert.equal(strict.hopScore, 0.475);
  // broader: 0.45 for the window, 0.275 for a hop
  assert.equal((await nvr.personRoute({ eventId: 'hop-door-1' }, { minScore: 0.45 })).hopScore, 0.275);
  // the precision as the page's slider gives it (0 broader … 1 more precise), for the assistant
  assert.equal((await nvr.personRoute({ eventId: 'hop-door-1' }, { precision: 1 })).hopScore, 0.475);
  assert.equal((await nvr.personRoute({ eventId: 'hop-door-1' }, { precision: 0.5 })).minScore, 0.525);
  const precise = await nvr.callAssistantTool('person_route', { event: 'hop-door-1', precision: 1 }, { userId: 'u1', role: 'admin', language: 'ru', timezone: 'Europe/Moscow' });
  assert.deepEqual((precise.content as { route: { event: string }[] }).route.map((stay) => stay.event), ['hop-door-1']);
  assert.match((precise.content as { note: string }).note, /from 0\.475/);

  // the hops are set in the NVR's settings (People): how sure, how many minutes apart, how many in a row
  const schema = nvr.storageSchema.filter((field) => ['routeHopScore', 'routeHopMinutes', 'routeHops'].includes(field.key ?? ''));
  assert.deepEqual(
    schema.map((field) => [field.key, (field as { defaultValue?: unknown }).defaultValue, field.group]),
    [
      ['routeHopScore', 0.35, 'People'],
      ['routeHopMinutes', 3, 'People'],
      ['routeHops', 6, 'People'],
    ],
  );
  const values = (storage as { values: Record<string, unknown> }).values;
  try {
    values.routeHopScore = 0.5;
    const surer = await nvr.personRoute({ eventId: 'hop-door-1' });
    assert.deepEqual(hopStays(surer, B), ['door 0-2 hop-door-1 *'], 'a hop of 0.45 is under 0.5');
    assert.equal(surer.hopScore, 0.5);
    delete values.routeHopScore;
    values.routeHopMinutes = 1;
    assert.deepEqual(hopStays(await nvr.personRoute({ eventId: 'hop-door-1' }), B), ['door 0-2 hop-door-1 *'], 'the lift is two minutes after the stay');
    values.routeHopMinutes = 5;
    assert.ok(hopStays(await nvr.personRoute({ eventId: 'hop-door-1' }), B).some((stay) => stay.startsWith('lift')));
    delete values.routeHopMinutes;
    values.routeHops = 0;
    assert.deepEqual(hopStays(await nvr.personRoute({ eventId: 'hop-door-1' }), B), ['door 0-2 hop-door-1 *'], 'no hops: the route by the look alone');
    values.routeHops = 1;
    assert.deepEqual(
      hopStays(await nvr.personRoute({ eventId: 'hop-door-1' }), B).map((stay) => stay.split(' ')[0]),
      ['garage', 'door', 'lift'],
      'one hop: the yard behind the lift is a second',
    );
    // nonsense stored is the default
    values.routeHops = 'many';
    values.routeHopScore = 'sure';
    const fallback = await nvr.personRoute({ eventId: 'hop-door-1' });
    assert.equal(fallback.hopScore, 0.35);
    assert.equal(fallback.visits.length, 4);
  } finally {
    delete values.routeHopScore;
    delete values.routeHopMinutes;
    delete values.routeHops;
  }
}

// ---- a hop to a moment alike to the asked one: the chain on from it is as sure as that likeness, not the hop before
{
  const D = -800;
  const through = (embedding: number[]) => [{ trackId: 1, embedding, embeddingModel: 'reid-through' }];
  const YARD = [0.6, 0.3, Math.sqrt(1 - 0.36 - 0.09), 0, 0, 0, 0, 0]; // 0.6 with the door, 0.538 with the lift
  await moment('through-door', 'door', D, through(look(0, 1, 1)));
  await moment('through-lift', 'lift', D + 2, through(look(0, 1, 0.45)));
  await moment('through-yard', 'yard', D + 4, through(YARD));
  await moment('through-attic', 'attic', D + 6, through(look(2, 3, 0.5 / YARD[2]))); // 0.5 with the yard, 0 with the rest
  assert.deepEqual(hopStays(await nvr.personRoute({ eventId: 'through-door' }), D), [
    'door 0-0 through-door *',
    'lift 2-2 through-lift hop 0.45',
    'yard 4-4 through-yard',
    'attic 6-6 through-attic hop 0.5',
  ]);
}

// ---- a moment of two: each followed alone, a moment both reach as sure as the surer of them
{
  const E = -900;
  const two = (embedding: number[], trackId = 1) => ({ trackId, embedding, embeddingModel: 'reid-two' });
  await moment('two-attic', 'attic', E - 2, [two(look(1, 4, 0.42))]); // the second one's (0.42), nothing like the first
  await moment('two-garage', 'garage', E - 1, [two(look(0, 3, 0.45))]); // the first one's (0.45), nothing like the second
  await moment('two-0', 'door', E, [two(look(0, 1, 1), 1), two(look(1, 0, 1), 2)]);
  await moment('two-lift', 'lift', E + 1, [two([0.4, 0.5, Math.sqrt(1 - 0.16 - 0.25), 0, 0, 0, 0, 0])]); // 0.4 with the first, 0.5 with the second
  assert.deepEqual(hopStays(await nvr.personRoute({ eventId: 'two-0' }), E), [
    'attic -2--2 two-attic hop 0.42',
    'garage -1--1 two-garage hop 0.45',
    'door 0-0 two-0 *',
    'lift 1-1 two-lift hop 0.5',
  ]);
}

// ---- a chain stops after six hops: each look like the one before (0.48), nothing like the ones further
{
  const C = -600;
  const chained = (k: number) => {
    const v = Array.from({ length: 12 }, () => 0);
    v[k] = 0.6;
    v[k + 1] = 0.8;
    return [{ trackId: 1, embedding: v, embeddingModel: 'reid-chain' }];
  };
  for (let k = 0; k <= 8; k++) await moment(`chain-${k}`, k % 2 ? 'lift' : 'door', C + 2 * k, chained(k));
  const route = await nvr.personRoute({ eventId: 'chain-0' });
  assert.deepEqual(
    route.visits.map((v) => v.eventId),
    ['chain-0', 'chain-1', 'chain-2', 'chain-3', 'chain-4', 'chain-5', 'chain-6'],
  );
  assert.ok(route.visits.slice(1).every((v) => v.hop && v.score === 0.48), JSON.stringify(route.visits));
  // backwards the same
  assert.deepEqual(
    (await nvr.personRoute({ eventId: 'chain-8' })).visits.map((v) => v.eventId),
    ['chain-2', 'chain-3', 'chain-4', 'chain-5', 'chain-6', 'chain-7', 'chain-8'],
  );
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
  // a stay shows a moment alike to the asked one before any hop, whatever the hop's score: they are of different things
  const shown = routeOf(origin, [{ ...hit('f', 'lift', 2, 0.9), hop: true }, hit('g', 'lift', 3, 0.6), { ...hit('h', 'yard', 6, 0.5), hop: true }], 3 * MIN);
  assert.deepEqual(
    shown.map((v) => `${v.cameraId} ${v.eventId} ${v.score}${v.hop ? ' hop' : ''}`),
    ['door a 1', 'lift g 0.6', 'yard h 0.5 hop'],
  );
  const later = routeOf(origin, [hit('g', 'lift', 2, 0.6), { ...hit('f', 'lift', 3, 0.9), hop: true }], 3 * MIN);
  assert.deepEqual(later.map((v) => `${v.eventId}${v.hop ? ' hop' : ''}`), ['a', 'g']);
}

// ---- the assistant: the stays in the person's clock, a button each, the cameras that saw nobody
{
  const ctx: AssistantToolContext = { userId: 'u1', role: 'admin', language: 'ru', timezone: 'Europe/Moscow' };
  const result = await nvr.callAssistantTool('person_route', { event: 'ev-door-1' }, ctx);
  assert.equal(result.error, undefined, String(result.error));
  const content = result.content as { route: { camera: string; from: string; to: string; event: string; asked?: true }[]; camerasWithoutPeople?: { camera: string }[]; people: number };
  const clock = (minutes: number) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(at(minutes));
  assert.deepEqual(content.route.map((stay) => [stay.camera, stay.from, stay.to, stay.asked ?? false]), [
    ['Входная дверь', clock(0), clock(1.5), true],
    ['Лифт', clock(3), clock(5), false],
    ['Двор', clock(25), clock(25), false],
  ]);
  // items with a `camera`: the server takes out of a plugin's answer the items of cameras a limited person may not see
  // (plugin-camera-limit.ts), and leaves bare names as they are
  assert.deepEqual(content.camerasWithoutPeople, [{ camera: 'Гараж' }, { camera: 'Чердак' }]);
  assert.equal(result.references?.length, 3);
  const two = await nvr.callAssistantTool('person_route', { event: 'ev-two' }, ctx);
  assert.match((two.content as { hint?: string }).hint ?? '', /2 people/);
  assert.match((await nvr.callAssistantTool('person_route', {}, ctx)).error ?? '', /event is required/);
  assert.match((await nvr.callAssistantTool('person_route', { event: 'ev-car' }, ctx)).error ?? '', /no person to follow/);
  assert.match((await nvr.callAssistantTool('person_route', { event: 'nope' }, ctx)).error ?? '', /No event/);
}

// ---- a crowd dressed alike (a uniform): more moments alike than a route takes (the 500 most alike) is said, and the
// assistant gets the stays nearest the moment with how many there are — not 500 stays, 40 KB, into the model's context
{
  const GREEN = look(4, 5, 1);
  // five hours before 10:00, one every six seconds, door and lift by turns: each a stay of its own
  for (let i = 0; i < 520; i++) await moment(`crowd-${i}`, i % 2 ? 'lift' : 'door', -300 + i / 10, [person(1, GREEN)]);
  const route = await nvr.personRoute({ eventId: 'crowd-260' });
  assert.equal(route.capped, true, 'more alike than taken: said');
  assert.ok(route.visits.length > 400);
  assert.equal((await nvr.personRoute({ eventId: 'ev-door-1' })).capped, undefined, 'a route of a few');
  const ctx: AssistantToolContext = { userId: 'u1', role: 'admin', language: 'ru', timezone: 'Europe/Moscow' };
  const told = await nvr.callAssistantTool('person_route', { event: 'crowd-260' }, ctx);
  const content = told.content as { route: { event: string; asked?: true }[]; count?: number; cut?: string };
  assert.equal(content.route.length, 50);
  assert.equal(content.count, route.visits.length, 'how many there are');
  assert.ok(content.route.some((stay) => stay.asked), 'the moment asked among them');
  // the nearest the moment, in time order
  const index = content.route.map((stay) => Number(stay.event.split('-')[1]));
  assert.deepEqual(index, [...index].sort((a, b) => a - b));
  assert.ok(index.every((i) => Math.abs(i - 260) <= 40), JSON.stringify(index));
  assert.match(content.cut ?? '', /nearest/);
  assert.match(content.cut ?? '', /most alike/);
  assert.ok(JSON.stringify(told.content).length < 12_000, `${JSON.stringify(told.content).length} characters`);
  const few = (await nvr.callAssistantTool('person_route', { event: 'ev-door-1' }, ctx)).content as { count?: number; cut?: string };
  assert.deepEqual([few.count, few.cut], [undefined, undefined]);
}

console.log('person-route.spec: stays in time order, joined per camera, window, two people, nothing to follow, the assistant, a crowd OK');
process.exit(0);
