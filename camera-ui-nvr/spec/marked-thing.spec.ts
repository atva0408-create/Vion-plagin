// A marked thing followed through the recorder (markedThing) and the assistant (marked_thing): a recording of 30 s, a
// red box on a patterned gray table until 12 s, then carried to the right out of the picture by a person whose event
// traces the camera kept; an outliner of a fake detection plugin that finds the red pixels of a picture (and answers
// `loading` first, as the real one while its model loads), behind a plugin of an older version without the method.
// The moment to a second, the track to the right, the picture left, the person it went with; the pictures as crops; an
// engine without an outliner said as such.
// Needs ffmpeg with libx264 on PATH (or CAMERAUI_FFMPEG_PATH). Run: npx tsx spec/marked-thing.spec.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { capture } from '../src/frames.js';
import VionNvr from '../src/index.js';

import type { AssistantToolContext } from '@camera.ui/sdk';
import type { Place } from '../src/gone.js';
import type { Prompt } from '../src/thing.js';

const FFMPEG = process.env.CAMERAUI_FFMPEG_PATH ?? 'ffmpeg';
const FFPROBE = FFMPEG.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
const dir = mkdtempSync(join(tmpdir(), 'nvr-marked-'));
const W = 320;
const H = 240;
// an hour ago, on a whole second
const T = Math.floor((Date.now() - 3_600_000) / 1000) * 1000;
const TAKEN_S = 12;
const SPEED = 50; // px a second

const path = join(dir, 'desk.ts');
// a shelf the thing stays on: the camera turned at 20 s (another picture from then on, the thing not in it)
const shelfPath = join(dir, 'shelf.ts');
{
  const made = spawnSync(FFMPEG, [
    ...['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i'],
    `nullsrc=s=${W}x${H}:r=10,format=yuv420p,geq=lum='if(lt(T,20),128+40*sin(X/7)*cos(Y/5),90+60*cos(X/3+Y/11))':cb=128:cr=128[t];` +
      `color=red:s=30x20:r=10[r];[t][r]overlay=x=150:y=150:enable='lt(t,20)':shortest=1,format=yuv420p`,
    ...['-t', '30', '-c:v', 'libx264', '-g', '10', '-bf', '0', '-pix_fmt', 'yuv420p', '-f', 'mpegts', shelfPath],
  ]);
  assert.equal(made.status, 0, made.stderr?.toString());
}
{
  const x = `if(lt(t,${TAKEN_S}),150,150+${SPEED}*(t-${TAKEN_S}))`;
  const made = spawnSync(FFMPEG, [
    ...['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i'],
    // overlaid, not drawbox: drawbox with an expression for x drew the luma of red only (a gray box)
    `nullsrc=s=${W}x${H}:r=10,format=yuv420p,geq=lum='128+40*sin(X/7)*cos(Y/5)':cb=128:cr=128[t];color=red:s=30x20:r=10[r];[t][r]overlay=x='${x}':y=150:shortest=1,format=yuv420p`,
    ...['-t', '30', '-c:v', 'libx264', '-g', '10', '-bf', '0', '-pix_fmt', 'yuv420p', '-f', 'mpegts', path],
  ]);
  assert.equal(made.status, 0, made.stderr?.toString());
}
/** The keyframes of a file as the recorder indexes them. */
function keyframesOf(file: string): number[][] {
  const probed = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'format=start_time:packet=pos,pts_time,flags', '-of', 'json', file], { encoding: 'utf8' });
  const { format, packets } = JSON.parse(probed.stdout) as { format: { start_time: string }; packets: { pos: string; pts_time: string; flags: string }[] };
  return packets.filter((p) => p.flags.startsWith('K')).map((p) => [Number(p.pos), T * 1000 + Math.round((Number(p.pts_time) - Number(format.start_time)) * 1e6)]);
}

/** Where the red thing is in a picture (JPEG), in shares of it; undefined when there is none. */
async function redIn(picture: Uint8Array): Promise<Place | undefined> {
  const raw = await capture(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-i', 'pipe:0', '-frames:v', '1', '-vf', `scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], picture);
  let [x1, y1, x2, y2] = [W, H, -1, -1];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      if (raw[i] > 160 && raw[i + 1] < 90 && raw[i + 2] < 90) [x1, y1, x2, y2] = [Math.min(x1, x), Math.min(y1, y), Math.max(x2, x), Math.max(y2, y)];
    }
  }
  return x2 < 0 || (x2 - x1 + 1) * (y2 - y1 + 1) < 12 ? undefined : { x: x1 / W, y: y1 / H, width: (x2 - x1 + 1) / W, height: (y2 - y1 + 1) / H };
}
const overlapping = (a: Place, b: Place) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const full = (box: Place, area: number) => ({ box, width: 20, height: 20, data: new Uint8Array(400).fill(255), area });

