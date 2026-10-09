// People who look alike, through the real NVR plugin class with a fake host API and a fake PersonEmbedding
// plugin: the person vectors of a segment are filed and never reach the event JSON, a search from a moment, a
// picture or a vector, its window, cameras, floor and models, and deleting.
// Run: npx tsx spec/people.spec.ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import VionNvr from '../src/index.js';

const DAY = 86_400_000;
const NOW = Date.now();
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
const RED_ISH = look(0, 1, 0.5); // 0.5
const BLUE = look(2, 3, 1); // 0

let pictureAnswer: () => Promise<unknown> = async () => [{ embedding: RED, embeddingModel: 'reid-test' }];
let embedders = 1;
const pictures: number[] = [];
const dir = mkdtempSync(join(tmpdir(), 'nvr-people-'));
const noop = () => undefined;
const warned: string[] = [];
const logger = { log: noop, warn: (...a: unknown[]) => void warned.push(a.join(' ')), error: console.error, debug: noop, attention: noop, trace: noop };
const api = {
  storagePath: dir,
  on: noop,
  once: noop,
  emit: noop,
  notificationManager: { publish: async () => undefined },
  coreManager: {
    getFFmpegPath: () => new Promise<string>(noop),
    getPluginsByInterface: async (iface: string) => (iface === 'PersonEmbedding' ? Array.from({ length: embedders }, (_, i) => ({ id: `ml${i}` })) : []),
  },
  proxy: {
    createProxy: () => ({
      embedPersonImages: async (images: Uint8Array[]) => {
        pictures.push(images[0]!.length);
        return pictureAnswer();
      },
    }),
  },
};
const storage = { values: {} as Record<string, unknown>, getValue: async () => undefined, setValue: async () => undefined };
const nvr = new VionNvr(logger as never, api as never, storage as never);

const sent: Record<string, unknown>[] = [];
await nvr.onDetectionEvent((message: unknown) => void sent.push(message as Record<string, unknown>));

type People = { trackId: number; embedding: number[]; embeddingModel: string }[];
function event(id: string, cameraId: string, at: number, people: People | undefined, segmentIndex = 0) {
  const segment = { firstSeen: at, lastSeen: at + 4000, zones: [], detections: [{ label: 'person', score: 0.9, trackId: 1 }], attributes: [], ...(people ? { personEmbeddings: people } : {}) };
  return { id, cameraId, state: 'ended', startTime: at, endTime: at + 5000, lastUpdate: at + 5000, types: ['object'], triggers: [], segmentIndex, segments: [segment] };
}
const person = (trackId: number, embedding: number[], embeddingModel = 'reid-test') => ({ trackId, embedding, embeddingModel });
const ingest = (cameraId: string, type: string, e: ReturnType<typeof event>) => nvr.ingestDetectionEvent(cameraId, type as never, e as never);

// ------------------------------------------------------------ filed, never in the event
await ingest('door', 'segment-end', event('ev-door', 'door', NOW - 2 * 3_600_000, [person(1, RED), person(2, BLUE)]));
const stored = await nvr.getEvent('ev-door');
assert.ok(stored, 'the event is stored');
assert.equal(stored.segments[0]!.personEmbeddings, undefined, 'no vector in the stored event');
assert.equal(stored.segments[0]!.personVectors, 2, 'it says how many people can be searched for');
const message = sent.at(-1)!.data as { segments: Record<string, unknown>[] };
assert.equal(message.segments[0]!.personEmbeddings, undefined, 'no vector to the listeners');
assert.equal(message.segments[0]!.personVectors, 2);

// the event's end repeats the segment without vectors: the number stays, in both shapes of the update
await ingest('door', 'end', event('ev-door', 'door', NOW - 2 * 3_600_000, undefined));
assert.equal((await nvr.getEvent('ev-door'))!.segments[0]!.personVectors, 2, 'an update of the segment keeps the number');
await nvr.ingestDetectionEvent('door', 'end' as never, { ...event('ev-door', 'door', NOW - 2 * 3_600_000, undefined), segmentIndex: undefined, segments: [{ firstSeen: NOW - 2 * 3_600_000, lastSeen: NOW, zones: [], detections: [], attributes: [] }, { firstSeen: NOW, lastSeen: NOW, zones: [], detections: [], attributes: [] }] } as never);
assert.equal((await nvr.getEvent('ev-door'))!.segments[0]!.personVectors, 2, 'an update with all segments keeps it too');
assert.equal((await nvr.getEvent('ev-door'))!.segments[1]!.personVectors, undefined);

// junk from a plugin is not filed
await ingest('door', 'segment-end', event('ev-junk', 'door', NOW - 3_600_000, [{ trackId: 1, embedding: [], embeddingModel: 'reid-test' }, { trackId: 2, embedding: [Number.NaN, 1], embeddingModel: 'reid-test' }, { trackId: 3, embedding: RED, embeddingModel: '' }] as People));
assert.equal((await nvr.getEvent('ev-junk'))!.segments[0]!.personVectors, undefined, 'unusable vectors are not counted');

