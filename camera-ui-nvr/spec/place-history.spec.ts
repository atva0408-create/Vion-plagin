// What became of a place marked on a frame of the recording, through the recorder (placeHistory) and the assistant
// (place_history): a recording of two MPEG-TS files in the store with a keyframe every second, a patterned table with
// a dark box on it until its 12th second, a person's event by it at the moment. The going, the coming and the history
// to the keyframe, said in the person's clock with the event around and the pictures before and after; still so,
// nothing recorded and what is asked wrong said as such.
// Needs ffmpeg with libx264 on PATH (or CAMERAUI_FFMPEG_PATH). Run: npx tsx spec/place-history.spec.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import VionNvr from '../src/index.js';

import type { AssistantToolContext } from '@camera.ui/sdk';

const FFMPEG = process.env.CAMERAUI_FFMPEG_PATH ?? 'ffmpeg';
const dir = mkdtempSync(join(tmpdir(), 'nvr-place-'));
const BOX = { x: 150 / 320, y: 150 / 240, width: 30 / 320, height: 20 / 240 };
// an hour ago, on a whole second
const T = Math.floor((Date.now() - 3_600_000) / 1000) * 1000;

function file(name: string, until?: number): string {
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
    `nullsrc=s=320x240:r=10,format=yuv420p,geq=lum='128+60*sin(X/7)*cos(Y/5)':cb='128+40*sin(X/9)':cr=128${box}`,
    '-t',
    '10',
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

const noop = () => undefined;
const logger = { log: noop, warn: noop, error: console.error, debug: noop, attention: noop, trace: noop };
const api = {
  storagePath: mkdtempSync(join(tmpdir(), 'nvr-place-store-')),
  on: noop,
  once: noop,
  emit: noop,
  notificationManager: { publish: async () => undefined },
  coreManager: {
    assistantAccess: async () => ({ allowed: false }),
    getFFmpegPath: () => new Promise<string>(noop),
    getPluginsByInterface: async () => [],
  },
  proxy: { createProxy: () => ({}) },
};
const storage = { values: {} as Record<string, unknown>, getValue: async () => undefined, setValue: async () => undefined };
const nvr = new VionNvr(logger as never, api as never, storage as never);
(nvr as unknown as { ffmpegPath: string }).ffmpegPath = FFMPEG;
const cameras = (nvr as unknown as { cameras: Map<string, unknown> }).cameras;
cameras.set('desk', { device: { id: 'desk', name: 'Стол' }, recorders: new Map(), subscriptions: [] } as never);

// the recording: 0-10 s with the box, 10-20 s with it for 2 s more; a keyframe every second (-g 10 at 10 fps)
type Store = { addSegment(row: Record<string, unknown>): number };
const store = (nvr as unknown as { store: Store }).store;
for (const [i, path] of [file('a.ts', 10), file('b.ts', 2)].entries()) {
  const start = (T + i * 10_000) * 1000;
  store.addSegment({
    camera_id: 'desk',
    role: 'high',
    start_us: start,
    end_us: start + 10e6,
    path,
    bytes: 1,
    codec: 'h264',
    codec_string: 'avc1.64000d',
    width: 320,
    height: 240,
    video_pid: 256,
    audio_pid: -1,
    keyframes: JSON.stringify(Array.from({ length: 10 }, (_, k) => [k * 1000, start + k * 1e6])),
  });
}
// a person by the table at the moment
await nvr.ingestDetectionEvent(
  'desk',
  'end' as never,
  {
    id: 'taker',
    cameraId: 'desk',
    state: 'ended',
    startTime: T + 11_000,
    endTime: T + 13_000,
    lastUpdate: T + 13_000,
    types: ['object'],
    triggers: [],
    segmentIndex: 0,
    segments: [{ firstSeen: T + 11_000, lastSeen: T + 13_000, detections: [{ label: 'person', score: 0.9 }] }],
  } as never,
);

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

// ---- the recorder: the going to the keyframe, the pictures of the place before and after
{
  const answer = await nvr.placeHistory({ cameraId: 'desk', place: BOX, atMs: T + 3000, fromMs: T, toMs: T + 20_000, mode: 'gone' });
  assert.equal(answer.state, 'ok');
  const changed = answer.changes.filter((c) => c.kind === 'changed');
  assert.equal(changed.length, 1, JSON.stringify(answer.changes));
  assert.equal(seconds(changed[0].beforeMs), 11);
  assert.equal(seconds(changed[0].afterMs), 12);
  assert.equal(answer.pictures.length, 1);
  for (const picture of [answer.pictures[0].before, answer.pictures[0].after]) {
    assert.ok(picture && picture[0] === 0xff && picture[1] === 0xd8, 'a JPEG');
    const width = jpegWidth(picture);
    assert.ok(width > 0 && width < 320, `a crop around the place, not the whole frame (${width} px wide)`);
  }
  assert.equal(answer.unreadable, undefined, answer.problem);
}

// ---- the privacy zones of the camera: the place under one is black at every keyframe, nothing to tell; the pictures
// around a place beside one come black where it lies
{
  const device = (cameras.get('desk') as { device: { zones?: unknown } }).device;
  device.zones = { privacy: [{ name: 'стол', points: [[40, 55], [62, 55], [62, 80], [40, 80]], dropDetections: true }] };
  const hidden = await nvr.placeHistory({ cameraId: 'desk', place: BOX, atMs: T + 3000, fromMs: T, toMs: T + 20_000, mode: 'gone' });
  assert.deepEqual(hidden.changes.filter((c) => c.kind === 'changed'), [], 'a place under a privacy zone tells nothing');
  // the zone right of the box: the crop around the box reaches into it
  device.zones = { privacy: [{ name: 'стена', points: [[58, 0], [100, 0], [100, 100], [58, 100]], dropDetections: true }] };
  const beside = await nvr.placeHistory({ cameraId: 'desk', place: BOX, atMs: T + 3000, fromMs: T, toMs: T + 20_000, mode: 'gone' });
  assert.equal(beside.pictures.length, 1, JSON.stringify(beside.changes));
  const gray = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-i', 'pipe:0', '-vf', 'scale=40:30,format=gray', '-f', 'rawvideo', 'pipe:1'], {
    input: Buffer.from(beside.pictures[0].before!),
  }).stdout;
  const column = (x: number) => Array.from({ length: 30 }, (_, y) => gray[y * 40 + x]);
  assert.ok(Math.max(...column(39)) < 30, `the crop's right edge under the zone is black: ${column(39).join(' ')}`);
  assert.ok(Math.max(...column(2)) - Math.min(...column(2)) > 40, 'its left edge, outside it, is the table');
  device.zones = undefined;
}

