// The compact index of the searches over the archive (src/vector-index.ts): with few vectors every one is a candidate
// (the searches stay exact), the time and camera filters hold, near vectors are found among many, the candidates of
// clustered vectors hold what a full scan ranks first, and removing, replacing, packing and growing keep the rows right.
// Run: npx tsx spec/vector-index.spec.ts
import assert from 'node:assert/strict';

import { VectorIndex } from '../src/vector-index.js';

let seed = 12345;
function random(): number {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
}
function gaussian(): number {
  return Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random());
}
function unit(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  return v.map((x) => x / n);
}
function randomUnit(d: number): Float32Array {
  return unit(Float32Array.from({ length: d }, gaussian));
}
function near(v: Float32Array, noise: number): Float32Array {
  return unit(v.map((x) => x + noise * gaussian()));
}
function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// ---- few vectors: every one passes, so the searches built on it stay exact
{
  const index = new VectorIndex(512, 8);
  for (let i = 1; i <= 100; i++) index.add(i, randomUnit(512), 1000 + i, i % 2 ? 'door' : 'lift');
  assert.equal(index.count, 100, 'grown past its first capacity of 8');
  const all = index.candidates(randomUnit(512), 2000).sort((a, b) => a - b);
  assert.deepEqual(all, Array.from({ length: 100 }, (_, i) => i + 1));
  // the filters: a time window and the cameras
  const window = index.candidates(randomUnit(512), 2000, { fromMs: 1011, toMs: 1020 });
  assert.deepEqual(window.sort((a, b) => a - b), [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  const lift = index.candidates(randomUnit(512), 2000, { cameraIds: new Set(['lift']) });
  assert.equal(lift.length, 50);
  assert.ok(lift.every((row) => row % 2 === 0));
  assert.deepEqual(index.candidates(randomUnit(512), 2000, { cameraIds: new Set(['nowhere']) }), [], 'a camera never seen: none');
  // exactly k when more pass, and those k are the nearest by signs: none left out is nearer than one taken
  const signs = (v: Float32Array) => Array.from(v, (x) => x > 0);
  const vectors = new Map<number, boolean[]>();
  const index2 = new VectorIndex(64);
  for (let i = 1; i <= 300; i++) {
    const v = randomUnit(64);
    vectors.set(i, signs(v));
    index2.add(i, v, i, 'cam');
  }
  for (let q = 0; q < 30; q++) {
    const query = randomUnit(64);
    const qs = signs(query);
    const hamming = (row: number) => vectors.get(row)!.reduce((d, s, i) => d + (s !== qs[i] ? 1 : 0), 0);
    const taken = new Set(index2.candidates(query, 7));
    assert.equal(taken.size, 7);
    const farthestTaken = Math.max(...[...taken].map(hamming));
    const nearestLeft = Math.min(...[...vectors.keys()].filter((row) => !taken.has(row)).map(hamming));
    assert.ok(farthestTaken <= nearestLeft, `query ${q}: took one at ${farthestTaken}, left one at ${nearestLeft}`);
  }
}

// ---- near vectors are found among many
{
  const index = new VectorIndex(512);
  const query = randomUnit(512);
  for (let i = 1; i <= 20_000; i++) index.add(i, randomUnit(512), i, 'cam');
  const planted = Array.from({ length: 10 }, (_, i) => 100_000 + i);
  // as alike as the same person or thing seen twice: cosine about 0.6-0.8
  planted.forEach((row) => index.add(row, near(query, 0.04), row, 'cam'));
  const found = new Set(index.candidates(query, 200));
  assert.deepEqual(
    planted.filter((row) => !found.has(row)),
    [],
    'every planted neighbour among 200 of 20 010',
  );
}

// ---- clustered vectors (people and things look alike in groups): the candidates hold what a full scan ranks first
{
  const index = new VectorIndex(512);
  const centers = Array.from({ length: 50 }, () => randomUnit(512));
  const vectors = new Map<number, Float32Array>();
  for (let i = 1; i <= 20_000; i++) {
    const v = near(centers[i % 50], 0.06);
    vectors.set(i, v);
    index.add(i, v, i, 'cam');
  }
  let hits = 0;
  let wanted = 0;
  for (let q = 0; q < 20; q++) {
    const query = near(centers[(q * 7) % 50], 0.06);
    const top = [...vectors.entries()]
      .sort((a, b) => dot(query, b[1]) - dot(query, a[1]))
      .slice(0, 50)
      .map(([row]) => row);
    const candidates = new Set(index.candidates(query, 2000));
    hits += top.filter((row) => candidates.has(row)).length;
    wanted += top.length;
  }
  const recall = hits / wanted;
  assert.ok(recall >= 0.98, `the best 50 of a full scan among 2000 candidates: ${recall}`);
}

// ---- removing, replacing, packing, the old rows going
{
  const index = new VectorIndex(256, 16);
  const vec = randomUnit(256);
  for (let i = 1; i <= 5000; i++) index.add(i, vec, i, i % 3 ? 'a' : 'b');
  index.add(7, randomUnit(256), 7, 'b');
  assert.equal(index.count, 5000, 'a row added again is replaced, not doubled');
  for (let i = 1; i <= 4000; i++) if (i % 2) index.remove(i);
  index.remove(999_999);
  assert.equal(index.count, 3000);
  // 5001 slots (row 7 added again left one dead); a quarter of them removed, they were packed
  assert.ok(index.slots < 5001, `packed: ${index.slots} slots`);
  const rows = new Set(index.candidates(vec, 10_000));
  assert.equal(rows.size, 3000);
  assert.ok(!rows.has(1) && rows.has(2) && rows.has(4001), 'packed, the rows kept are the right ones');
  // after packing a row is still found and removed by its id
  index.remove(4002);
  assert.ok(!new Set(index.candidates(vec, 10_000)).has(4002));
  assert.equal(index.removeBefore(4500), 2000 - 1 + 499, 'the even rows under 4000 but 4002 went before, then 4001-4499');
  assert.equal(Math.min(...index.candidates(vec, 10_000)), 4500);
  // the memory of a million CLIP vectors, as sized here
  const big = new VectorIndex(512, 1_000_000);
  assert.ok(big.bytes < 90 * 2 ** 20, `${big.bytes} bytes for a million`);
}

console.log('vector-index.spec: exact when few, filters, near vectors, recall on clusters, remove/replace/pack/old rows, size — ok');
