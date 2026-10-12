// How the vector searches of the recorder scale (not a test: a measurement). Fills a temporary database with N random
// unit vectors — CLIP 512-d for the search by description, re-ID 256-d for the people search — and times the searches
// and the memory they hold. Run: npx tsx spec/bench-vectors.ts [clip N] [person N]
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { PersonIndex } from '../src/people.js';
import { SemanticIndex } from '../src/semantic.js';
import { toBlob } from '../src/vectors.js';

const clipN = Number(process.argv[2] ?? 100_000);
const personN = Number(process.argv[3] ?? 100_000);
const DAY = 86_400_000;
const T0 = Date.parse('2026-09-01T00:00:00Z');

function unit(d: number, seed: number): Float32Array {
  let s = seed >>> 0;
  const v = new Float32Array(d);
  let n = 0;
  for (let i = 0; i < d; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    v[i] = s / 2 ** 32 - 0.5;
    n += v[i] * v[i];
  }
  n = Math.sqrt(n);
  for (let i = 0; i < d; i++) v[i] /= n;
  return v;
}

const mb = () => Math.round(process.memoryUsage().rss / 2 ** 20);
const time = <T>(fn: () => T): [T, number] => {
  const t = performance.now();
  const out = fn();
  return [out, Math.round(performance.now() - t)];
};

const db = new DatabaseSync(join(mkdtempSync(join(tmpdir(), 'nvr-bench-')), 'nvr.db'));
db.exec('PRAGMA journal_mode = WAL');
const semantic = new SemanticIndex(db);
const people = new PersonIndex(db);

let t = performance.now();
db.exec('BEGIN');
const clipInsert = db.prepare('INSERT INTO clip_vectors (event_id, seg, attr, camera_id, ts, label, model, vec) VALUES (?, 0, ?, ?, ?, ?, ?, ?)');
for (let i = 0; i < clipN; i++) clipInsert.run(`e${i >> 2}`, i & 3, `cam-${i % 30}`, T0 + Math.floor((i / clipN) * 90 * DAY), 'person', 'clip', toBlob(unit(512, i + 1)));
const personInsert = db.prepare('INSERT INTO person_vectors (event_id, seg, track_id, camera_id, ts, model, vec) VALUES (?, 0, ?, ?, ?, ?, ?)');
for (let i = 0; i < personN; i++) personInsert.run(`p${i >> 1}`, i & 1, `cam-${i % 30}`, T0 + Math.floor((i / personN) * 90 * DAY), 'reid', toBlob(unit(256, i + 7)));
db.exec('COMMIT');
console.log(`filled ${clipN} CLIP + ${personN} re-ID vectors in ${Math.round(performance.now() - t)} ms, rss ${mb()} MB`);

const text = unit(512, 999_999);
const timeAsync = async <T>(fn: () => Promise<T>): Promise<number> => {
  const started = performance.now();
  await fn();
  return Math.round(performance.now() - started);
};
// the recorder reads the indexes at start: how long the loop is held at most meanwhile
let longest = 0;
let last = performance.now();
const watch = setInterval(() => {
  longest = Math.max(longest, performance.now() - last);
  last = performance.now();
}, 10);
const firstClip = await timeAsync(() => semantic.search([{ embedding: [...text], embeddingModel: 'clip' }], 50, 0));
clearInterval(watch);
console.log(`CLIP search, first (reads the index): ${firstClip} ms, the loop held at most ${Math.round(longest)} ms, rss ${mb()} MB`);
const clipRuns: number[] = [];
for (let i = 0; i < 3; i++) clipRuns.push(await timeAsync(() => semantic.search([{ embedding: [...text], embeddingModel: 'clip' }], 50, 0)));
console.log(`CLIP search, again: ${clipRuns.join(' / ')} ms`);

const query = [{ model: 'reid', vec: unit(256, 4242) }];
// a route: an hour around a moment; a people search: seven days; the whole archive
for (const [name, span] of [
  ['1 hour', 3_600_000],
  ['7 days', 7 * DAY],
  ['90 days', 90 * DAY],
] as const) {
  const mid = T0 + 45 * DAY;
  const runs: number[] = [];
  for (let i = 0; i < 3; i++) runs.push(await timeAsync(() => people.search(query, { fromMs: mid - span / 2, toMs: mid + span / 2, minScore: 0.4, limit: 50 })));
  console.log(`people search over ${name}: ${runs.join(' / ')} ms`);
}
console.log(`rss at the end ${mb()} MB`);
t = performance.now();
