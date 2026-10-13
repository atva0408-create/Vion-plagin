// The searches over the archive on their compact indexes (src/semantic.ts, src/people.ts, src/vector-index.ts): with
// more vectors than the candidates scored, the best match is still found with its exact score; the indexes follow
// what is written, replaced and deleted without being read again; a row written while they are read at start is
// indexed once; a model first seen after that is searched too; the window and cameras of the people search hold.
// Run: npx tsx spec/vector-search.spec.ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { PersonIndex } from '../src/people.js';
import { SemanticIndex } from '../src/semantic.js';
import { toBlob } from '../src/vectors.js';

import type { RecordedEvent } from '../src/types.js';

let seed = 777;
const random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const gaussian = () => Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random());
const unit = (v: number[]) => {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
};
const randomUnit = (d: number) => unit(Array.from({ length: d }, gaussian));
const near = (v: number[], noise: number) => unit(v.map((x) => x + noise * gaussian()));
const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);

const T0 = Date.parse('2026-10-01T00:00:00Z');
const db = () => new DatabaseSync(join(mkdtempSync(join(tmpdir(), 'nvr-vsearch-')), 'nvr.db'));

/** An event of one segment carrying a CLIP vector of `model`. */
function clipEvent(id: string, vec: number[], model = 'clip', camera = 'door'): RecordedEvent {
  return {
    id,
    cameraId: camera,
    startTime: T0,
    segments: [{ firstSeen: T0, lastSeen: T0, detections: [{ label: 'person' }], attributes: [{ type: 'clip', clipEmbedding: vec, clipEmbeddingModel: model }] }],
  } as unknown as RecordedEvent;
}

/** An event of one segment carrying a person vector. */
function personEvent(id: string, vec: number[], at: number, camera: string): RecordedEvent {
  return {
    id,
    cameraId: camera,
    startTime: at,
    segments: [{ firstSeen: at, lastSeen: at, detections: [], attributes: [], personEmbeddings: [{ trackId: 1, embedding: vec, embeddingModel: 'reid' }] }],
  } as unknown as RecordedEvent;
}

/** Fills a table straight with `n` random vectors (as a long-running recorder has them), `last` the last one. */
function fill(sql: DatabaseSync, table: 'clip_vectors' | 'person_vectors', n: number, d: number, last?: number[]): void {
  sql.exec('BEGIN');
  const insert =
    table === 'clip_vectors'
      ? sql.prepare("INSERT INTO clip_vectors (event_id, seg, attr, camera_id, ts, label, model, vec) VALUES (?, 0, 0, 'lift', ?, 'person', 'clip', ?)")
      : sql.prepare("INSERT INTO person_vectors (event_id, seg, track_id, camera_id, ts, model, vec) VALUES (?, 0, 1, 'lift', ?, 'reid', ?)");
  for (let i = 0; i < n; i++) insert.run(`r${i}`, T0 + i * 1000, toBlob(i === n - 1 && last ? last : randomUnit(d)));
  sql.exec('COMMIT');
}

// ---- a search with nothing read yet waits for the read, the last portion of the table included
{
  const sql = db();
  const semantic = new SemanticIndex(sql);
  const people = new PersonIndex(sql);
  const old = randomUnit(512);
  fill(sql, 'clip_vectors', 12_000, 512, near(old, 0.04));
  const found = await semantic.search([{ embedding: old, embeddingModel: 'clip', scoreBand: [0, 1] }], 1);
  assert.equal(found[0]?.eventId, 'r11999', 'the 12 000th row of the table: read in the third portion');
  const person = randomUnit(256);
  fill(sql, 'person_vectors', 7000, 256, near(person, 0.05));
  const hits = await people.search([{ model: 'reid', vec: Float32Array.from(person) }], { fromMs: 0, toMs: Number.MAX_SAFE_INTEGER, minScore: 0.4, limit: 5 });
  assert.equal(hits[0]?.eventId, 'r6999');
}

// ---- the search by description
{
  const sql = db();
  const semantic = new SemanticIndex(sql);
  fill(sql, 'clip_vectors', 12_000, 512);
  const query = randomUnit(512);
  const target = near(query, 0.04);
  // written while the index is read at start (12 000 rows: three portions, the reading gives way in between)
  const warming = semantic.warm();
  semantic.ingest(clipEvent('during', target));
  await warming;
  const band: [number, number] = [0, 1];
  const found = await semantic.search([{ embedding: query, embeddingModel: 'clip', scoreBand: band }], 5);
  assert.equal(found[0].eventId, 'during', 'written during the read: found, among 12 001');
  assert.equal(found[0].score, Math.round(dot(query, target) * 1000) / 1000, 'its exact score');
  assert.equal(found.filter((r) => r.eventId === 'during').length, 1, 'indexed once');

  // replaced: the old vector goes, the new one is found
  semantic.ingest(clipEvent('during', randomUnit(512)));
  semantic.ingest(clipEvent('later', target));
  const after = await semantic.search([{ embedding: query, embeddingModel: 'clip', scoreBand: band }], 5);
  assert.equal(after[0].eventId, 'later');
  assert.ok(!after.slice(0, 2).some((r) => r.eventId === 'during' && r.score > 0.5), 'the replaced vector is not found');
  // deleted: gone at once
  semantic.deleteEvents(['later']);
  const gone = await semantic.search([{ embedding: query, embeddingModel: 'clip', scoreBand: band }], 5);
  assert.ok(gone.every((r) => r.eventId !== 'later'));
  // a whole-picture vector of a motion-only event, added after the read
  semantic.addScene({ id: 'scene', cameraId: 'yard', startTime: T0, label: '' }, 'clip', target);
  assert.equal((await semantic.search([{ embedding: query, embeddingModel: 'clip', scoreBand: band }], 1))[0].eventId, 'scene');
  // a model first seen after the read
  const other = randomUnit(768);
  semantic.ingest(clipEvent('siglip', other, 'siglip'));
  assert.equal((await semantic.search([{ embedding: other, embeddingModel: 'siglip', scoreBand: band }], 1))[0]?.eventId, 'siglip');
}