const ctx: AssistantToolContext = { userId: 'u1', role: 'admin', language: 'ru', timezone: 'Europe/Moscow' };
const iso = (ms: number) => new Date(ms).toISOString();
const clock = (ms: number) =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(ms);
type Told = {
  marked: string;
  lastAsMarked?: string;
  firstAsMarked?: string;
  unchanged?: string;
  changes: { what: string; before: string; after: string; asMarked?: string; pictures?: string }[];
  around: { id: string; labels: string[] }[];
  note: string;
};
const call = async (input: Record<string, unknown>) => nvr.callAssistantTool('place_history', { camera: 'Стол', area: BOX, ...input }, ctx);

// ---- the assistant: where it went, in the person's clock, the event by it with a button, the two pictures
{
  const result = await call({ time: iso(T + 3000), mode: 'gone', to: iso(T + 20_000) });
  assert.equal(result.error, undefined, String(result.error));
  const told = result.content as Told;
  assert.equal(told.marked, clock(T + 3000));
  assert.equal(told.lastAsMarked, clock(T + 11_000));
  assert.deepEqual(
    told.changes.filter((c) => c.what === 'the place changed').map((c) => [c.before, c.after, c.pictures]),
    [[clock(T + 11_000), clock(T + 12_000), '1-2']],
  );
  assert.deepEqual(
    told.around.map((ev) => [ev.id, ev.labels]),
    [['taker', ['person']]],
  );
  assert.match(told.note, /not recognised/);
  // the moments before and after it first (the chat opens the recording paused on them), then the event
  assert.deepEqual(
    result.references?.map((r) => [r.kind, r.id, r.timestamp]),
    [
      ['camera', 'desk', T + 11_000],
      ['camera', 'desk', T + 12_000],
      ['event', 'taker', T + 11_000],
    ],
  );
  assert.deepEqual(
    result.images?.map((image) => image.caption?.split(' · ')[1]),
    ['before', 'after'],
  );
  // a moment without a zone is the person's clock
  const local = clock(T + 3000).replace(' ', 'T');
  assert.equal(((await call({ time: local, mode: 'gone', to: iso(T + 20_000) })).content as Told).marked, clock(T + 3000));
}

