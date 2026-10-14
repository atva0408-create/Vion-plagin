// When a thing that lay in a camera's picture went, through the recorder (objectGone) and the assistant (object_gone):
// a recording of two MPEG-TS files in the store, a patterned table with a dark box on it until its 12th second, a text
// finder of a fake detection plugin that sees the box while its place is dark, a person's event by it at the moment.
// The moment found to the half second, said in the person's clock with the event around it and the pictures of the
// place before and after; what is not there, never seen, still there and no finder said as such.
// Needs ffmpeg with libx264 on PATH (or CAMERAUI_FFMPEG_PATH). Run: npx tsx spec/object-gone.spec.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { patchOfPicture } from '../src/frames.js';
import VionNvr from '../src/index.js';

import type { AssistantToolContext } from '@camera.ui/sdk';

const FFMPEG = process.env.CAMERAUI_FFMPEG_PATH ?? 'ffmpeg';
const dir = mkdtempSync(join(tmpdir(), 'nvr-gone-'));
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
    `nullsrc=s=320x240:r=10,format=yuv420p,geq=lum='128+60*sin(X/7)*cos(Y/5)':cb=128:cr=128${box}`,
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

let finders = ['finder'];
let blind = false;
/** The fake finder: the box is there while its place is dark. */
const finder = {
  findInPictures: async (_text: string, images: Uint8Array[]) => {
    const patch = await patchOfPicture(FFMPEG, images[0], BOX);
    const dark = !blind && patch !== undefined && patch.reduce((sum, v) => sum + v, 0) / patch.length < 60;
    return { query: 'phone', foundScore: 0.1, pictures: [{ boxes: dark ? [{ ...BOX, score: 0.4 }] : [] }] };
  },
};
const noop = () => undefined;
const logger = { log: noop, warn: noop, error: console.error, debug: noop, attention: noop, trace: noop };
const api = {
  storagePath: mkdtempSync(join(tmpdir(), 'nvr-gone-store-')),
  on: noop,
  once: noop,
  emit: noop,
  notificationManager: { publish: async () => undefined },
  coreManager: {
    assistantAccess: async () => ({ allowed: false }),
    getFFmpegPath: () => new Promise<string>(noop),
    getPluginsByInterface: async (iface: string) => (iface === 'ClipDetection' ? finders.map((id) => ({ id })) : []),
  },
  proxy: { createProxy: (ns: string) => (ns === 'plugin.finder.child.rpc' ? finder : {}) },
};
const storage = { values: {} as Record<string, unknown>, getValue: async () => undefined, setValue: async () => undefined };
const nvr = new VionNvr(logger as never, api as never, storage as never);
(nvr as unknown as { ffmpegPath: string }).ffmpegPath = FFMPEG;
const cameras = (nvr as unknown as { cameras: Map<string, unknown> }).cameras;
cameras.set('desk', { device: { id: 'desk', name: 'Стол' }, recorders: new Map(), subscriptions: [] } as never);

// the recording: 0-10 s with the box, 10-20 s with it for 2 s more
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
    keyframes: JSON.stringify([[0, start]]),
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

