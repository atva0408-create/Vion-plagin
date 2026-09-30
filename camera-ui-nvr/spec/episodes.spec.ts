// Cross-camera episodes (src/episodes.ts) through the real plugin class with a fake host API: which events are
// joined and why, what the UI gets (live message, list, blocks, text, trace, mosaic), favorites against
// retention, deletion, a restart in the middle of a visit and the limits that keep a busy place apart.
// Needs ffmpeg on PATH (or CAMERAUI_FFMPEG_PATH) for the mosaic. Run: npx tsx spec/episodes.spec.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { buildBlocks, duration, LINK_GAP_MS, MAX_MEMBERS } from '../src/episodes.js';
import VionNvr from '../src/index.js';

import type { RecordedEpisode } from '../src/episodes.js';
import type { DetectionEventMessage, RecordedEvent } from '../src/types.js';

const dir = mkdtempSync(join(tmpdir(), 'nvr-episodes-'));
const FFMPEG = process.env.CAMERAUI_FFMPEG_PATH ?? 'ffmpeg';
const noop = () => undefined;
const downloads: { filePath: string; filename: string; mimeType: string }[] = [];
const warnings: string[] = [];
const logger = { log: noop, warn: (...a: unknown[]) => warnings.push(a.join(' ')), error: console.error, debug: noop, attention: noop, trace: noop };
const api = {
  storagePath: dir,
  on: noop,
  once: noop,
  emit: noop,
  notificationManager: { publish: async () => undefined },
  downloadManager: {
    createDownload: async (opts: { filePath: string; filename: string; mimeType: string }) => (downloads.push(opts), { url: `/download/${opts.filename}` }),
  },
  coreManager: {
    assistantAccess: async () => ({ allowed: false }),
    getFFmpegPath: () => new Promise<string>(noop),
    getPluginsByInterface: async () => [],
  },
};

function start(): VionNvr {
  const storage = { values: {} as Record<string, unknown>, getValue: async () => undefined, setValue: async () => undefined };
  const plugin = new VionNvr(logger as never, api as never, storage as never);
  const cams = (plugin as unknown as { cameras: Map<string, unknown> }).cameras;
  for (const [id, name] of [
    ['gate', 'Въезд'],
    ['door', 'Входная дверь'],
    ['lift', 'Лифт'],
    ['yard', 'Двор'],
  ])
    cams.set(id, { device: { id, name }, recorders: new Map(), subscriptions: [] });
  return plugin;
}

let nvr = start();
const messages: DetectionEventMessage[] = [];
await nvr.onDetectionEvent((m) => messages.push(m));
const episodeMessages = () => messages.filter((m) => m.type === 'episode');