let loadingLeft = 1;
let calls = 0;
/** the next mark outlined as a sliver 1 px wide by its middle point, weakly by its box */
let sliver = false;
/** The fake outliner: the red thing where a prompt falls on it, a piece of the table where a box does not. */
const sam = {
  outlineMarked: async (pictures: { image: Uint8Array; prompts: Prompt[] }[]) => {
    calls++;
    if (loadingLeft-- > 0) return { loading: true, pictures: [] };
    const out = [];
    for (const { image, prompts } of pictures) {
      const red = await redIn(new Uint8Array(image));
      out.push({
        answers: prompts.map((prompt) => {
          const near = red && { x: red.x - 0.02, y: red.y - 0.02, width: red.width + 0.04, height: red.height + 0.04 };
          const on = near && ((prompt.box && overlapping(prompt.box, red!)) || (prompt.points ?? []).some((p) => p.x >= near.x && p.x <= near.x + near.width && p.y >= near.y && p.y <= near.y + near.height));
          if (sliver) {
            if (prompt.box) return { score: 0.5, present: true, mask: full(prompt.box, 0.01) };
            return { score: 0.9, present: true, mask: { box: { ...red!, width: 1 / W }, width: 2, height: 20, data: new Uint8Array(40).fill(255), area: 0.0005 } };
          }
          if (on) return { score: 0.95, present: true, mask: full(red!, red!.width * red!.height) };
          if (prompt.box) return { score: 0.7, present: true, mask: full(prompt.box, prompt.box.width * prompt.box.height * 0.5) };
          return { score: 0.05, present: true };
        }),
      });
    }
    return { pictures: out };
  },
};
let segmenters = ['old', 'sam'];
const noop = () => undefined;
const warned: string[] = [];
const logger = { log: noop, warn: (m: string) => void warned.push(m), error: console.error, debug: noop, attention: noop, trace: noop };
const api = {
  storagePath: mkdtempSync(join(tmpdir(), 'nvr-marked-store-')),
  on: noop,
  once: noop,
  emit: noop,
  notificationManager: { publish: async () => undefined },
  coreManager: {
    assistantAccess: async () => ({ allowed: false }),
    getFFmpegPath: () => new Promise<string>(noop),
    getPluginsByInterface: async (iface: string) => (iface === 'Segmentation' ? segmenters.map((id) => ({ id })) : []),
  },
  proxy: {
    createProxy: (ns: string) =>
      ns === 'plugin.sam.child.rpc'
        ? sam
        : {
            // an engine before 1.7.4: the method is not there
            outlineMarked: () => Promise.reject(new Error('outlineMarked is not a function')),
          },
  },
};
const storage = { values: {} as Record<string, unknown>, getValue: async () => undefined, setValue: async () => undefined };
const nvr = new VionNvr(logger as never, api as never, storage as never);
(nvr as unknown as { ffmpegPath: string }).ffmpegPath = FFMPEG;
const cameraMap = (nvr as unknown as { cameras: Map<string, unknown> }).cameras;
cameraMap.set('desk', { device: { id: 'desk', name: 'Стол' }, recorders: new Map(), subscriptions: [] } as never);
cameraMap.set('shelf', { device: { id: 'shelf', name: 'Полка' }, recorders: new Map(), subscriptions: [] } as never);
type Store = { addSegment(row: Record<string, unknown>): number; addTrace(eventId: string, ticks: { tMs: number }[]): void };
const store = (nvr as unknown as { store: Store }).store;
for (const [camera, file] of [
  ['desk', path],
  ['shelf', shelfPath],
]) {
  store.addSegment({
    camera_id: camera,
    role: 'high',
    start_us: T * 1000,
    end_us: (T + 30_000) * 1000,
    path: file,
    bytes: 1,
    codec: 'h264',
    codec_string: 'avc1.64000d',
    width: W,
    height: H,
    video_pid: 256,
    audio_pid: -1,
    keyframes: JSON.stringify(keyframesOf(file)),
  });
}
// the person who takes it: from 11 s, the thing in their hand as they go right; another one far left all the time
await nvr.ingestDetectionEvent(
  'desk',
  'end' as never,
  {
    id: 'taker',
    cameraId: 'desk',
    state: 'ended',
    startTime: T + 11_000,
    endTime: T + 20_000,
    lastUpdate: T + 20_000,
    types: ['person'],
    triggers: [],
    segmentIndex: 0,
    segments: [{ firstSeen: T + 11_000, lastSeen: T + 20_000, detections: [{ label: 'person', score: 0.9 }] }],
  } as never,
);
const ticks = [];
for (let s = 11; s <= 20; s += 0.5) {
  const thingX = (150 + SPEED * Math.max(0, s - TAKEN_S)) / W;
  const hand = { x: thingX + 15 / W - 0.06, y: 160 / H - 0.3, width: 0.2, height: 0.5 };
  ticks.push({
    tMs: T + s * 1000,
    world: [
      // a bench under the thing all the way: tracked, and no one to carry it
      { id: 1, label: 'bench', box: [0.3, 0.55, 0.7, 0.2] },
      { id: 4, label: 'person', box: [hand.x, hand.y, hand.width, hand.height] },
      { id: 9, label: 'person', box: [0.02, 0.1, 0.1, 0.4] },
      { id: 5, label: 'car', box: [0.6, 0.1, 0.3, 0.2] },
    ],
  });
}
store.addTrace('taker', ticks);