// ------------------------------------------------------------ search from a recorded moment
await ingest('yard', 'segment-end', event('ev-yard', 'yard', NOW - 3_600_000, [person(5, RED_TOO)]));
await ingest('street', 'segment-end', event('ev-street', 'street', NOW - 1_800_000, [person(1, RED_ISH)]));
await ingest('street', 'segment-end', event('ev-blue', 'street', NOW - 1_700_000, [person(1, BLUE)]));
await ingest('yard', 'segment-end', event('ev-later', 'yard', NOW - 2 * 3_600_000 + 4 * DAY, [person(1, RED)]));
await ingest('yard', 'segment-end', event('ev-other-model', 'yard', NOW - 3_000_000, [person(1, RED, 'reid-other')]));
// two alike people in one moment: one match, with the better one
await ingest('lobby', 'segment-end', event('ev-pair', 'lobby', NOW - 2_000_000, [person(1, RED_ISH), person(2, RED_TOO)]));

const fromDoor = await nvr.searchSimilarQuery({ label: 'person', event: { eventId: 'ev-door', segment: 0, trackId: 1 } });
assert.equal(fromDoor.mode, 'person');
assert.deepEqual(
  fromDoor.matches.map((m) => [m.eventId, m.segment, m.score]),
  [
    ['ev-pair', 0, 0.9],
    ['ev-yard', 0, 0.9],
    ['ev-street', 0, 0.5],
  ],
  'best first (the newer of equals), one match per moment, never itself, nothing under the floor (blue), nothing of another model, nothing 4 days away',
);
assert.equal(fromDoor.matches[0]!.trackId, 2, 'the moment is matched by its better person');
assert.deepEqual(fromDoor.events.map((e) => e.id).sort(), ['ev-pair', 'ev-street', 'ev-yard'], 'the events of the matches come along');
assert.ok(fromDoor.events.every((e) => e.segments.every((s) => s.personEmbeddings === undefined)), 'and carry no vector');
assert.deepEqual(fromDoor.scoreBand, [0.4, 0.65]);
assert.ok(fromDoor.indexedSince !== undefined && fromDoor.indexedSince <= NOW - 2 * 3_600_000, 'it says since when people can be found');

// everyone of the moment, when no person is named: the blue one finds the blue one
const everyone = await nvr.searchSimilarQuery({ event: { eventId: 'ev-door', segment: 0 } });
assert.ok(everyone.matches.some((m) => m.eventId === 'ev-blue') && everyone.matches.some((m) => m.eventId === 'ev-yard'));

// the window, the cameras, the floor, the limit
const wide = await nvr.searchSimilarQuery({ event: { eventId: 'ev-door', segment: 0, trackId: 1 } }, { startMs: NOW - DAY, endMs: NOW + 5 * DAY });
assert.ok(wide.matches.some((m) => m.eventId === 'ev-later'), 'a window asked for wins over the default three days');
const yardOnly = await nvr.searchSimilarQuery({ event: { eventId: 'ev-door', segment: 0, trackId: 1 } }, { cameraIds: ['yard'] });
assert.deepEqual(yardOnly.matches.map((m) => m.eventId), ['ev-yard']);
const noCamera = await nvr.searchSimilarQuery({ event: { eventId: 'ev-door', segment: 0, trackId: 1 } }, { cameraIds: [] });
assert.deepEqual([noCamera.mode, noCamera.matches], ['person', []], 'no cameras find nobody');
const strict = await nvr.searchSimilarQuery({ event: { eventId: 'ev-door', segment: 0, trackId: 1 } }, { minScore: 0.8 });
assert.deepEqual(strict.matches.map((m) => m.eventId), ['ev-pair', 'ev-yard']);
const loose = await nvr.searchSimilarQuery({ event: { eventId: 'ev-door', segment: 0, trackId: 1 } }, { minScore: -1 });
assert.ok(!loose.matches.some((m) => m.eventId === 'ev-blue'), 'never below the floor of the band');
const one = await nvr.searchSimilarQuery({ event: { eventId: 'ev-door', segment: 0, trackId: 1 } }, { limit: 1 });
assert.deepEqual(one.matches.map((m) => m.eventId), ['ev-pair']);
const favouritesOnly = await nvr.searchSimilarQuery({ event: { eventId: 'ev-door', segment: 0, trackId: 1 } }, { filter: { favoritesOnly: true } });
assert.deepEqual(favouritesOnly.matches, [], "the page's event filter applies");
const byText = async (search: string) => (await nvr.searchSimilarQuery({ event: { eventId: 'ev-door', segment: 0, trackId: 1 } }, { filter: { search } })).matches.length;
assert.deepEqual([await byText('person'), await byText('грузовик')], [3, 0], 'the content of the filter too');

// a moment without people, another kind of search
assert.equal((await nvr.searchSimilarQuery({ event: { eventId: 'ev-junk', segment: 0 } })).reason, 'no-vectors');
assert.equal((await nvr.searchSimilarQuery({ label: 'face', event: { eventId: 'ev-door', segment: 0 } })).reason, 'unsupported');
assert.equal((await nvr.searchSimilarQuery({})).reason, 'unsupported');

