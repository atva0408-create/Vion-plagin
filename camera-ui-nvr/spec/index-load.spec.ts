// The vectors of the searches are read into memory a portion at a time (src/vector-index.ts loadIndexes), and a portion
// is synchronous work on the recorder's thread. A portion was 5000 rows whatever the disk: on the bench (a database of
// 1.4 GB, three quarters of it free pages, on a hard disk) the first one took 30 s, with the recorder standing.
// A portion now ends when its time is up (PORTION_MS), whatever the disk does: few rows on a slow one, thousands on a
// fast one, and a disk that slows down in the middle of a portion ends it there.
// Run: npx tsx spec/index-load.spec.ts
import assert from 'node:assert/strict';

import { PORTION_MAX, PORTION_MS } from '../src/portions.js';
import { loadIndexes, VectorIndex } from '../src/vector-index.js';

import type { DatabaseSync } from 'node:sqlite';

const DIM = 8;
function vec(seed: number): Uint8Array {
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) v[i] = Math.sin(seed * (i + 1));
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  return new Uint8Array(Float32Array.from(v, (x) => x / n).buffer);
}

/** A table of `count` rows; reading row `id` costs `cost(id)` ms of the clock, as a disk does. */
function table(count: number, cost: (id: number) => number) {
  let clock = 0;
  const portions: { rows: number; ms: number }[] = [];
  const db = {
    prepare: () => ({
      *iterate(after: number, limit: number) {
        const portion = { rows: 0, ms: 0 };
        portions.push(portion);
        for (let id = after + 1; id <= count && portion.rows < limit; id++) {
          clock += cost(id);
          portion.ms += cost(id);
          portion.rows++;
          yield { id, model: id % 7 === 0 ? 'other' : 'clip', camera_id: 'door', ts: 1000 + id, vec: vec(id) };
        }
      },
    }),
  } as unknown as DatabaseSync;
  return { db, portions, now: () => clock };
}
const total = (indexes: Map<string, VectorIndex>) => [...indexes.values()].reduce((sum, index) => sum + index.count, 0);

// a slow disk (6 ms a row, the bench): no portion holds the thread past its time, and every row is read once
{
  const slow = table(3000, () => 6);
  const indexes = new Map<string, VectorIndex>();
  await loadIndexes(slow.db, 'clip_vectors', indexes, slow.now);
  assert.equal(total(indexes), 3000, 'every row is in an index');
  assert.equal(indexes.get('other')?.count, Math.floor(3000 / 7), 'each in the index of its model');
  assert.equal(
    slow.portions.reduce((sum, portion) => sum + portion.rows, 0),
    3000,
    'no row read twice, none left out',
  );
  const longest = Math.max(...slow.portions.map((portion) => portion.ms));
  // the time is looked at after each row: a portion runs over by one row at most
  assert.ok(longest <= PORTION_MS + 6, `the longest portion took ${longest} ms: the recorder stood that long`);
  assert.ok(slow.portions[0].ms <= PORTION_MS + 6, 'the first portion too: nothing was known of the disk yet');
}

// a fast disk: a portion is its most rows, so a big table is not read in thousands of little steps
{
  const fast = table(400_000, () => 0.002);
  const indexes = new Map<string, VectorIndex>();
  await loadIndexes(fast.db, 'clip_vectors', indexes, fast.now);
  assert.equal(total(indexes), 400_000);
  assert.equal(fast.portions.length, 400_000 / PORTION_MAX + 1, 'whole portions, and the empty one that says the table ended');
  assert.equal(Math.max(...fast.portions.map((portion) => portion.rows)), PORTION_MAX);
}

// a disk that slows down in the middle of a portion (the cache ran out): that very portion ends in time
{
  const mixed = table(20_000, (id) => (id <= 12_000 ? 0.002 : 6));
  const indexes = new Map<string, VectorIndex>();
  await loadIndexes(mixed.db, 'clip_vectors', indexes, mixed.now);
  assert.equal(total(indexes), 20_000);
  const longest = Math.max(...mixed.portions.map((portion) => portion.ms));
  assert.ok(longest <= PORTION_MS + 6, `the portion the disk slowed down in took ${longest} ms`);
}

// the load gives way between portions: something else gets its turn while it runs
{
  const slow = table(500, () => 6);
  let turns = 0;
  let loading = true;
  const others = (async () => {
    while (loading) {
      turns++;
      await new Promise((resolve) => setImmediate(resolve));
    }
  })();
  await loadIndexes(slow.db, 'clip_vectors', new Map(), slow.now);
  loading = false;
  await others;
  assert.ok(turns >= slow.portions.length - 1, `others ran ${turns} times between ${slow.portions.length} portions`);
}

// an empty table
{
  const empty = table(0, () => 1);
  const indexes = new Map<string, VectorIndex>();
  await loadIndexes(empty.db, 'person_vectors', indexes, empty.now);
  assert.equal(indexes.size, 0);
  assert.equal(empty.portions.length, 1);
}

// a real database: the rows written, read back into the indexes
{
  const { DatabaseSync: Database } = await import('node:sqlite');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE clip_vectors (event_id TEXT, seg INTEGER, attr INTEGER, camera_id TEXT, ts INTEGER, label TEXT, model TEXT, vec BLOB, PRIMARY KEY (event_id, seg, attr))');
  const insert = db.prepare('INSERT INTO clip_vectors VALUES (?, 0, 0, ?, ?, ?, ?, ?)');
  for (let i = 1; i <= 1234; i++) insert.run(`e${i}`, i % 2 ? 'door' : 'lift', 1000 + i, 'person', 'clip', vec(i));
  const indexes = new Map<string, VectorIndex>();
  await loadIndexes(db, 'clip_vectors', indexes);
  assert.equal(indexes.get('clip')?.count, 1234, 'the real statement is read row by row too');
  db.close();
}

console.log('index load: a portion ends in time whatever the disk, every row once, the recorder gets its turn OK');
