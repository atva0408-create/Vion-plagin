// Exports over the bus had no limit: a viewer with the right could start any number of ffmpeg runs at once, each on an
// hour of video, with the archive disk as their output (VION audit 2026-10-23, S10). A few run at a time, a few more
// wait their turn, the rest are refused at once; and a timelapse interval is a whole number of seconds, 1 to 3600 —
// a fraction made ffmpeg write billions of frames.
// Run: npx tsx spec/export-gate.spec.ts
import assert from 'node:assert/strict';

import { ExportGate, timelapseOf } from '../src/export.js';

// ---- the interval ----
assert.equal(timelapseOf(undefined), 0, 'no interval: a plain clip');
assert.equal(timelapseOf(0), 0);
assert.equal(timelapseOf(1), 1);
assert.equal(timelapseOf(3600), 3600);
for (const bad of [0.001, 1e-6, 0.5, 3601, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
  assert.throws(() => timelapseOf(bad), /whole number of seconds from 1 to 3600/, `refused: ${bad}`);
}

// ---- the gate ----
{
  const gate = new ExportGate(2, 2);
  const starts: string[] = [];
  const release: Record<string, () => void> = {};
  const job = (name: string) =>
    gate.run(
      () =>
        new Promise<string>((resolve) => {
          starts.push(name);
          release[name] = () => resolve(name);
        }),
    );
  const a = job('a');
  const b = job('b');
  const c = job('c');
  const d = job('d');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(starts, ['a', 'b'], 'two run at once, two wait');
  await assert.rejects(job('e'), /Too many exports are running/, 'a fifth is refused at once, nothing queued for it');
  release.a();
  assert.equal(await a, 'a');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(starts, ['a', 'b', 'c'], 'the first in the queue takes the free slot');
  release.b();
  release.c();
  await Promise.all([b, c]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(starts, ['a', 'b', 'c', 'd']);
  release.d();
  assert.equal(await d, 'd');

  // a job that fails frees its slot too
  await assert.rejects(
    gate.run(() => Promise.reject(new Error('ffmpeg exited with 1'))),
    /ffmpeg exited/,
  );
  const f = job('f');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(starts.at(-1), 'f', 'the slot of the failed one is free again');
  release.f();
  await f;
}

console.log('export-gate.spec: a whole-second interval, two exports at a time and a short queue OK');
