// The index database alone (src/store.ts): a page of events never ends between events that started in the same
// millisecond (the client asks for the next page with `before` = the start of the last one), the oldest-segment
// lookup of the quota guard reads an index, also in a database made before that index existed, and episodes are
// counted by range, favorites and cameras.
// Run: npx tsx spec/store.spec.ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/store.js';

import type { RecordedEvent } from '../src/types.js';

const dir = mkdtempSync(join(tmpdir(), 'nvr-store-'));

// ------------------------------------------------------------------ event pages

{
  const store = new Store(join(dir, 'events.db'));
  const event = (id: string, startTime: number, cameraId = 'cam1') =>
    ({ id, cameraId, state: 'ended', startTime, endTime: startTime + 1000, lastUpdate: startTime + 1000, types: [], triggers: [], segments: [] }) as unknown as RecordedEvent;
  // three cameras fire in the same millisecond (one detection pass), twice
  const all = [
    event('a', 1000),
    event('b', 2000),
    event('c1', 3000),
    event('c2', 3000, 'cam2'),
    event('c3', 3000, 'cam3'),
    event('d', 4000),
    event('e1', 5000),
    event('e2', 5000, 'cam2'),
    event('e3', 5000, 'cam3'),
    event('f', 6000),
  ];
  for (const e of all) store.upsertEvent(e);
  store.setFavorite('c2', true);

  /** Reads everything the way the UI and the re-index do: the next page starts before the last row of this one. */
  const walk = (limit: number, filter: { cameraIds?: string[]; favoritesOnly?: boolean } = {}) => {
    const ids: string[] = [];
    let before: number | undefined;
    for (let page = 0; page < 100; page++) {
      const rows = store.events({ ...filter, before, limit });
      ids.push(...rows.map((r) => r.id));
      if (rows.length < limit) break;
      before = rows[rows.length - 1].start_ms;
    }
    return ids;
  };
  for (let limit = 1; limit <= all.length + 1; limit++) {
    const ids = walk(limit);
    assert.deepEqual([...ids].sort(), all.map((e) => e.id).sort(), `pages of ${limit}: every event is listed once`);
    assert.deepEqual(
      ids.map((id) => all.find((e) => e.id === id)!.startTime),
      all.map((e) => e.startTime).sort((x, y) => y - x),
      `pages of ${limit}: newest first`,
    );
  }
  // the events taken past the limit are the ones the query asked for, not their neighbours in time
  assert.deepEqual(walk(1, { cameraIds: ['cam1'] }), ['f', 'e1', 'd', 'c1', 'b', 'a']);
  assert.deepEqual(walk(1, { cameraIds: ['cam2', 'cam3'] }).sort(), ['c2', 'c3', 'e2', 'e3']);
  assert.deepEqual(walk(1, { favoritesOnly: true }), ['c2']);
  // a page that is not full is left as it is
  assert.equal(store.events({ limit: 50 }).length, all.length);
  assert.equal(store.events({ limit: 0 }).length, 0);
  store.close();
}

// ------------------------------------------------------------------ the oldest segment

const segment = (camera: string, startUs: number, bytes = 1000) => ({
  camera_id: camera,
  role: 'high',
  start_us: startUs,
  end_us: startUs + 60_000_000,
  path: join(dir, `${camera}-${startUs}.ts`),
  bytes,
  codec: 'h264' as const,
  codec_string: 'avc1.640028',
  width: 1920,
  height: 1080,
  video_pid: 256,
  audio_pid: -1,
  keyframes: '[]',
});

/** The plan SQLite makes for the statement `run` sends to the database. */
function planOf(store: Store, run: () => unknown): string {
  const db = store.sql;
  const prepare = db.prepare.bind(db);
  let sql = '';
  db.prepare = (text: string) => prepare((sql = text));
  try {
    run();
  } finally {
    db.prepare = prepare;
  }
  return (prepare(`EXPLAIN QUERY PLAN ${sql}`).all(1) as { detail: string }[]).map((row) => row.detail).join(' | ');
}