const seconds = (ms: number | undefined) => (ms! - T) / 1000;
/** The width of a JPEG, from its frame header. */
function jpegWidth(jpeg: Uint8Array): number {
  for (let i = 2; i + 8 < jpeg.length;) {
    if (jpeg[i] !== 0xff) return 0;
    const marker = jpeg[i + 1];
    if (marker >= 0xc0 && marker <= 0xc3) return (jpeg[i + 7] << 8) | jpeg[i + 8];
    i += 2 + ((jpeg[i + 2] << 8) | jpeg[i + 3]);
  }
  return 0;
}
const MARKED = { x: 140 / W, y: 140 / H, width: 50 / W, height: 40 / H };

// ---- the recorder: when it went, where it was carried, with whom
{
  const answer = await nvr.markedThing({ cameraId: 'desk', place: MARKED, atMs: T + 2_000, toMs: T + 29_000, carried: true });
  assert.equal(answer.state, 'gone', JSON.stringify({ ...answer, pictures: undefined }));
  assert.ok(loadingLeft < 0, 'the outliner answered loading first and was asked again');
  assert.ok(Math.abs(answer.outline!.x - 150 / W) < 0.02 && Math.abs(answer.outline!.width - 30 / W) < 0.02, `the outline of the thing, not the box drawn: ${JSON.stringify(answer.outline)}`);
  assert.ok(seconds(answer.goneMs) >= TAKEN_S && seconds(answer.goneMs) <= TAKEN_S + 1.5, `gone at ${seconds(answer.goneMs)} s`);
  assert.ok(answer.goneMs! - answer.lastThereMs! <= 1000);
  const carried = answer.carried!;
  assert.ok(carried.track.length >= 4, `followed ${carried.track.length} times`);
  assert.ok(carried.track.every((p, i) => !i || p.box.x > carried.track[i - 1].box.x), 'to the right');
  assert.ok(carried.leftPicture, 'out at the right edge');
  assert.deepEqual(carried.by && { eventId: carried.by.eventId, trackId: carried.by.trackId }, { eventId: 'taker', trackId: 4 }, 'in the hand of the one who took it');
  for (const key of ['marked', 'before', 'after', 'lastSeen'] as const) {
    const picture = answer.pictures[key];
    assert.ok(picture && picture[0] === 0xff && picture[1] === 0xd8, `${key}: a JPEG`);
    assert.ok(jpegWidth(picture) < W, `${key}: a crop around the thing, ${jpegWidth(picture)} px`);
  }
}