// ------------------------------------------------------------ a vector, a picture
const byVector = await nvr.searchSimilarQuery({ person: RED, personModel: 'reid-test' });
assert.ok(byVector.matches.some((m) => m.eventId === 'ev-door'), 'a vector searches the last seven days');
assert.equal((await nvr.searchSimilarQuery({ person: RED, personModel: 'reid-unknown' })).reason, 'model-mismatch');

const picture = new Uint8Array([0xff, 0xd8, 1, 2, 3]);
const byPicture = await nvr.searchSimilarQuery({ image: picture });
assert.ok(byPicture.matches[0]?.eventId === 'ev-door' && pictures.length === 1, 'a picture is made a vector by the plugin');
pictureAnswer = async () => [{ embedding: RED, embeddingModel: 'reid-unknown' }];
assert.equal((await nvr.searchSimilarQuery({ image: picture })).reason, 'model-mismatch', 'a model with no stored people');
pictureAnswer = async () => [{ embedding: [], embeddingModel: 'reid-test' }];
assert.equal((await nvr.searchSimilarQuery({ image: picture })).reason, 'no-person', 'nobody in the picture');
pictureAnswer = async () => {
  throw new Error('model not loaded');
};
assert.equal((await nvr.searchSimilarQuery({ image: picture })).reason, 'no-embedder', 'a plugin that failed');
assert.ok(warned.some((w) => w.includes('model not loaded')), 'and the failure is logged');
embedders = 0;
assert.equal((await nvr.searchSimilarQuery({ image: picture })).reason, 'no-embedder', 'no plugin at all');
embedders = 2;
let calls = 0;
pictureAnswer = async () => (++calls === 1 ? [{ embedding: RED, embeddingModel: 'reid-unknown' }] : [{ embedding: RED, embeddingModel: 'reid-test' }]);
assert.equal((await nvr.searchSimilarQuery({ image: picture })).mode, 'person', 'the plugin whose model has people is used');

// searches asked together all answer
const together = await Promise.all([1, 2, 3].map(() => nvr.searchSimilarQuery({ event: { eventId: 'ev-door', segment: 0, trackId: 1 } })));
assert.ok(together.every((r) => r.matches[0]?.eventId === 'ev-pair' && r.matches.length === 3));

// ------------------------------------------------------------ deleting
await nvr.deleteEvents(['ev-yard']);
assert.ok(!(await nvr.searchSimilarQuery({ event: { eventId: 'ev-door', segment: 0, trackId: 1 } })).matches.some((m) => m.eventId === 'ev-yard'), 'a deleted event takes its people');
// read from the database itself: the search hides a deleted event anyway, the vectors must be gone too
const db = new DatabaseSync(join(dir, 'nvr.db'), { readOnly: true });
const rows = (eventId: string) => Number((db.prepare('SELECT COUNT(*) AS n FROM person_vectors WHERE event_id = ?').get(eventId) as { n: number }).n);
assert.equal(rows('ev-yard'), 0, 'no vector of a deleted event stays on the disk');
assert.equal(rows('ev-door'), 2);

// the people of moments older than the setting go, the events stay (favourites too)
await ingest('yard', 'segment-end', event('ev-old', 'yard', NOW - 10 * DAY, [person(1, RED)]));
await nvr.setEventFavorite('ev-old', true);
storage.values.personSearchDays = 7;
await (nvr as unknown as { enforceRetention(): Promise<void> }).enforceRetention();
assert.ok(await nvr.getEvent('ev-old'), 'the event stays');
assert.equal((await nvr.searchSimilarQuery({ event: { eventId: 'ev-old', segment: 0 } })).reason, 'no-vectors', 'its people are gone');
assert.ok((await nvr.searchSimilarQuery({ event: { eventId: 'ev-door', segment: 0 } })).matches.length > 0, 'newer people stay');
storage.values.personSearchDays = 0;
await ingest('yard', 'segment-end', event('ev-old2', 'yard', NOW - 10 * DAY, [person(1, RED)]));
await (nvr as unknown as { enforceRetention(): Promise<void> }).enforceRetention();
assert.equal((await nvr.searchSimilarQuery({ event: { eventId: 'ev-old2', segment: 0 } })).mode, 'person', '0 keeps them as long as the events');

// the button deletes them all
const clear = nvr.storageSchema.find((f) => f.key === 'personSearchClear') as { onSet: () => Promise<void> };
await clear.onSet();
assert.equal((await nvr.searchSimilarQuery({ event: { eventId: 'ev-door', segment: 0 } })).reason, 'no-vectors');
assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM person_vectors').get() as { n: number }).n), 0, 'nothing left on the disk');
assert.ok(await nvr.getEvent('ev-door'), 'the events stay');

assert.equal((await nvr.getNvrFeatures()).personSearch, true);
console.log('people.spec: filed not stored, the count kept, search from a moment, a vector and a picture, window, cameras, floor, models, deleting OK');
process.exit(0);