// a small real JPEG per camera for the mosaic
function jpeg(color: string): Uint8Array {
  const out = join(dir, `${color}.jpg`);
  const made = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=320x240`, '-frames:v', '1', out]);
  assert.equal(made.status, 0, `ffmpeg could not make a test picture: ${made.stderr?.toString()}`);
  return new Uint8Array(readFileSync(out));
}
const pictures: Record<string, Uint8Array> = { gate: jpeg('red'), door: jpeg('green'), lift: jpeg('blue'), yard: jpeg('yellow') };

interface Spec {
  id: string;
  camera: string;
  at: number;
  lenMs?: number;
  labels?: string[];
  plate?: string;
  face?: string;
  state?: 'active' | 'ended';
}
function event(s: Spec): RecordedEvent {
  const len = s.lenMs ?? 8000;
  const detections = (s.labels ?? []).map((label) => ({ label, score: 0.9, maxCount: 1 }));
  const attributes = [
    ...(s.plate ? [{ type: 'license_plate', label: s.plate, confidence: 0.9 }] : []),
    ...(s.face ? [{ type: 'face', label: s.face, confidence: 0.9 }] : []),
  ];
  const ended = (s.state ?? 'ended') === 'ended';
  return {
    id: s.id,
    cameraId: s.camera,
    state: ended ? 'ended' : 'active',
    startTime: s.at,
    ...(ended ? { endTime: s.at + len } : {}),
    lastUpdate: s.at + len,
    types: [...new Set(['motion', ...(s.labels ?? []), ...attributes.map((a) => a.type)])],
    triggers: [{ type: 'motion', firstSeen: s.at, lastSeen: s.at + 1000 }],
    segmentIndex: 0,
    segments: detections.length || attributes.length ? [{ firstSeen: s.at, lastSeen: s.at + len, detections, attributes }] : [],
  } as unknown as RecordedEvent;
}
async function ingest(s: Spec): Promise<void> {
  await nvr.ingestDetectionEvent(s.camera, s.state === 'active' ? 'start' : 'end', event(s), { scene: pictures[s.camera] });
}

// events happen "now": an episode stays open for joining only while its events are recent
const T0 = Date.now() - 60_000;
// scenarios are 20 minutes apart so they can never join each other
const scene = (n: number, sec: number) => T0 + n * 20 * 60_000 + sec * 1000;

// 1. a person at the gate, then at the door 20 s after leaving the gate: one episode, sent live
await ingest({ id: 's1-gate', camera: 'gate', at: scene(0, 0), labels: ['person'] });
assert.equal(episodeMessages().length, 0, 'one camera is not an episode yet');
await ingest({ id: 's1-door', camera: 'door', at: scene(0, 28), labels: ['person'] });
const live = episodeMessages().at(-1)?.episode as RecordedEpisode | undefined;
assert.ok(live, 'the second camera makes it an episode and it is sent to the UI');
assert.deepEqual(
  live.members.map((m) => m.eventId),
  ['s1-gate', 's1-door'],
);
assert.equal(live.description?.title, 'Человек: Въезд → Входная дверь');
assert.match(live.description?.description ?? '', /Въезд → Входная дверь \(через 28 с\)/);
assert.match(live.description?.summary ?? '', /2 камеры/);
assert.equal(episodeMessages().at(-1)?.data.id, 's1-door', 'the message carries the event that changed the episode');
const listed = await nvr.getEpisodes({ startMs: scene(0, -60), endMs: scene(0, 120) });
assert.equal(listed.episodes.length, 1);
assert.equal(listed.episodes[0].id, live.id);
assert.deepEqual(await nvr.getNvrFeatures(), { episodes: true, exportQuality: true });

// the same update again changes nothing: nothing is sent
const before = episodeMessages().length;
await ingest({ id: 's1-door', camera: 'door', at: scene(0, 28), labels: ['person'] });
assert.equal(episodeMessages().length, before, 'an unchanged update of a member must not be sent again');

// trace: the link and its reason
const trace = await nvr.getEpisodeTrace(live.id);
assert.ok(trace);
assert.equal(trace.links.length, 1);
assert.equal(trace.links[0].from, 's1-gate');
assert.equal(trace.links[0].to, 's1-door');
assert.match(trace.links[0].why, /человек на «Входная дверь» через 20 с после «Въезд»/);
assert.deepEqual(trace.cameras, { gate: 'Въезд', door: 'Входная дверь' });
assert.deepEqual(trace.members[0].labels, ['person']);
const images = await nvr.getEpisodeTraceImages(live.id);
assert.equal(images.length, 2);
assert.ok(images[0].data && images[0].data.length > 100, 'each trace image has the event picture');
assert.match(images[1].note, /Входная дверь · \+28 с/);

// mosaic: two pictures side by side in one JPEG, then served from the cache
const mosaic = await nvr.getEpisodeMosaic(live.id);
assert.ok(mosaic && mosaic[0] === 0xff && mosaic[1] === 0xd8, 'the mosaic is a JPEG');
assert.deepEqual(jpegSize(mosaic), { width: 960, height: 270 });
assert.deepEqual(await nvr.getEpisodeMosaic(live.id), mosaic);
assert.equal(await nvr.getEpisodeMosaic('no-such-episode'), undefined);

// the AI description of an event comes after it ended: the episode quotes it and is sent again
const sentBefore = episodeMessages().length;
(nvr as unknown as { saveDescription(id: string, d: object): void }).saveDescription('s1-door', {
  title: 'Курьер с коробкой',
  description: '',
  tags: [],
  at: Date.now(),
});
assert.equal(episodeMessages().length, sentBefore + 1, 'a new description changes the episode');
assert.match(episodeMessages().at(-1)?.episode?.description?.description ?? '', /Что видно: Курьер с коробкой\./);

// 2. the same camera twice, a person each time: no episode (only a plate or a face joins on one camera)
await ingest({ id: 's2-a', camera: 'gate', at: scene(1, 0), labels: ['person'] });
await ingest({ id: 's2-b', camera: 'gate', at: scene(1, 15), labels: ['person'] });
assert.equal((await nvr.getEpisodes({ startMs: scene(1, -60), endMs: scene(1, 120) })).episodes.length, 0);
// and when the second person walks on to the door, only that person's gate event joins the door
await ingest({ id: 's2-door', camera: 'door', at: scene(1, 35), labels: ['person'] });
assert.deepEqual(
  (await nvr.getEpisodes({ startMs: scene(1, -60), endMs: scene(1, 120) })).episodes.map((e) => e.members.map((m) => m.eventId)),
  [['s2-b', 's2-door']],
  'two people at one camera are not one visit',
);

// 3. a car at the gate, then a person at the door: different kinds are not one visit
await ingest({ id: 's3-car', camera: 'gate', at: scene(2, 0), labels: ['vehicle'] });
await ingest({ id: 's3-man', camera: 'door', at: scene(2, 10), labels: ['person'] });
assert.equal((await nvr.getEpisodes({ startMs: scene(2, -60), endMs: scene(2, 120) })).episodes.length, 0);

// 4. too long between the cameras for a transition, but the same plate joins it (and the plate is normalized)
const gap = LINK_GAP_MS / 1000 + 60;
await ingest({ id: 's4-in', camera: 'gate', at: scene(3, 0), labels: ['vehicle'] });
await ingest({ id: 's4-late', camera: 'yard', at: scene(3, 8 + gap), labels: ['vehicle'] });
assert.equal((await nvr.getEpisodes({ startMs: scene(3, -60), endMs: scene(3, 600) })).episodes.length, 0, 'a gap over the limit is no transition');
await ingest({ id: 's4-plate-a', camera: 'gate', at: scene(3, 300), labels: ['vehicle'], plate: 'К178УС77' });
await ingest({ id: 's4-plate-b', camera: 'yard', at: scene(3, 480), labels: ['vehicle'], plate: 'к 178 ус 77' });
const plated = (await nvr.getEpisodes({ startMs: scene(3, 250), endMs: scene(3, 600) })).episodes;
assert.equal(plated.length, 1, 'the same plate three minutes later is the same visit');
assert.equal(plated[0].description?.title, 'Транспорт К178УС77: Въезд → Двор');
assert.match((await nvr.getEpisodeTrace(plated[0].id))?.links[0].why ?? '', /тот же номер К178УС77, на «Двор» после «Въезд» через 2 мин 52 с/);

// 5. seen by two cameras at once: the first keeps the picture, the other is a second angle
await ingest({ id: 's5-gate', camera: 'gate', at: scene(4, 0), lenMs: 20_000, labels: ['person'] });
await ingest({ id: 's5-yard', camera: 'yard', at: scene(4, 5), lenMs: 30_000, labels: ['person'] });
const both = (await nvr.getEpisodes({ startMs: scene(4, -60), endMs: scene(4, 120) })).episodes[0];
assert.ok(both, 'simultaneous sightings are one visit');
assert.deepEqual(both.blocks, [
  { cameraId: 'gate', startMs: scene(4, 0), endMs: scene(4, 20) },
  { cameraId: 'yard', startMs: scene(4, 20), endMs: scene(4, 35) },
  { cameraId: 'yard', startMs: scene(4, 5), endMs: scene(4, 20), secondAngle: true },
]);
assert.match((await nvr.getEpisodeTrace(both.id))?.links[0].why ?? '', /одновременно с «Въезд»/);

// 6. motion without an object belongs to no story, and is not even kept waiting for one
const candidates = () => (nvr as unknown as { episodes: { candidates: Map<string, unknown> } }).episodes.candidates.size;
const waiting = candidates();
await ingest({ id: 's6-motion-a', camera: 'gate', at: scene(5, 0) });
await ingest({ id: 's6-motion-b', camera: 'door', at: scene(5, 5) });
assert.equal((await nvr.getEpisodes({ startMs: scene(5, -60), endMs: scene(5, 120) })).episodes.length, 0);
assert.equal(candidates(), waiting, 'motion-only events must not pile up as candidates');

// 7. a busy place: a chain of people across cameras stops growing at the member limit
const cams = ['gate', 'door'];
for (let i = 0; i < MAX_MEMBERS + 6; i++)
  await ingest({ id: `s7-${String(i).padStart(2, '0')}`, camera: cams[i % 2], at: scene(6, i * 10), lenMs: 5000, labels: ['person'] });
const busy = (await nvr.getEpisodes({ startMs: scene(6, -60), endMs: scene(6, 600), limit: 10 })).episodes;
assert.ok(busy.length >= 2, 'a long chain is split into several episodes');
assert.ok(
  busy.every((e) => e.members.length <= MAX_MEMBERS),
  'no episode holds more than the limit',
);

// 8. favorite: kept by the list filter and against retention, like a favorite event
const store = (nvr as unknown as { store: { eventsBefore(cutoff: number, limit: number): { id: string }[] } }).store;
const expiring = () => new Set(store.eventsBefore(scene(20, 0), 10_000).map((r) => r.id));
assert.ok(expiring().has('s1-gate'), 'an event of a normal episode expires with the others');
await nvr.setEpisodeFavorite(live.id, true);
assert.equal(episodeMessages().at(-1)?.episode?.favorite, true, 'a favorite change is sent to other views');
assert.deepEqual(
  (await nvr.getEpisodes({ favoritesOnly: true })).episodes.map((e) => e.id),
  [live.id],
);
assert.ok(!expiring().has('s1-gate') && !expiring().has('s1-door'), 'the events of a favorite episode are kept');
assert.ok(expiring().has('s2-a'), 'events outside favorite episodes still expire');
await nvr.setEpisodeFavorite(live.id, false);
assert.ok(expiring().has('s1-gate'));

// 9. deleting events: a three-camera episode becomes a two-camera one with a new title; one camera left: gone
await ingest({ id: 's9-gate', camera: 'gate', at: scene(8, 0), labels: ['person'] });
await ingest({ id: 's9-door', camera: 'door', at: scene(8, 20), labels: ['person'] });
await ingest({ id: 's9-lift', camera: 'lift', at: scene(8, 40), labels: ['person'] });
const three = (await nvr.getEpisodes({ startMs: scene(8, -60), endMs: scene(8, 120) })).episodes[0];
assert.equal(three.description?.title, 'Человек: Въезд → Входная дверь → Лифт');
await nvr.deleteEvents(['s9-door']);
const two = await nvr.getEpisodeTrace(three.id);
assert.ok(two, 'still two cameras: the episode stays');
assert.deepEqual(Object.values(two.cameras), ['Въезд', 'Лифт']);
const rebuilt = (await nvr.getEpisodes({ startMs: scene(8, -60), endMs: scene(8, 120) })).episodes[0];
assert.equal(rebuilt.description?.title, 'Человек: Въезд → Лифт', 'the title no longer names the deleted camera');
assert.equal(two.links.length, 0, 'links to the deleted event are gone');
await nvr.deleteEvents(['s9-lift']);
assert.equal(await nvr.getEpisodeTrace(three.id), null, 'one camera left: not an episode any more');

// 10. export with no recordings says so instead of producing an empty file
await assert.rejects(nvr.nvrExportEpisode(live.id), /No recordings for this episode/);
await assert.rejects(nvr.nvrExportEpisode('no-such-episode'), /Episode not found/);

// with recordings: one MP4 per camera block, in the player's order, in one ZIP (the MP4s themselves are removed)
const segStore = (nvr as unknown as { store: { addSegment(row: object): number } }).store;
function recording(camera: string, fromSec: number, seconds: number): void {
  const path = join(dir, `${camera}-${fromSec}.ts`);
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc=size=320x240:rate=10`,
    '-t',
    String(seconds),
    '-c:v',
    'libx264',
    '-g',
    '10',
    '-f',
    'mpegts',
    path,
  ];
  const made = spawnSync(FFMPEG, args);
  assert.equal(made.status, 0, `ffmpeg could not make a recording: ${made.stderr?.toString()}`);
  const startUs = scene(0, fromSec) * 1000;
  segStore.addSegment({
    camera_id: camera,
    role: 'high',
    start_us: startUs,
    end_us: startUs + seconds * 1_000_000,
    path,
    bytes: readFileSync(path).length,
    codec: 'h264',
    codec_string: 'avc1.640015',
    width: 320,
    height: 240,
    video_pid: 256,
    audio_pid: -1,
    keyframes: JSON.stringify([[0, startUs]]),
  });
}
recording('gate', -5, 20);
recording('door', 20, 20);
const exported = await nvr.nvrExportEpisode(live.id);
assert.match(exported.filename, /^vion-episode_.*\.zip$/);
const zipDownload = downloads.at(-1)!;
assert.equal(zipDownload.mimeType, 'application/zip');
const zip = readFileSync(zipDownload.filePath);
const names = zipNames(zip);
assert.equal(names.length, 2, `zip entries: ${names.join(', ')}`);
assert.match(names[0], /^01_Въезд_.*\.mp4$/);
assert.match(names[1], /^02_Входная_дверь_.*\.mp4$/);
assert.ok(zip.length > 20_000, 'the clips are in the zip');
assert.deepEqual(readdirSync(dirname(zipDownload.filePath)), [basename(zipDownload.filePath)], 'the intermediate MP4s are removed');

