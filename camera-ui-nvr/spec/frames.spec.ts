// Pictures out of the recording by ffmpeg (frames.ts) and the searches on them (gone.ts, place.ts): a made-up
// recording of two MPEG-TS files, a patterned table that never moves with a dark box on it until its 12th second. A
// whole frame at a time; the patch of the box the same while it lies and other after; the patches every half second
// across the two files with their times; the moment it went, found to the half second; a look at one keyframe (its
// patch as the stream's, the whole picture small, gray or coloured) and the place's history to the keyframe.
// Needs ffmpeg with libx264 on PATH (or CAMERAUI_FFMPEG_PATH). Run: npx tsx spec/frames.spec.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { frameAt, lookOf, patchesOf, patchOfPicture } from '../src/frames.js';
import { FINE_MS, PATCH, patchDiff, SAME_LOOK, whenGone, widened } from '../src/gone.js';
import { NIGHT_COLOUR, OVERVIEW_H, OVERVIEW_W, placeHistory } from '../src/place.js';

import type { Place } from '../src/gone.js';

const FFMPEG = process.env.CAMERAUI_FFMPEG_PATH ?? 'ffmpeg';
const dir = mkdtempSync(join(tmpdir(), 'nvr-frames-'));
const T = Date.parse('2026-10-14T10:00:00Z') * 1000;
const BOX = { x: 150 / 320, y: 150 / 240, width: 30 / 320, height: 20 / 240 };

/** A file of `seconds`, the box drawn until `until` s of it (never when undefined); gray, or with colour. */
function file(name: string, seconds: number, until?: number, colour = false): string {
  const path = join(dir, name);
  const box = until === undefined ? '' : `,drawbox=x=150:y=150:w=30:h=20:color=black:t=fill:enable='lt(t,${until})'`;
  const chroma = colour ? "cb='128+50*sin(X/9)':cr='128+40*cos(Y/7)'" : 'cb=128:cr=128';
  const made = spawnSync(FFMPEG, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `nullsrc=s=320x240:r=10,format=yuv420p,geq=lum='128+60*sin(X/7)*cos(Y/5)':${chroma}${box}`,
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

// ---- a look at one keyframe (place.ts): the patch as the stream's, the whole picture small, how coloured it is
{
  const look = await lookOf(FFMPEG, first, T + 5e6, BOX);
  assert.ok(look, 'a look at the keyframe of the 5th second');
  assert.equal(look.patch.length, PATCH * PATCH);
  assert.equal(look.overview.length, OVERVIEW_W * OVERVIEW_H);
  const [stream] = await patchesOf(FFMPEG, segments, T + 5e6, T + 5.5e6, BOX, FINE_MS);
  assert.ok(patchDiff(look.patch, stream.pixels) < SAME_LOOK / 3, `the keyframe's patch is the stream's: ${patchDiff(look.patch, stream.pixels)}`);
  const dark = look.patch.reduce((sum, v) => sum + v, 0) / look.patch.length;
  assert.ok(dark < 60, `the box itself, black: ${dark}`);
  const later = await lookOf(FFMPEG, second, T + 15e6, BOX);
  assert.ok(patchDiff(look.patch, later!.patch) > SAME_LOOK, 'gone at the 15th second');
  assert.ok(patchDiff(look.overview, later!.overview) < 0.3, `the whole picture the same: ${patchDiff(look.overview, later!.overview)}`);
  assert.ok(look.colour < NIGHT_COLOUR, `a gray recording is a night one: ${look.colour}`);
  const coloured = { path: file('c.ts', 3, undefined, true), start_us: T, end_us: T + 3e6 };
  const day = await lookOf(FFMPEG, coloured, T + 1e6, BOX);
  assert.ok(day!.colour > NIGHT_COLOUR * 3, `a coloured one is a day one: ${day!.colour}`);
  assert.equal(await lookOf(FFMPEG, first, T + 30e6, BOX), undefined, 'past the frames of the file: no look');
  await assert.rejects(lookOf(FFMPEG, { ...first, path: join(dir, 'missing.ts') }, T + 1e6, BOX), 'a file that cannot be read is a failure, not an empty look');
}

// ---- the whole history of the place on the recording: marked at the 3rd second, the box went at the 12th
{
  const answer = await placeHistory(
    {
      recorded: () => [{ startMs: T / 1000, endMs: T / 1000 + 20_000 }],
      look: async (atMs) => {
        // a keyframe every second (-g 10 at 10 fps), as the index of the recorder gives them
        const segment = segmentAt(atMs * 1000);
        const keyframeUs = Math.max(segment.start_us, T + Math.floor((atMs * 1000 - T) / 1e6) * 1e6);
        const look = await lookOf(FFMPEG, segment, Math.min(keyframeUs, segment.end_us - 1e6), BOX);
        return look ? { atMs: Math.min(keyframeUs, segment.end_us - 1e6) / 1000, ...look } : undefined;
      },
    },
    { place: BOX, atMs: T / 1000 + 3000, fromMs: T / 1000, toMs: T / 1000 + 20_000, mode: 'gone' },
  );
  const changed = answer.changes.filter((c) => c.kind === 'changed');
  assert.equal(changed.length, 1, JSON.stringify(answer.changes));
  assert.equal((changed[0].beforeMs - T / 1000) / 1000, 11, 'the last keyframe with the box');
  assert.equal((changed[0].afterMs - T / 1000) / 1000, 12, 'the first without it');
  assert.ok(changed[0].exact && !changed[0].busy && !changed[0].gap);
  assert.equal(answer.changes.filter((c) => c.kind === 'turned').length, 0, 'the camera did not turn');
}

console.log('frames.spec: a frame at a time, the patch of a place lying and gone, patches across files, the moment found on a recording, a look at a keyframe, the history of a place OK');
