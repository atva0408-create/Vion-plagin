// Semantic search and faces through the real NVR plugin class, with a fake host API and fake CLIP /
// face-embedding plugins. Run: npx tsx spec/ai.spec.ts
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import VionNvr from '../src/index.js';

const dim = 16;
/** Deterministic unit-ish vector for a concept, with a little noise per sample. */
function vec(concept: number, noise = 0, seed = 1): number[] {
  const v = Array.from({ length: dim }, (_, i) => (i === concept ? 1 : 0));
  for (let i = 0; i < dim; i++) v[i]! += noise * Math.sin(seed * (i + 1) * 12.9898);
  return v;
}
const CONCEPTS: Record<string, number> = { 'white van': 0, person: 1, dog: 2, 'a photo': 3 };

const clipCalls: string[] = [];
const clip = {
  getTextEmbeddings: async (text: string) => {
    clipCalls.push(text);
    return [{ embedding: vec(CONCEPTS[text] ?? 5), embeddingModel: 'clip-test', scoreBand: [0.1, 0.9] as [number, number] }];
  },
  getTextEmbedding: async (text: string) => ({ embedding: vec(CONCEPTS[text] ?? 5), embeddingModel: 'clip-test', scoreBand: [0.1, 0.9] as [number, number] }),
  embedImages: async (images: Uint8Array[]) => images.map(() => ({ embeddings: [{ embedding: vec(2) }], embeddingModel: 'clip-test', scoreBand: [0.1, 0.9] })),
};
const faceEmbedder = {
  embedFaceImages: async (images: Uint8Array[]) => images.map((img) => ({ embedding: vec(img[0] === 7 ? 9 : 10), embeddingModel: 'arcface-test', quality: 0.9 })),
};

const asked: { prompt: string; images: number; system: string }[] = [];
const published: Record<string, unknown>[] = [];
let allowed = true;
const assistant = {
  assistantAccess: async () => ({ allowed, model: 'qwen2.5-vl', vision: true, language: 'ru' }),
  assistantAsk: async (req: { prompt: string; system: string; images?: unknown[] }) => {
    asked.push({ prompt: req.prompt, images: req.images?.length ?? 0, system: req.system });
    const courier = req.prompt.includes('Подъезд');
    return {
      ok: true,
      text: '',
      json: courier
        ? { title: 'Курьер оставил посылку', description: 'Курьер в синей куртке оставил коробку у двери и ушёл.', tags: ['курьер', 'посылка', 'дверь'] }
        : { title: 'Белый фургон у ворот', description: 'Белый фургон остановился у ворот.', tags: ['фургон', 'белый', 'ворота'] },
      usage: { promptTokens: 1, completionTokens: 1 },
    };
  },
};

const dir = mkdtempSync(join(tmpdir(), 'nvr-ai-'));
const noop = () => undefined;
const logger = { log: noop, warn: (...a: unknown[]) => console.warn('[warn]', ...a), error: console.error, debug: noop, attention: noop, trace: noop };
const api = {
  storagePath: dir,
  on: noop,
  once: noop,
  emit: noop,
  notificationManager: { publish: async (n: Record<string, unknown>) => void published.push(n) },
  coreManager: {
    ...assistant,
    getFFmpegPath: () => new Promise<string>(noop),
    getPluginsByInterface: async (iface: string) => (iface === 'ClipDetection' ? [{ id: 'onnx' }] : iface === 'FaceEmbedding' ? [{ id: 'onnx' }] : []),
  },
  proxy: {
    createProxy: (ns: string) => {
      assert.equal(ns, 'plugin.onnx.child.rpc');
      return { ...clip, ...faceEmbedder };
    },
  },
};
const storage = { values: {} as Record<string, unknown>, getValue: async () => undefined, setValue: async () => undefined };

const nvr = new VionNvr(logger as never, api as never, storage as never);

const jpeg = (b: number) => new Uint8Array([b, 0xff, 0xd8, 1, 2, 3]);
function event(id: string, cameraId: string, startTime: number, attrs: Record<string, unknown>[], label = 'vehicle') {
  return {
    id,
    cameraId,
    state: 'ended',
    startTime,
    endTime: startTime + 5000,
    lastUpdate: startTime + 5000,
    types: ['object'],
    triggers: [],
    segmentIndex: 0,
    segments: [{ firstSeen: startTime, lastSeen: startTime + 5000, zones: [], detections: [{ label, score: 0.9, trackId: 1 }], attributes: attrs }],
  };
}

