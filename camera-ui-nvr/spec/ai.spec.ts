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

const dir = mkdtempSync(join(tmpdir(), 'nvr-ai-'));
const noop = () => undefined;
const logger = { log: noop, warn: (...a: unknown[]) => console.warn('[warn]', ...a), error: console.error, debug: noop, attention: noop, trace: noop };
const api = {
  storagePath: dir,
  on: noop,
  once: noop,
  emit: noop,
  coreManager: {
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
const storage = { values: {}, getValue: async () => undefined, setValue: async () => undefined };

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
assert.equal(status.total, 3);
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

console.log('ai.spec: semantic search, re-index and faces OK');
process.exit(0);
