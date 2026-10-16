// The events the search by description cannot find yet (SemanticIndex.unindexed), looked for every two minutes: which
// ones, and read from indexes alone. The look asked each event's vectors by their model (every vector of the model
// read, with its picture's vector, for every event): 12.5 s on the bench's 4 097 events and 3 725 vectors with a warm
// cache, minutes on its cold HDD after a start, the recorder's one thread held meanwhile (2026-10-16 14:28-14:29).
// Run: npx tsx spec/unindexed.spec.ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SemanticIndex } from '../src/semantic.js';
import { Store } from '../src/store.js';

import type { RecordedEvent } from '../src/types.js';

const dir = mkdtempSync(join(tmpdir(), 'nvr-unindexed-'));
const store = new Store(join(dir, 'nvr.db'));
const semantic = new SemanticIndex(store.sql);
const MODEL = 'clip-vit-base-patch32';
const T0 = 1_760_000_000_000;

const event = (id: string, startTime: number, state = 'ended') =>
  ({ id, cameraId: 'cam', state, startTime, endTime: startTime + 5000, lastUpdate: startTime + 5000, types: ['person'], triggers: [], segments: [] }) as unknown as RecordedEvent;
store.sql.exec('BEGIN');
for (let i = 0; i < 400; i++) {
  store.upsertEvent(event(`e${i}`, T0 + i * 60_000));
  // every event but each tenth has its picture's vector; e5 only one of another model
  if (i % 10 !== 0 && i !== 5) semantic.addScene({ id: `e${i}`, cameraId: 'cam', startTime: T0 + i * 60_000, label: 'person' }, MODEL, [1, 0, 0, i]);
}
semantic.addScene({ id: 'e5', cameraId: 'cam', startTime: T0 + 5 * 60_000, label: 'person' }, 'siglip-other', [0, 1, 0, 0]);
store.upsertEvent(event('going-on', T0 + 500 * 60_000, 'active'));
store.sql.exec('COMMIT');

// what: the ended events without a vector of the model, newest first; one going on waits for its end
assert.deepEqual(semantic.unindexed(MODEL, 5), ['e390', 'e380', 'e370', 'e360', 'e350']);
assert.equal(semantic.unindexed(MODEL, 1000).length, 41);
assert.ok(semantic.unindexed(MODEL, 1000).includes('e5'), 'a vector of another model is none of this one');
assert.ok(!semantic.unindexed(MODEL, 1000).includes('going-on'));
assert.equal(semantic.hasVectors('e1', MODEL), true);
assert.equal(semantic.hasVectors('e5', MODEL), false);
assert.equal(semantic.hasVectors('e5', 'siglip-other'), true);

// how: from indexes alone, no vector and no event row read
const plan = (sql: string, ...args: unknown[]) =>
  (store.sql.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(args as never[])) as { detail: string }[]).map((row) => row.detail).join(' | ');
const unindexed = plan(semantic.unindexedSql, MODEL, 21);
assert.match(unindexed, /SCAN events USING COVERING INDEX events_state_time|SEARCH events USING COVERING INDEX events_state_time/, unindexed);
assert.match(unindexed, /USING COVERING INDEX clip_vectors_event_model \(event_id=\? AND model=\?\)/, unindexed);
assert.doesNotMatch(unindexed, /TEMP B-TREE/, unindexed);
const has = plan(semantic.hasVectorsSql, 'e1', MODEL);
assert.match(has, /USING COVERING INDEX clip_vectors_event_model \(event_id=\? AND model=\?\)/, has);
store.close();

console.log('unindexed.spec: the events without a vector of the model, newest first, read from indexes alone — ok');
process.exit(0);