// ---- the camera turned: the thing is not in the other picture, and that is no going
{
  const answer = await nvr.markedThing({ cameraId: 'shelf', place: MARKED, atMs: T + 2_000, toMs: T + 29_000, carried: false });
  assert.equal(answer.state, 'still-there', JSON.stringify({ ...answer, pictures: undefined }));
  assert.ok(seconds(answer.turnedMs) >= 19 && seconds(answer.turnedMs) < 20, `turned after ${seconds(answer.turnedMs)} s`);
}

// ---- the assistant: in the person's clock, the pictures, the buttons, the one it went with
{
  const ctx = { timezone: 'Europe/Moscow', language: 'ru' } as unknown as AssistantToolContext;
  const iso = (ms: number) => new Date(ms + 3 * 3_600_000).toISOString().slice(0, 19);
  const result = (await nvr.callAssistantTool('marked_thing', { camera: 'Стол', time: iso(T + 2_000), area: MARKED, carried: true, to: iso(T + 29_000) }, ctx)) as {
    content: { gone?: string; lastThere?: string; carried?: { with?: { event?: string; person?: number; next?: string }; leftThePicture?: boolean }; pictures: string[] };
    images?: unknown[];
    references?: { timestamp?: number }[];
  };
  assert.ok(result.content.gone && result.content.lastThere, JSON.stringify(result.content));
  assert.deepEqual([result.content.carried?.with?.event, result.content.carried?.with?.person], ['taker', 4]);
  assert.match(result.content.carried!.with!.next!, /person_route/);
  assert.equal(result.content.carried?.leftThePicture, true);
  assert.equal(result.images?.length, 4, 'marked, last there, gone, last seen');
  assert.ok((result.references ?? []).some((r) => r.timestamp !== undefined), 'the moments as buttons');
  // when only: nothing followed
  const when = (await nvr.callAssistantTool('marked_thing', { camera: 'Стол', time: iso(T + 2_000), area: MARKED, carried: false, to: iso(T + 29_000) }, ctx)) as {
    content: { gone?: string; carried?: unknown };
  };
  assert.ok(when.content.gone);
  assert.equal(when.content.carried, undefined);
  // the thing still there until the time asked
  const still = (await nvr.callAssistantTool('marked_thing', { camera: 'Стол', time: iso(T + 2_000), area: MARKED, carried: false, to: iso(T + 10_000) }, ctx)) as {
    content: { stillThere?: string; gone?: string };
  };
  assert.ok(still.content.stillThere && !still.content.gone, JSON.stringify(still.content));
}

// ---- a sliver at the mark: ffmpeg cannot cut its look (a crop of width 0), and the question goes on to say so
{
  sliver = true;
  warned.length = 0;
  const answer = await nvr.markedThing({ cameraId: 'desk', place: MARKED, atMs: T + 2_000, toMs: T + 29_000, carried: false });
  sliver = false;
  assert.equal(answer.state, 'not-outlined', JSON.stringify({ ...answer, pictures: undefined }));
  assert.ok(warned.some((m) => /could not be read/.test(m)), warned.join(' | '));
}

// ---- the model still loading when the question's time is near its end: said, not waited for
{
  loadingLeft = 1_000;
  const picture = await (nvr as unknown as { askOutliner(p: Uint8Array, prompts: Prompt[], deadline: number): Promise<unknown> }).askOutliner(
    new Uint8Array([0xff, 0xd8]),
    [{ box: MARKED }],
    Date.now() + 1_000,
  );
  loadingLeft = 0;
  assert.match((picture as { problem: string }).problem, /still loading/);
}

// ---- no engine here outlines things: said as such, the place's watch offered
{
  segmenters = ['old'];
  const before = calls;
  const answer = await nvr.markedThing({ cameraId: 'desk', place: MARKED, atMs: T + 2_000, toMs: T + 29_000, carried: false });
  assert.equal(answer.state, 'no-outliner');
  assert.match(answer.problem!, /ONNX or OpenVINO 1\.7\.4/);
  assert.equal(calls, before);
  const ctx = { timezone: 'UTC', language: 'en' } as unknown as AssistantToolContext;
  const told = (await nvr.callAssistantTool('marked_thing', { camera: 'Стол', time: new Date(T + 2_000).toISOString(), area: MARKED, carried: false }, ctx)) as { error?: string };
  assert.match(told.error!, /place_history/);
}

console.log('marked-thing.spec: a marked thing outlined through a plugin that loads, gone to a second, carried right out of the picture in a hand, the assistant in the person clock with four pictures, no outliner said — ok');
process.exit(0);