// --------------------------------------------------------------- ingest
await nvr.ingestDetectionEvent(
  'cam1',
  'end' as never,
  event('ev-van', 'cam1', 1_000, [{ type: 'clip', label: 'clip', clipEmbedding: vec(0, 0.05), clipEmbeddingModel: 'clip-test', parentTrackId: 1 }]) as never,
);
await nvr.ingestDetectionEvent(
  'cam2',
  'end' as never,
  event(
    'ev-person',
    'cam2',
    2_000,
    [
      { type: 'clip', label: 'clip', clipEmbedding: vec(1, 0.05), clipEmbeddingModel: 'clip-test', parentTrackId: 1 },
      { type: 'face', label: 'unknown', confidence: 0.8, embedding: vec(9, 0.05, 2), embeddingModel: 'arcface-test', parentTrackId: 1 },
      { type: 'license_plate', label: 'A123BC77', confidence: 0.9 },
    ],
    'person',
  ) as never,
  { attributes: [undefined, jpeg(1), jpeg(2)] } as never,
);
// an event without any picture/vector, for the re-index
await nvr.ingestDetectionEvent('cam1', 'end' as never, event('ev-old', 'cam1', 500, [], 'animal') as never, { scene: jpeg(3) } as never);

// vectors never reach the stored / UI-bound event
const { events } = await nvr.getEvents({ limit: 10 } as never);
const person = events.find((e) => e.id === 'ev-person')!;
assert.ok(person);
for (const a of person.segments[0]!.attributes) {
  assert.equal((a as Record<string, unknown>).clipEmbedding, undefined);
  assert.equal((a as Record<string, unknown>).embedding, undefined);
}

// attribute crops are stored under the keys the UI parses
const thumbs = await nvr.getEventThumbnails('cam2', 0, 'ev-person');
assert.deepEqual(Object.keys(thumbs.attributes ?? {}).sort(), ['0:face.1', '0:plate:A123BC77']);

// ------------------------------------------------------- semantic search
const van = await nvr.searchEventsByText('white van');
assert.equal(van[0]?.eventId, 'ev-van');
assert.equal(van[0]?.cameraId, 'cam1');
assert.ok(van[0]!.score > 0.8, `score ${van[0]?.score}`);
assert.equal(van[0]?.label, 'vehicle');
const people = await nvr.searchEventsByText('person', 10, 0.5);
assert.deepEqual(
  people.map((r) => r.eventId),
  ['ev-person'],
);
assert.deepEqual(await nvr.searchEventsByText('   '), []);

// re-index embeds the stored picture of the event that had no vector
const done = new Promise<void>((resolve) => void nvr.onClipReindex((s) => !s.running && s.total > 0 && resolve()));
await nvr.startClipReindex();
await done;
const status = await nvr.getClipReindexStatus();
assert.equal(status.error, undefined);
// the one event without a vector is the work; the events that had one are neither work nor failures
assert.deepEqual({ total: status.total, done: status.done, skipped: status.skipped }, { total: 1, done: 1, skipped: 0 });
// run again: nothing to do, which the dialog says as "up to date"
const again = new Promise<void>((resolve) => void nvr.onClipReindex((s) => !s.running && resolve()));
await nvr.startClipReindex();
await again;
const second = await nvr.getClipReindexStatus();
assert.deepEqual({ total: second.total, done: second.done, skipped: second.skipped, error: second.error }, { total: 0, done: 0, skipped: 0, error: undefined });
const dogs = await nvr.searchEventsByText('dog', 10, 0.5);
assert.deepEqual(
  dogs.map((r) => r.eventId),
  ['ev-old'],
);

// ------------------------------------------------------------------ faces
let unknown = await nvr.getUnknownFaces();
assert.equal(unknown.length, 1);
assert.equal(unknown[0]!.cameraId, 'cam2');
assert.deepEqual([...unknown[0]!.thumbnail!], [...jpeg(1)]);
assert.deepEqual(await nvr.matchFaces([vec(9)], 'arcface-test', 'balanced'), [null]);

