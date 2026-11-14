// A vector filed while the vectors of the table are still being read. The read goes by rowid, and a table without
// AUTOINCREMENT gives the rowid of a deleted last row out again: a portion that ended on the last row, that row deleted
// and a vector of a model the table did not have yet filed in its place, was past the read already, and the index of
// a new model was only made once the read was over. The vector was in the table and in no index until a restart: a
// search with it found nothing.
// Run: npx tsx spec/late-model.spec.ts
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { PersonIndex } from '../src/people.js';
import { SemanticIndex } from '../src/semantic.js';
import { loadIndexes } from '../src/vector-index.js';

import type { RecordedEvent } from '../src/types.js';
import type { VectorIndex } from '../src/vector-index.js';

const unit = (seed: number, dim: number): number[] => {
  const v = Array.from({ length: dim }, (_, i) => Math.sin(seed * (i + 1)));
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};
const blob = (v: number[]) => new Uint8Array(Float32Array.from(v).buffer);
const turn = () => new Promise((resolve) => setImmediate(resolve));

interface Loading {
  warming?: Promise<void>;
  warmed: boolean;
  indexes: Map<string, VectorIndex>;
}

/** Starts the read of a table on a clock of 6 ms a row (a slow disk): a portion is some 7 rows. */
function read(index: Loading, db: DatabaseSync, table: 'clip_vectors' | 'person_vectors'): void {
  let clock = 0;
  index.warming = loadIndexes(db, table, index.indexes, () => (clock += 6)).then(() => {
    index.warmed = true;
  });
}

// ---- the search by description
{
  const db = new DatabaseSync(':memory:');
  const semantic = new SemanticIndex(db);
  const loading = semantic as unknown as Loading;
  const insert = db.prepare('INSERT INTO clip_vectors (event_id, seg, attr, camera_id, ts, label, model, vec) VALUES (?, 0, 0, ?, ?, ?, ?, ?)');
  for (let i = 1; i <= 14; i++) insert.run(`e${i}`, 'door', 1000, '', 'clip', blob(unit(i, 16)));
  const clipEvent = (id: string, vec: number[], model: string) =>
    ({
      id,
      cameraId: 'door',
      startTime: 1000,
      state: 'ended',
      segments: [{ firstSeen: 1000, lastSeen: 1000, detections: [], attributes: [{ type: 'clip', clipEmbedding: vec, clipEmbeddingModel: model }] }],
    }) as unknown as RecordedEvent;

  read(loading, db, 'clip_vectors');
  // two portions: rows 1 to 7, then 8 to 14, the second ended by its time on the last row of the table
  for (let turns = 0; turns < 20 && loading.indexes.get('clip')?.count !== 14; turns++) await turn();
  assert.equal(loading.indexes.get('clip')?.count, 14, 'the check itself: every row is read');
  assert.equal(loading.warmed, false, 'the check itself: and the read goes on (it has not asked for more yet)');

  semantic.deleteEvents(['e14']);
  const target = unit(99, 16);
  semantic.ingest(clipEvent('switched', target, 'siglip'));
  const row = db.prepare("SELECT rowid AS id FROM clip_vectors WHERE event_id = 'switched'").get() as { id: number };
  assert.equal(Number(row.id), 14, 'the check itself: the new row has the rowid the read is past');

  await loading.warming;
  const found = await semantic.search([{ embedding: target, embeddingModel: 'siglip', scoreBand: [0, 1] }], 3);
  assert.deepEqual(
    found.map((hit) => hit.eventId),
    ['switched'],
    'the vector of the new model is found by a search with it',
  );
  assert.equal(loading.indexes.get('clip')?.count, 13, 'and the deleted row is in no index');
  db.close();
}

// ---- the people search keeps its indexes the same way
{
  const db = new DatabaseSync(':memory:');
  const people = new PersonIndex(db);
  const loading = people as unknown as Loading;
  const insert = db.prepare('INSERT INTO person_vectors (event_id, seg, track_id, camera_id, ts, model, vec) VALUES (?, 0, ?, ?, ?, ?, ?)');
  for (let i = 1; i <= 14; i++) insert.run(`e${i}`, i, 'door', 1000, 'reid', blob(unit(i, 8)));
  const personEvent = (id: string, vec: number[], model: string) =>
    ({
      id,
      cameraId: 'door',
      startTime: 2000,
      state: 'ended',
      segments: [{ firstSeen: 2000, lastSeen: 2000, detections: [], attributes: [], personEmbeddings: [{ trackId: 1, embedding: vec, embeddingModel: model }] }],
    }) as unknown as RecordedEvent;

  read(loading, db, 'person_vectors');
  for (let turns = 0; turns < 20 && loading.indexes.get('reid')?.count !== 14; turns++) await turn();
  assert.equal(loading.indexes.get('reid')?.count, 14);
  assert.equal(loading.warmed, false);

  people.deleteEvents(['e14']);
  const target = unit(77, 8);
  assert.equal(people.ingest(personEvent('newcomer', target, 'reid-v2')), 1, 'the check itself: the vector was filed');
  const row = db.prepare("SELECT rowid AS id FROM person_vectors WHERE event_id = 'newcomer'").get() as { id: number };
  assert.equal(Number(row.id), 14);

  await loading.warming;
  assert.equal(loading.indexes.get('reid-v2')?.count, 1, 'the vector of the new model is in its index');
  db.close();
}

console.log('late-model.spec: a vector of a new model filed while the table is read is in its index, a deleted row in none OK');
