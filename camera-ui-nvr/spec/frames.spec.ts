// Pictures out of the recording by ffmpeg (frames.ts) and the search for a thing's going on them (gone.ts): a made-up
// recording of two MPEG-TS files, a patterned table that never moves with a dark box on it until its 12th second. A
// whole frame at a time; the patch of the box the same while it lies and other after; the patches every half second
// across the two files with their times; and the moment it went, found to the half second.
// Needs ffmpeg with libx264 on PATH (or CAMERAUI_FFMPEG_PATH). Run: npx tsx spec/frames.spec.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { frameAt, patchesOf, patchOfPicture } from '../src/frames.js';
import { FINE_MS, patchDiff, SAME_LOOK, whenGone, widened } from '../src/gone.js';

import type { Place } from '../src/gone.js';

const FFMPEG = process.env.CAMERAUI_FFMPEG_PATH ?? 'ffmpeg';
const dir = mkdtempSync(join(tmpdir(), 'nvr-frames-'));
const T = Date.parse('2026-10-14T10:00:00Z') * 1000;
const BOX = { x: 150 / 320, y: 150 / 240, width: 30 / 320, height: 20 / 240 };

/** A file of `seconds`, the box drawn until `until` s of it (never when undefined). */
function file(name: string, seconds: number, until?: number): string {
  const path = join(dir, name);
  const box = until === undefined ? '' : `,drawbox=x=150:y=150:w=30:h=20:color=black:t=fill:enable='lt(t,${until})'`;
  const made = spawnSync(FFMPEG, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `nullsrc=s=320x240:r=10,format=yuv420p,geq=lum='128+60*sin(X/7)*cos(Y/5)':cb=128:cr=128${box}`,
    '-t',
    String(seconds),
    '-c:v',
    'libx264',
    '-g',
    '10',
    '-pix_fmt',
    'yuv420p',
    '-f',
    'mpegts',
    path,
  ]);
  assert.equal(made.status, 0, made.stderr?.toString());
  return path;
}
// the recording: 0-10 s with the box, 10-20 s with it for 2 s more
const first = { path: file('a.ts', 10, 10), start_us: T, end_us: T + 10e6 };
const second = { path: file('b.ts', 10, 2), start_us: T + 10e6, end_us: T + 20e6 };
const segments = [first, second];
const segmentAt = (us: number) => segments.find((s) => us >= s.start_us && us < s.end_us) ?? segments[segments.length - 1];
const region = widened(BOX);

// ---- a whole frame at a time; the patch of the box: the same while it lies, other after
{
  const at5 = await frameAt(FFMPEG, first, T + 5e6);
  assert.ok(at5 && at5[0] === 0xff && at5[1] === 0xd8, 'a JPEG');
  const at8 = await frameAt(FFMPEG, first, T + 8e6);
  const at15 = await frameAt(FFMPEG, second, T + 15e6);
  const [p5, p8, p15] = await Promise.all([at5!, at8!, at15!].map((picture) => patchOfPicture(FFMPEG, picture, region)));
  assert.ok(patchDiff(p5!, p8!) < SAME_LOOK / 2, `lying: ${patchDiff(p5!, p8!)}`);
  assert.ok(patchDiff(p5!, p15!) > SAME_LOOK * 1.5, `gone: ${patchDiff(p5!, p15!)}`);
}

// ---- the patches every half second across the two files, each with its time; the change at the 12th second
{
  const at5 = await frameAt(FFMPEG, first, T + 5e6);
  const reference = (await patchOfPicture(FFMPEG, at5!, region))!;
  const samples = await patchesOf(FFMPEG, segments, T + 8e6, T + 15e6, region, FINE_MS);
  assert.ok(samples.length >= 12 && samples.length <= 15, `${samples.length} patches`);
  assert.ok(
    samples.every((s, i) => i === 0 || s.atMs > samples[i - 1].atMs),
    'in time order',
  );
  assert.equal(samples[0].atMs, T / 1000 + 8000);
  const same = samples.filter((s) => patchDiff(s.pixels, reference) < SAME_LOOK).map((s) => (s.atMs - T / 1000) / 1000);
  const other = samples.filter((s) => patchDiff(s.pixels, reference) >= SAME_LOOK).map((s) => (s.atMs - T / 1000) / 1000);
  assert.ok(Math.max(...same) >= 11.4 && Math.max(...same) < 12, `last the same at ${Math.max(...same)} s`);
  assert.ok(Math.min(...other) >= 12 && Math.min(...other) <= 12.6, `first other at ${Math.min(...other)} s`);
}

// ---- the whole search on the recording: a finder that sees the box while its place is dark
{
  const answer = await whenGone(
    {
      recorded: () => [{ startMs: T / 1000, endMs: T / 1000 + 20_000 }],
      frame: (atMs) => frameAt(FFMPEG, segmentAt(atMs * 1000), atMs * 1000),
      find: async (picture) => {
        const patch = await patchOfPicture(FFMPEG, picture, BOX);
        const mean = patch ? patch.reduce((sum, v) => sum + v, 0) / patch.length : 255;
        return { english: 'black box', foundScore: 0.1, boxes: mean < 60 ? [{ ...BOX, score: 0.5 }] : [] };
      },
      patchOf: (picture, place: Place) => patchOfPicture(FFMPEG, picture, place),
      patches: (fromMs, toMs, place, stepMs) => patchesOf(FFMPEG, segments, fromMs * 1000, toMs * 1000, place, stepMs),
    },
    T / 1000,
    T / 1000 + 20_000,
  );
  assert.equal(answer.state, 'gone', JSON.stringify({ ...answer, before: undefined, after: undefined }));
  const goneS = (answer.goneMs! - T / 1000) / 1000;
  const lastS = (answer.lastSeenMs! - T / 1000) / 1000;
  assert.ok(goneS >= 12 && goneS <= 12.6, `gone at ${goneS} s`);
  assert.ok(lastS >= 11.4 && lastS < 12, `last seen at ${lastS} s`);
  assert.ok(answer.before?.[0] === 0xff && answer.after?.[0] === 0xff, 'the pictures of the two moments');
}

console.log('frames.spec: a frame at a time, the patch of a place lying and gone, patches across files, the moment found on a recording OK');