{
  const store = new Store(join(dir, 'segments.db'));
  for (let i = 0; i < 50; i++) store.addSegment(segment(`cam${i % 5}`, (50 - i) * 60_000_000));
  assert.equal(store.oldestSegments(1)[0].start_us, 60_000_000, 'the oldest file of all cameras');
  const plan = planOf(store, () => store.oldestSegments(1));
  assert.match(plan, /USING INDEX segments_time/, `the oldest segment is read from an index, not found by sorting every row: ${plan}`);
  assert.doesNotMatch(plan, /TEMP B-TREE/, plan);
  store.close();
}
{
  // a database from a version without the index gets it when it is opened
  const path = join(dir, 'old.db');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE segments (id INTEGER PRIMARY KEY AUTOINCREMENT, camera_id TEXT NOT NULL, role TEXT NOT NULL, start_us INTEGER NOT NULL,
    end_us INTEGER NOT NULL, path TEXT NOT NULL, bytes INTEGER NOT NULL, codec TEXT NOT NULL, codec_string TEXT NOT NULL, width INTEGER NOT NULL,
    height INTEGER NOT NULL, video_pid INTEGER NOT NULL, audio_pid INTEGER NOT NULL DEFAULT -1, keyframes TEXT NOT NULL);
    CREATE INDEX segments_camera_time ON segments (camera_id, role, start_us);
    INSERT INTO segments (camera_id, role, start_us, end_us, path, bytes, codec, codec_string, width, height, video_pid, keyframes)
    VALUES ('c', 'high', 5, 6, '/b.ts', 1, 'h264', 'avc1.640028', 1920, 1080, 256, '[]'), ('c', 'high', 1, 2, '/a.ts', 1, 'h264', 'avc1.640028', 1920, 1080, 256, '[]');`);
  const before = (old.prepare('EXPLAIN QUERY PLAN SELECT * FROM segments ORDER BY start_us LIMIT ?').all(1) as { detail: string }[]).map((r) => r.detail).join(' | ');
  assert.match(before, /TEMP B-TREE/, `the old database sorts every row for this (the check itself can tell): ${before}`);
  old.close();
  const store = new Store(path);
  assert.match(
    planOf(store, () => store.oldestSegments(1)),
    /USING INDEX segments_time/,
  );
  assert.equal(store.oldestSegments(1)[0].path, '/a.ts');
  store.close();
  new Store(path).close(); // opening again must not fail on the index that now exists
}

// ------------------------------------------------------------------ episodes

{
  const store = new Store(join(dir, 'episodes.db'));
  const episode = (id: string, startMs: number, endMs: number, cameras: string[], favorite = false) =>
    store.upsertEpisode(
      { id, start_ms: startMs, end_ms: endMs, favorite: favorite ? 1 : 0, data: JSON.stringify({ episode: { id, members: cameras.map((cameraId) => ({ cameraId })) } }) },
      [],
    );
  episode('morning', 1000, 2000, ['gate', 'door']);
  episode('noon', 5000, 6000, ['door', 'lift'], true);
  episode('evening', 9000, 9500, ['gate', 'yard']);
  const ALL = { fromMs: 0, toMs: Number.MAX_SAFE_INTEGER };
  assert.equal(store.episodeCount(ALL), 3);
  assert.equal(store.episodeCount({ ...ALL, favoritesOnly: true }), 1);
  assert.equal(store.episodeCount({ ...ALL, cameraIds: ['gate'] }), 2, 'episodes with an event of the camera');
  assert.equal(store.episodeCount({ ...ALL, cameraIds: ['gate', 'door'] }), 3, 'an episode of two chosen cameras counts once');
  assert.equal(store.episodeCount({ ...ALL, cameraIds: ['garage'] }), 0);
  assert.equal(store.episodeCount({ ...ALL, cameraIds: ['lift'], favoritesOnly: true }), 1);
  assert.equal(store.episodeCount({ fromMs: 2000, toMs: 5000 }), 2, 'an episode counts while it overlaps the range');
  assert.equal(store.episodeCount({ fromMs: 2001, toMs: 4999 }), 0);
  assert.equal(store.episodeCount({ fromMs: 6001, toMs: Number.MAX_SAFE_INTEGER, cameraIds: ['gate'] }), 1);
  // the list and the count agree on what a range holds
  assert.equal(store.episodeCount({ fromMs: 2000, toMs: 5000 }), store.episodes({ fromMs: 2000, toMs: 5000, limit: 100 }).length);
  store.close();
}

console.log('store.spec: event pages over equal start times, index for the oldest segment (new and old database), episode count — ok');
process.exit(0);