// 11. restart in the middle of a visit: the next camera still joins the same episode
await ingest({ id: 's11-gate', camera: 'gate', at: scene(10, 0), labels: ['person'] });
await ingest({ id: 's11-door', camera: 'door', at: scene(10, 15), labels: ['person'] });
const open = (await nvr.getEpisodes({ startMs: scene(10, -60), endMs: scene(10, 120) })).episodes[0];
(nvr as unknown as { store: { close(): void } }).store.close();
nvr = start();
messages.length = 0;
await nvr.onDetectionEvent((m) => messages.push(m));
await ingest({ id: 's11-lift', camera: 'lift', at: scene(10, 35), labels: ['person'] });
const resumed = (await nvr.getEpisodes({ startMs: scene(10, -60), endMs: scene(10, 120) })).episodes;
assert.equal(resumed.length, 1, 'no second episode after the restart');
assert.equal(resumed[0].id, open.id);
assert.deepEqual(
  resumed[0].members.map((m) => m.eventId),
  ['s11-gate', 's11-door', 's11-lift'],
);

// helpers
assert.deepEqual(
  buildBlocks([
    {
      cameraId: 'a',
      spans: [
        { index: 0, firstSeen: 0, lastSeen: 1000 },
        { index: 1, firstSeen: 2500, lastSeen: 4000 },
      ],
    },
  ]),
  [{ cameraId: 'a', startMs: 0, endMs: 4000 }],
  'spans of one camera closer than 2 s are one block',
);
assert.equal(duration(28_000), '28 с');
assert.equal(duration(172_000), '2 мин 52 с');
assert.equal(duration(3_600_000), '1 ч');
assert.deepEqual(warnings, [], `unexpected warnings: ${warnings.join('\n')}`);

console.log('episodes.spec: links and reasons, live message, blocks, text, trace, mosaic, favorites vs retention, deletion, restart, limits — ok');

/** File names in a ZIP's central directory. */
function zipNames(zip: Buffer): string[] {
  const CENTRAL_ENTRY = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  const names: string[] = [];
  for (let i = zip.indexOf(CENTRAL_ENTRY); i >= 0; i = zip.indexOf(CENTRAL_ENTRY, i + 4)) {
    const length = zip.readUInt16LE(i + 28);
    names.push(zip.subarray(i + 46, i + 46 + length).toString('utf8'));
  }
  return names;
}

/** Width and height from a baseline or progressive JPEG's SOF marker. */
function jpegSize(data: Uint8Array): { width: number; height: number } {
  let i = 2;
  while (i < data.length) {
    const marker = data[i + 1];
    const length = (data[i + 2] << 8) | data[i + 3];
    if (marker >= 0xc0 && marker <= 0xc2) return { height: (data[i + 5] << 8) | data[i + 6], width: (data[i + 7] << 8) | data[i + 8] };
    i += 2 + length;
  }
  throw new Error('no SOF marker');
}