// ---- the people search
{
  const sql = db();
  const people = new PersonIndex(sql);
  fill(sql, 'person_vectors', 8000, 256);
  const query = randomUnit(256);
  await people.warm();
  // the same person on the door camera inside the window, on the lift camera inside it, and on the door a day later
  const window = { fromMs: T0, toMs: T0 + 9000 * 1000 };
  people.ingest(personEvent('door-in', near(query, 0.05), T0 + 5000 * 1000, 'door'));
  people.ingest(personEvent('lift-in', near(query, 0.05), T0 + 6000 * 1000, 'lift'));
  people.ingest(personEvent('door-late', near(query, 0.05), T0 + 86_400_000 * 2, 'door'));
  const search = (o: Partial<Parameters<PersonIndex['search']>[1]>) => people.search([{ model: 'reid', vec: Float32Array.from(query) }], { ...window, minScore: 0.4, limit: 50, ...o });
  assert.deepEqual((await search({})).map((h) => h.eventId).sort(), ['door-in', 'lift-in'], 'among 8003, within the window');
  assert.deepEqual((await search({ cameraIds: new Set(['door']) })).map((h) => h.eventId), ['door-in'], 'the door only');
  assert.deepEqual((await search({ exclude: { eventId: 'door-in', seg: 0 } })).map((h) => h.eventId), ['lift-in'], 'never a match of itself');
  assert.deepEqual((await search({ fromMs: 0, toMs: Number.MAX_SAFE_INTEGER })).map((h) => h.eventId).sort(), ['door-in', 'door-late', 'lift-in']);
  // the old moments go with their days
  people.deleteBefore(T0 + 5500 * 1000);
  assert.deepEqual((await search({})).map((h) => h.eventId), ['lift-in']);
  people.deleteEvents(['lift-in']);
  assert.deepEqual(await search({}), []);
  people.clear();
  people.ingest(personEvent('after-clear', near(query, 0.05), T0, 'door'));
  assert.deepEqual((await search({})).map((h) => h.eventId), ['after-clear'], 'filed again after everything was cleared');
}

// ---- a short window (a route's stays and hops: minutes) is read from the table by its time index, every row of it
// scored exactly; the index, which scores every vector it holds, is asked only when the window holds more rows than the
// candidates. A route asks ~80 such windows: over the index they held the recorder half a second on 400 000 vectors.
{
  const sql = db();
  const people = new PersonIndex(sql);
  fill(sql, 'person_vectors', 8000, 256);
  const query = randomUnit(256);
  await people.warm();
  people.ingest(personEvent('door-in', near(query, 0.05), T0 + 5000 * 1000 + 500, 'door'));
  people.ingest(personEvent('lift-in', near(query, 0.05), T0 + 5100 * 1000 + 500, 'lift'));
  const index = (people as unknown as { indexes: Map<string, { candidates: (...args: unknown[]) => Promise<number[]> }> }).indexes.get('reid')!;
  const candidates = index.candidates.bind(index);
  let asked = 0;
  index.candidates = (...args: unknown[]) => {
    asked++;
    return candidates(...args);
  };
  const search = (fromMs: number, toMs: number, o: Partial<Parameters<PersonIndex['search']>[1]> = {}) =>
    people.search([{ model: 'reid', vec: Float32Array.from(query) }], { fromMs, toMs, minScore: 0.4, limit: 50, ...o });
  // three minutes: 180 rows of the table
  assert.deepEqual((await search(T0 + 4990 * 1000, T0 + 5170 * 1000)).map((h) => h.eventId).sort(), ['door-in', 'lift-in']);
  assert.deepEqual((await search(T0 + 4990 * 1000, T0 + 5170 * 1000, { cameraIds: new Set(['lift']) })).map((h) => h.eventId), ['lift-in']);
  assert.deepEqual((await search(T0 + 4990 * 1000, T0 + 5170 * 1000, { exclude: { eventId: 'door-in', seg: 0 } })).map((h) => h.eventId), ['lift-in']);
  assert.equal(asked, 0, 'a short window is not scored over the whole index');
  // every row: more than the candidates, the index is asked
  assert.deepEqual((await search(0, Number.MAX_SAFE_INTEGER)).map((h) => h.eventId).sort(), ['door-in', 'lift-in']);
  assert.equal(asked, 1);
}

console.log('vector-search.spec: best of many with its exact score, written/replaced/deleted in step, written while read, new model, window and cameras, short windows from the table — ok');