// naming the unknown face teaches the person and relabels the event
await nvr.enrollFromEvent('Иван', unknown[0]!.id);
assert.equal((await nvr.getUnknownFaces()).length, 0);
const known = await nvr.listKnownFaces();
assert.equal(known.length, 1);
assert.equal(known[0]!.name, 'Иван');
assert.equal(known[0]!.imageCount, 1);
const [match] = await nvr.matchFaces([vec(9, 0.05, 3)], 'arcface-test', 'balanced');
assert.equal(match?.identity, 'Иван');
assert.deepEqual(await nvr.matchFaces([vec(9)], 'other-model', 'balanced'), [null]);
// the answer the server of 2.3.0 asks for: the same person, and for a stranger whom they came closest to
assert.equal((await nvr.matchFacesNearest([vec(9, 0.05, 3)], 'arcface-test', 'balanced'))[0]?.identity, 'Иван');
const [stranger] = await nvr.matchFacesNearest([vec(4)], 'arcface-test', 'balanced');
assert.deepEqual([stranger?.identity, stranger?.closest], [undefined, 'Иван']);
let relabeled = (await nvr.getEvents({ limit: 10 } as never)).events.find((e) => e.id === 'ev-person')!;
assert.equal(relabeled.segments[0]!.attributes[1]!.label, 'Иван');

// enrolling from a photo goes through the face-embedding plugin
await nvr.enrollFace('Мария', jpeg(8));
assert.equal((await nvr.listKnownFaces()).length, 2);
assert.equal((await nvr.getFaceImages('Мария')).length, 1);

// a wrong name corrected in the event teaches the right person
assert.equal(await nvr.reassignEventFace('ev-person', 0, 'Иван', 'Мария', { attrIndex: 1 }), 1);
relabeled = (await nvr.getEvents({ limit: 10 } as never)).events.find((e) => e.id === 'ev-person')!;
assert.equal(relabeled.segments[0]!.attributes[1]!.label, 'Мария');
assert.equal((await nvr.getFaceImages('Мария')).length, 2);

// unknown faces cluster; ignoring a cluster drops look-alikes that come later
for (const [i, id] of ['ev-a', 'ev-b'].entries()) {
  await nvr.ingestDetectionEvent(
    'cam1',
    'end' as never,
    event(id, 'cam1', 3_000 + i, [{ type: 'face', label: 'unknown', embedding: vec(12, 0.05, 10 + i), embeddingModel: 'arcface-test' }], 'person') as never,
  );
}
unknown = await nvr.getUnknownFaces();
assert.equal(unknown.length, 2);
assert.ok(unknown[0]!.clusterId && unknown[0]!.clusterId === unknown[1]!.clusterId, 'look-alikes share a cluster');
await nvr.ignoreUnknownFacesByCluster(unknown[0]!.clusterId!);
assert.equal((await nvr.getUnknownFaces()).length, 0);
assert.equal((await nvr.listIgnoredFaces()).length, 2);
await nvr.ingestDetectionEvent(
  'cam1',
  'end' as never,
  event('ev-c', 'cam1', 4_000, [{ type: 'face', label: 'unknown', embedding: vec(12, 0.05, 30), embeddingModel: 'arcface-test' }], 'person') as never,
);
assert.equal((await nvr.getUnknownFaces()).length, 0, 'ignored look-alike is not listed again');

// rescan: an unknown face that now matches somebody is named in its event
await nvr.ingestDetectionEvent(
  'cam2',
  'end' as never,
  event('ev-d', 'cam2', 5_000, [{ type: 'face', label: 'unknown', embedding: vec(10, 0.05, 40), embeddingModel: 'arcface-test' }], 'person') as never,
);
assert.equal((await nvr.getUnknownFaces()).length, 1);
assert.equal(await nvr.rescanFaces(), 1);
relabeled = (await nvr.getEvents({ limit: 20 } as never)).events.find((e) => e.id === 'ev-d')!;
assert.equal(relabeled.segments[0]!.attributes[0]!.label, 'Мария');

// deleting events removes their vectors and pending faces
await nvr.deleteEvents(['ev-van']);
assert.ok(!(await nvr.searchEventsByText('white van', 10, 0.5)).some((r) => r.eventId === 'ev-van'));
await nvr.deleteFace('Иван');
assert.deepEqual(
  (await nvr.listKnownFaces()).map((f) => f.name),
  ['Мария'],
);
assert.ok(existsSync(join(dir, 'faces', 'known')));
assert.equal(readdirSync(join(dir, 'faces', 'known')).length, (await nvr.getFaceImages('Мария')).length);