// ---- taken as the night picture came: said across the night between two day pictures, as the light changing
{
  const shelf = (name: string, box: boolean, gray: boolean) => {
    const path = join(dir, name);
    const made = spawnSync(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `nullsrc=s=320x240:r=10,format=yuv420p,geq=lum='128+60*sin(X/7)*cos(Y/5)':cb='${gray ? 128 : '128+40*sin(X/9)'}':cr=128${box ? ',drawbox=x=150:y=150:w=30:h=20:color=black:t=fill' : ''}`,
      '-t',
      '10',
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
  };
  cameras.set('shelf', { device: { id: 'shelf', name: 'Полка' }, recorders: new Map(), subscriptions: [] } as never);
  for (const [i, path] of [shelf('day.ts', true, false), shelf('night.ts', false, true), shelf('morning.ts', false, false)].entries()) {
    const start = (T + i * 10_000) * 1000;
    store.addSegment({
      camera_id: 'shelf',
      role: 'high',
      start_us: start,
      end_us: start + 10e6,
      path,
      bytes: 1,
      codec: 'h264',
      codec_string: 'avc1.64000d',
      width: 320,
      height: 240,
      video_pid: 256,
      audio_pid: -1,
      keyframes: JSON.stringify(Array.from({ length: 10 }, (_, k) => [k * 1000, start + k * 1e6])),
    });
  }
  const result = await nvr.callAssistantTool('place_history', { camera: 'Полка', area: BOX, time: iso(T + 3000), mode: 'gone', to: iso(T + 30_000) }, ctx);
  assert.equal(result.error, undefined, String(result.error));
  const told = result.content as Told & { changes: { what: string; light?: string; roughly?: string; before: string; after: string }[] };
  const [change] = told.changes.filter((c) => c.what === 'the place changed');
  assert.ok(change, JSON.stringify(told.changes));
  assert.ok(change.before <= clock(T + 10_000) && change.after >= clock(T + 20_000), `across the night: ${change.before}-${change.after}`);
  assert.match(change.light ?? '', /light changed/);
  assert.equal(change.roughly, undefined, 'not «up to N min apart»: it is the light, not the step');
}

// ---- still so, the coming, the history
{
  const still = (await call({ time: iso(T + 3000), mode: 'gone', to: iso(T + 9000) })) as { content: Told; images?: { caption?: string }[] };
  assert.match(still.content.unchanged ?? '', /looks as marked to the end/);
  assert.deepEqual(
    still.images?.map((image) => image.caption?.split(' · ')[1]),
    ['the place'],
    'the place as it is at the end, for the model to look at',
  );
  assert.deepEqual(
    (still as { references?: { kind: string; timestamp?: number }[] }).references?.map((r) => [r.kind, r.timestamp]),
    [['camera', T + 9000]],
    'a button to the place as it is at the end',
  );
  const came = (await call({ time: iso(T + 15_000), mode: 'appeared', from: iso(T) })).content as Told;
  assert.equal(came.firstAsMarked, clock(T + 12_000), 'the empty table as marked since the 12th second');
  const history = (await call({ time: iso(T + 5000), mode: 'history', from: iso(T), to: iso(T + 20_000) })).content as Told;
  const changed = history.changes.filter((c) => c.what === 'the place changed');
  assert.deepEqual(
    changed.map((c) => [c.before, c.after, !!c.asMarked]),
    [[clock(T + 11_000), clock(T + 12_000), false]],
  );
}

// ---- nothing recorded, what is asked wrong
{
  assert.match((await call({ time: iso(T - 3_600_000), mode: 'gone', to: iso(T - 1_800_000) })).error ?? '', /Nothing of «Стол» was recorded/);
  assert.match((await call({ time: iso(T + 3000), mode: 'somewhen' })).error ?? '', /mode must be/);
  assert.match((await nvr.callAssistantTool('place_history', { camera: 'Стол', time: iso(T + 3000), mode: 'gone' }, ctx)).error ?? '', /area must be/);
  assert.match((await call({ time: iso(T + 3000), mode: 'gone', area: { ...BOX, x: 1.5 } })).error ?? '', /area must be/);
  assert.match((await call({ time: iso(T + 3000), mode: 'gone', area: { ...BOX, width: 0 } })).error ?? '', /width and a height/);
  assert.match((await call({ mode: 'gone' })).error ?? '', /time must be the marked moment/);
  assert.match((await call({ time: iso(Date.now() + 3_600_000), mode: 'gone' })).error ?? '', /future/);
  assert.match((await call({ time: iso(T + 3000), mode: 'history', from: iso(T + 5000) })).error ?? '', /inside from…to/);
  assert.match((await call({ time: iso(T + 3000), mode: 'history', from: iso(T - 8 * 86_400_000) })).error ?? '', /longer than a week/);
  assert.match((await call({ time: iso(T + 3000), mode: 'gone', camera: 'Кухня' })).error ?? '', /Кухня/);
}

console.log('place-history.spec: the going, the coming and the history through the recorder and the assistant, the event by it, pictures, still so, nothing recorded, wrong asks OK');
process.exit(0);