// ---- the recorder: the moment to the half second, the pictures of the place before and after
{
  const answer = await nvr.objectGone({ cameraId: 'desk', words: 'телефон', language: 'ru', fromMs: T, toMs: T + 20_000 });
  assert.equal(answer.state, 'gone', JSON.stringify({ ...answer, before: undefined, after: undefined }));
  assert.equal(answer.english, 'phone');
  assert.ok(seconds(answer.goneMs) >= 12 && seconds(answer.goneMs) <= 12.6, `gone at ${seconds(answer.goneMs)} s`);
  assert.ok(seconds(answer.lastSeenMs) >= 11.4 && seconds(answer.lastSeenMs) < 12, `last seen at ${seconds(answer.lastSeenMs)} s`);
  for (const picture of [answer.before, answer.after]) {
    assert.ok(picture && picture[0] === 0xff && picture[1] === 0xd8, 'a JPEG');
    const width = jpegWidth(picture);
    assert.ok(width > 0 && width < 320, `a crop around the place, not the whole frame (${width} px wide)`);
  }
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

// ---- the assistant: the two moments in the person's clock, the event by it, a button, the two pictures
{
  const result = await nvr.callAssistantTool('object_gone', { camera: 'Стол', object: 'телефон', from: iso(T), to: iso(T + 20_000) }, ctx);
  assert.equal(result.error, undefined, String(result.error));
  const content = result.content as { state: string; as: string; lastSeen: string; gone: string; around: { id: string; labels: string[] }[]; note: string; from: string };
  assert.equal(content.state, 'gone');
  assert.equal(content.as, 'phone');
  assert.equal(content.from, clock(T));
  assert.ok(content.gone >= clock(T + 12_000) && content.gone <= clock(T + 13_000), content.gone);
  assert.deepEqual(
    content.around.map((ev) => [ev.id, ev.labels]),
    [['taker', ['person']]],
  );
  assert.match(content.note, /Look at the two pictures/);
  assert.deepEqual(
    result.references?.map((r) => r.eventId ?? (r as { id?: string }).id),
    ['taker'],
  );
  assert.deepEqual(
    result.images?.map((image) => image.caption?.split(' · ')[1]),
    ['before', 'after'],
  );
  // a time without a zone is the person's clock
  const local = clock(T).replace(' ', 'T');
  const same = await nvr.callAssistantTool('object_gone', { camera: 'Стол', object: 'телефон', from: local, to: iso(T + 20_000) }, ctx);
  assert.equal((same.content as { from: string }).from, clock(T));
}

// ---- still there, never seen, nothing recorded, no finder, what is asked wrong
{
  const still = await nvr.callAssistantTool('object_gone', { camera: 'Стол', object: 'телефон', from: iso(T), to: iso(T + 9_000) }, ctx);
  assert.equal((still.content as { state: string }).state, 'still-there');
  blind = true;
  const never = await nvr.callAssistantTool('object_gone', { camera: 'Стол', object: 'телефон', from: iso(T), to: iso(T + 20_000) }, ctx);
  assert.equal((never.content as { state: string }).state, 'never-seen');
  assert.match((never.content as { note: string }).note, /other words/);
  blind = false;
  const empty = await nvr.callAssistantTool('object_gone', { camera: 'Стол', object: 'телефон', from: iso(T - 7_200_000), to: iso(T - 3_600_000) }, ctx);
  assert.match(empty.error ?? '', /Nothing of «Стол» was recorded/);
  finders = [];
  const none = await nvr.callAssistantTool('object_gone', { camera: 'Стол', object: 'телефон', from: iso(T), to: iso(T + 20_000) }, ctx);
  assert.match(none.error ?? '', /No engine finds words in pictures/);
  finders = ['finder'];
  assert.match((await nvr.callAssistantTool('object_gone', { camera: 'Стол' }, ctx)).error ?? '', /object is required/);
  assert.match((await nvr.callAssistantTool('object_gone', { camera: 'Кухня', object: 'телефон' }, ctx)).error ?? '', /Кухня/);
  assert.match((await nvr.callAssistantTool('object_gone', { object: 'телефон' }, ctx)).error ?? '', /Name one camera/);
  assert.match(
    (await nvr.callAssistantTool('object_gone', { camera: 'Стол', object: 'телефон', from: iso(T + 20_000), to: iso(T) }, ctx)).error ?? '',
    /from must be before/,
  );
  assert.match((await nvr.callAssistantTool('object_gone', { camera: 'Стол', object: 'телефон', from: 'вчера' }, ctx)).error ?? '', /from must be a time/);
}

// ---- a thing that moved while there: the assistant is told the moment is known to about a minute
{
  const host = (nvr as unknown as { assistantHost(): Record<string, unknown> }).assistantHost();
  host.objectGone = async () => ({ state: 'gone', english: 'person', place: BOX, seenMs: T, lastSeenMs: T + 60_000, goneMs: T + 110_000, roughly: true, looks: 9 });
  const { callAssistantTool } = await import('../src/assistant.js');
  const told = await callAssistantTool(host as never, 'object_gone', { camera: 'Стол', object: 'человек', from: iso(T), to: iso(T + 200_000) }, ctx);
  assert.match((told.content as { roughly?: string }).roughly ?? '', /about a minute/);
  assert.equal((told.content as { pause?: string }).pause, undefined);
}

console.log(
  'object-gone.spec: the moment through the recorder and the assistant, the event by it, pictures before and after, still there, never seen, nothing recorded, no finder, wrong asks OK',
);
process.exit(0);
