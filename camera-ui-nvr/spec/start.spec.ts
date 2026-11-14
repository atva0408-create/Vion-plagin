// What the recorder does before the server takes it for started, and what waits until after. The server sends its
// cameras once the plugin object is made, and the recordings begin then: on the bench the start took 2 min 41 s (NVR
// 0.25.2, 2026-11-14) with nothing recorded meanwhile, the vectors of the searches being read in the constructor from
// a database three quarters empty on a hard disk.
// Run: npx tsx spec/start.spec.ts
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { API_EVENT } from '@camera.ui/sdk';

import VionNvr from '../src/index.js';
import { PersonIndex } from '../src/people.js';
import { SemanticIndex } from '../src/semantic.js';
import { Store } from '../src/store.js';

const noop = () => undefined;

function vec(seed: number, dim: number): Uint8Array {
  const v = Float32Array.from({ length: dim }, (_, i) => Math.sin(seed * (i + 1)));
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  return new Uint8Array(Float32Array.from(v, (x) => x / n).buffer);
}

/** A storage folder whose database holds vectors already, as after days of recording. */
function recorded(clip: number, people: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'nvr-start-'));
  mkdirSync(join(dir, 'recordings'), { recursive: true });
  const store = new Store(join(dir, 'nvr.db'), join(dir, 'recordings'));
  new SemanticIndex(store.sql);
  new PersonIndex(store.sql);
  // of the last hours: the retention of a start deletes the people of long ago, and would before they are read
  const recent = Date.now() - 3 * 3_600_000;
  store.sql.exec('BEGIN');
  const addClip = store.sql.prepare('INSERT INTO clip_vectors (event_id, seg, attr, camera_id, ts, label, model, vec) VALUES (?, 0, 0, ?, ?, ?, ?, ?)');
  for (let i = 1; i <= clip; i++) addClip.run(`e${i}`, 'cam1', recent + i, 'person', 'clip-test', vec(i, 16));
  const addPerson = store.sql.prepare('INSERT INTO person_vectors (event_id, seg, track_id, camera_id, ts, model, vec) VALUES (?, 0, ?, ?, ?, ?, ?)');
  for (let i = 1; i <= people; i++) addPerson.run(`e${i}`, i, 'cam1', recent + i, 'reid-test', vec(i, 8));
  store.sql.exec('COMMIT');
  store.close();
  return dir;
}

interface Warmable {
  warming?: Promise<void>;
  warmed: boolean;
  indexes: Map<string, { count: number }>;
}

function plugin(dir: string) {
  const hostEvents = new Map<string, () => void>();
  const lines: string[] = [];
  const logger = {
    log: (message: string) => lines.push(`log: ${message}`),
    warn: (message: string) => lines.push(`warn: ${message}`),
    error: (message: string) => lines.push(`error: ${message}`),
    debug: (message: string) => lines.push(`debug: ${message}`),
    attention: noop,
    trace: noop,
  };
  const api = {
    storagePath: dir,
    on: (event: string, handler: () => void) => void hostEvents.set(event, handler),
    once: noop,
    emit: noop,
    notificationManager: { publish: async () => undefined },
    coreManager: { assistantAccess: async () => ({ allowed: false }), getFFmpegPath: () => new Promise<string>(noop), getPluginsByInterface: async () => [] },
  };
  const storage = { values: {} as Record<string, unknown>, getValue: async () => undefined, setValue: async () => undefined };
  const nvr = new VionNvr(logger as never, api as never, storage as never);
  const internals = nvr as unknown as { semantic: Warmable; people: Warmable; stop(): Promise<void> };
  return { nvr, internals, lines, launched: () => hostEvents.get(API_EVENT.FINISH_LAUNCHING)!(), stop: () => internals.stop() };
}

// ---- the vectors of the searches are not read while the plugin is made: the server waits for that with its cameras
{
  const { internals, lines, launched, stop } = plugin(recorded(300, 40));
  assert.equal(internals.semantic.warming, undefined, 'no vector of the search by description is read in the constructor');
  assert.equal(internals.people.warming, undefined, 'none of the people search either');
  assert.equal(internals.semantic.indexes.size, 0);

  // launched (the cameras are set and recording): read then, without anybody searching
  launched();
  assert.ok(internals.semantic.warming && internals.people.warming, 'read once the plugin is launched');
  await Promise.all([internals.semantic.warming, internals.people.warming]);
  assert.equal(internals.semantic.warmed, true);
  assert.equal(internals.semantic.indexes.get('clip-test')?.count, 300);
  assert.equal(internals.people.indexes.get('reid-test')?.count, 40);
  // what the server waited for with its cameras is said once a start: a slow one is then seen in the log, with its
  // time, and not guessed from the gap between «Plugin ready» and «Plugin started»
  const ready = lines.filter((line) => line.includes('VION NVR ready'));
  assert.equal(ready.length, 1, lines.join('\n'));
  assert.match(ready[0], /^log: VION NVR ready \(ffmpeg: [^;]+; its database opened in \d+(\.\d+)? s\)$/);
  await stop();
}

// ---- a search before the launch is over reads them itself and waits: nothing is found «not yet»
{
  const { internals, stop } = plugin(recorded(120, 0));
  const search = internals.semantic as unknown as {
    search(queries: { embedding: number[]; embeddingModel: string; scoreBand: [number, number] }[], limit: number): Promise<{ eventId: string }[]>;
  };
  const query = Array.from(new Float32Array(vec(7, 16).buffer));
  // the band of the scores is the whole cosine here: the vector asked with scores 1, the others less
  const found = await search.search([{ embedding: query, embeddingModel: 'clip-test', scoreBand: [0, 1] }], 3);
  assert.ok(internals.semantic.warmed, 'the search read the vectors it needs');
  assert.equal(found[0]?.eventId, 'e7', 'and finds the event whose vector it asked with');
  await stop();
}

// ---- stopped while the vectors are read (a restart moments after a start): the database closes under the reads, and
// that is no failure to tell anybody of
{
  const { internals, lines, launched, stop } = plugin(recorded(12_000, 6_000));
  launched();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(internals.semantic.warmed, false, 'the check itself: the read is still going on');
  await stop();
  // what was still reading ends by itself, a few turns later
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 200));
  const told = lines.filter((line) => /^(warn|error): /.test(line));
  assert.deepEqual(told, [], 'nothing is said of reads that a stop ended');
}

console.log('start.spec: the vectors are read after the launch, a search before it reads them itself, a stop ends them quietly OK');
process.exit(0);