// --------------------------------------------------------- AI descriptions
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// off by default: nothing is sent to the model
await nvr.ingestDetectionEvent('cam1', 'end' as never, event('ev-off', 'cam1', 6_000, [], 'person') as never, { scene: jpeg(4) } as never);
await sleep(50);
assert.equal(asked.length, 0);

storage.values = { aiDescriptions: true, aiNotify: true, aiMaxPerHour: 2 };
(nvr as unknown as { cameras: Map<string, unknown> }).cameras.set('cam9', { device: { name: 'Подъезд' }, recorders: new Map(), subscriptions: [] });
await nvr.ingestDetectionEvent('cam9', 'end' as never, event('ev-courier', 'cam9', 7_000, [], 'person') as never, { scene: jpeg(5), card: jpeg(6) } as never);
for (let i = 0; i < 50 && !published.length; i++) await sleep(20);
assert.equal(asked.length, 1);
assert.equal(asked[0]!.images, 1, 'the segment card goes to the model');
assert.match(asked[0]!.prompt, /Камера: Подъезд/);
assert.match(asked[0]!.prompt, /человек/);
assert.match(asked[0]!.system, /на русском/);
const described = (await nvr.getEvents({ limit: 50 } as never)).events.find((e) => e.id === 'ev-courier')!;
assert.equal(described.ai?.title, 'Курьер оставил посылку');
assert.equal(described.ai?.model, 'qwen2.5-vl');
assert.equal(published.length, 1);
assert.equal(published[0]!.title, 'Подъезд: Курьер оставил посылку');
assert.equal(published[0]!.deepLink, '/cameras/%D0%9F%D0%BE%D0%B4%D1%8A%D0%B5%D0%B7%D0%B4?startTs=7000');

// Russian search finds it by the description (different word forms), with no picture vector at all
const byText = await nvr.searchEventsByText('курьера с посылкой', 10, 0.5);
assert.equal(byText[0]?.eventId, 'ev-courier');
assert.equal(byText[0]?.cameraId, 'cam9');
// the plain event list search also sees descriptions
assert.ok((await nvr.getEvents({ limit: 50, search: 'посылку' } as never)).events.some((e) => e.id === 'ev-courier'));

// hybrid: a picture match plus a text match ranks above either alone
await nvr.ingestDetectionEvent(
  'cam1',
  'end' as never,
  event('ev-van2', 'cam1', 8_000, [{ type: 'clip', label: 'clip', clipEmbedding: vec(0, 0.05, 7), clipEmbeddingModel: 'clip-test', parentTrackId: 1 }]) as never,
  { card: jpeg(7) } as never,
);
for (let i = 0; i < 50 && asked.length < 2; i++) await sleep(20);
await sleep(30);
const hybrid = await nvr.searchEventsByText('white van', 10, 0.5);
const pictureOnly = hybrid.find((r) => r.eventId === 'ev-van2');
assert.ok(pictureOnly, 'found by picture');
const both = await nvr.searchEventsByText('фургон', 10, 0);
assert.equal(both[0]?.eventId, 'ev-van2');

// hourly budget: the third event this hour is not described
await nvr.ingestDetectionEvent('cam1', 'end' as never, event('ev-over', 'cam1', 9_000, [], 'person') as never, { card: jpeg(8) } as never);
await sleep(100);
assert.equal(asked.length, 2);

// not allowed to use the model: nothing is asked, the manual action returns nothing
allowed = false;
storage.values = { aiDescriptions: true, aiMaxPerHour: 0 };
assert.equal(await nvr.describeEvent('ev-over'), undefined);
assert.equal(asked.length, 2);
allowed = true;
const manual = await nvr.describeEvent('ev-over');
assert.equal(manual?.title, 'Белый фургон у ворот');
assert.equal(asked.length, 3);

// deleting the event removes it from the text index
await nvr.deleteEvents(['ev-courier']);
assert.ok(!(await nvr.searchEventsByText('курьер', 10, 0)).some((r) => r.eventId === 'ev-courier'));

console.log('ai.spec: semantic search, re-index, faces and AI descriptions OK');
process.exit(0);
