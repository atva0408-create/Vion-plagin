// A table is read on the recorder's thread, and the video of every camera goes through that thread: while a read runs,
// nothing is taken from the pipes of the ffmpegs. A read of many rows therefore goes a portion at a time, and a portion
// ends when its time is up (src/portions.ts), whatever the disk does. The look for recorded files without a row read
// the paths of the segments 5000 rows a portion: 1000 pages of the bench's database, seconds each on its cold hard disk.
// Run: npx tsx spec/portions.spec.ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { inPortions, PORTION_MAX, PORTION_MS } from '../src/portions.js';
import { Store } from '../src/store.js';

/** Counts the turns the rest of the process gets while `work` runs. */
async function turnsDuring(work: () => Promise<void>): Promise<number> {
  let turns = 0;
  let working = true;
  const others = (async () => {
    while (working) {
      turns++;
      await new Promise((resolve) => setImmediate(resolve));
    }
  })();
  await work();
  working = false;
  await others;
  return turns;
}

// ---- the rows of a read, each once and in order, however the portions fall
{
  const rows = Array.from({ length: 12_345 }, (_, i) => i + 1);
  const asked: [number, number][] = [];
  const read = (after: number, limit: number) => {
    asked.push([after, limit]);
    return rows.slice(after, after + limit);
  };
  const taken: number[] = [];
  await inPortions(read, (row) => (taken.push(row), row));
  assert.deepEqual(taken, rows, 'every row once, in order');
  assert.deepEqual(asked, [
    [0, PORTION_MAX],
    [PORTION_MAX, PORTION_MAX],
    [2 * PORTION_MAX, PORTION_MAX],
  ]);

  // a table that ends at a whole portion is asked once more, and that says it ended
  const whole = Array.from({ length: PORTION_MAX }, (_, i) => i + 1);
  let asks = 0;
  await inPortions((after, limit) => (asks++, whole.slice(after, after + limit)), (row) => row);
  assert.equal(asks, 2);
}

// ---- a slow read: a portion ends in time, and the next one asks from the row it stopped at
{
  let clock = 0;
  const rows = Array.from({ length: 500 }, (_, i) => i + 1);
  const portions: number[] = [];
  function* read(after: number, limit: number) {
    let ms = 0;
    for (const row of rows.slice(after, after + limit)) {
      clock += 6; // the disk seeks for the row
      ms += 6;
      yield row;
      portions[portions.length - 1] = ms;
    }
  }
  const taken: number[] = [];
  const turns = await turnsDuring(() =>
    inPortions(
      (after, limit) => (portions.push(0), read(after, limit)),
      (row) => (taken.push(row), row),
      () => clock,
    ),
  );
  assert.deepEqual(taken, rows);
  assert.ok(Math.max(...portions) <= PORTION_MS + 6, `the longest portion held the thread ${Math.max(...portions)} ms`);
  assert.ok(turns >= portions.length - 1, `the rest of the process got ${turns} turns between ${portions.length} portions`);
}

// ---- the paths of the recorded files, for the look for files without a row: read so too
{
  const dir = mkdtempSync(join(tmpdir(), 'nvr-portions-'));
  const store = new Store(join(dir, 'nvr.db'), join(dir, 'recordings'));
  const COUNT = 3000;
  for (let i = 1; i <= COUNT; i++) {
    store.addSegment({
      camera_id: `cam${i % 3}`,
      role: 'high',
      start_us: i * 60_000_000,
      end_us: (i + 1) * 60_000_000,
      path: join(dir, 'recordings', `cam${i % 3}`, '2026-11-14', `${i}.ts`),
      bytes: 1000,
      codec: 'h264',
      codec_string: 'avc1.640028',
      width: 1920,
      height: 1080,
      video_pid: 256,
      audio_pid: -1,
      keyframes: '[]',
    });
  }
  // a disk that takes 6 ms a row: the clock is looked at once a row
  let clock = 0;
  const paths: string[] = [];
  const turns = await turnsDuring(() =>
    store.eachSegmentPath(
      (path) => paths.push(path),
      () => (clock += 6),
    ),
  );
  assert.equal(paths.length, COUNT, 'every row once');
  assert.equal(new Set(paths).size, COUNT);
  assert.equal(paths[0], 'cam1/2026-11-14/1.ts', 'as stored: the place below the recordings');
  // 40 ms a portion at 6 ms a row is some 7 rows: hundreds of portions, the recorder at work between them. Read 5000
  // rows a portion it was one, of 18 s
  assert.ok(turns >= COUNT / 10, `the recorder got ${turns} turns while ${COUNT} rows were read from a slow disk`);

  // a fast disk: few portions, the read is not cut into thousands of steps
  const fast = await turnsDuring(() => store.eachSegmentPath(() => undefined, () => 0));
  assert.ok(fast <= 3, `${fast} turns for ${COUNT} rows that took no time`);
  store.close();
}

console.log('portions.spec: every row once and in order, a portion ends in time, the paths of the files read so OK');
