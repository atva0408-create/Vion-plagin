// Assistant tools of the NVR (src/assistant.ts) through the real plugin class with a fake host API:
// the contract offers them, events come back filtered by range, camera, label, plate and face, a day is
// summarized in the user's time zone, plates are listed, an event's picture is returned.
// Run: npx tsx spec/assistant.spec.ts
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import contract from '../contract.js';
import { dateIn, normalizePlate, startOfDay } from '../src/assistant.js';
import VionNvr from '../src/index.js';

import type { AssistantToolContext } from '@camera.ui/sdk';
import type { RecordedEvent } from '../src/types.js';

const dir = mkdtempSync(join(tmpdir(), 'nvr-assistant-'));
const noop = () => undefined;
const logger = { log: noop, warn: (...a: unknown[]) => console.warn('[warn]', ...a), error: console.error, debug: noop, attention: noop, trace: noop };
const api = {
  storagePath: dir,
  on: noop,
  once: noop,
  emit: noop,
  notificationManager: { publish: async () => undefined },
  coreManager: {
    assistantAccess: async () => ({ allowed: false }),
    getFFmpegPath: () => new Promise<string>(noop),
    getPluginsByInterface: async () => [],
  },
};
const storage = { values: {} as Record<string, unknown>, getValue: async () => undefined, setValue: async () => undefined };
const nvr = new VionNvr(logger as never, api as never, storage as never);

// cameras the NVR manages (only what the tools read: id and name)
const cameras = (nvr as unknown as { cameras: Map<string, { device: { id: string; name: string } }> }).cameras;
cameras.set('cam-gate', { device: { id: 'cam-gate', name: 'Въезд' }, recorders: new Map(), subscriptions: [] } as never);
cameras.set('cam-hall', { device: { id: 'cam-hall', name: 'Входная дверь' }, recorders: new Map(), subscriptions: [] } as never);
// no events: only there so "въезд" is a part of two names and the exact name has to win
cameras.set('cam-yard', { device: { id: 'cam-yard', name: 'Въезд двор' }, recorders: new Map(), subscriptions: [] } as never);

// Moscow, no DST: 2026-09-29 00:00 local is 2026-09-28T21:00:00Z
const MSK = 'Europe/Moscow';
const at = (local: string) => Date.parse(`${local}+03:00`);
const ctx: AssistantToolContext = { userId: 'u1', role: 'admin', language: 'ru', timezone: MSK };

interface Spec {
  id: string;
  camera: string;
  start: number;
  labels?: string[];
  plate?: string;
  face?: string;
  title?: string;
}
function event(s: Spec): RecordedEvent {
  const detections = (s.labels ?? []).map((label) => ({ label, score: 0.9, maxCount: 1 }));
  const attributes = [
    ...(s.plate ? [{ type: 'license_plate', label: s.plate, confidence: 0.9 }] : []),
    ...(s.face ? [{ type: 'face', label: s.face, confidence: 0.9 }] : []),
  ];
  return {
    id: s.id,
    cameraId: s.camera,
    state: 'ended',
    startTime: s.start,
    endTime: s.start + 5000,
    lastUpdate: s.start + 5000,
    types: [...new Set(['motion', ...(s.labels ?? []), ...attributes.map((a) => a.type)])],
    triggers: [{ type: 'motion', firstSeen: s.start, lastSeen: s.start + 1000 }],
    segmentIndex: 0,
    segments: detections.length || attributes.length ? [{ firstSeen: s.start, lastSeen: s.start + 5000, detections, attributes }] : [],
    ...(s.title ? { ai: { title: s.title, description: '', tags: [], at: s.start } } : {}),
  } as unknown as RecordedEvent;
}

const specs: Spec[] = [
  // the day before: must stay out of the 29th
  { id: 'e-28-late', camera: 'cam-gate', start: at('2026-09-28T23:30:00'), labels: ['vehicle'], plate: 'К178УС77' },
  { id: 'e-29-early', camera: 'cam-gate', start: at('2026-09-29T00:10:00'), labels: ['vehicle'], plate: 'К 178 УС 77' },
  { id: 'e-29-person', camera: 'cam-hall', start: at('2026-09-29T08:00:00'), labels: ['person'], face: 'Анна' },
  { id: 'e-29-unknown', camera: 'cam-hall', start: at('2026-09-29T09:00:00'), labels: ['person'], face: 'unknown' },
  { id: 'e-29-titled', camera: 'cam-hall', start: at('2026-09-29T12:00:00'), labels: ['person'], title: 'Курьер оставил коробку у двери' },
  { id: 'e-29-cat', camera: 'cam-gate', start: at('2026-09-29T18:00:00'), labels: ['animal'] },
  { id: 'e-29-motion', camera: 'cam-gate', start: at('2026-09-29T23:59:00') },
  { id: 'e-30-van', camera: 'cam-gate', start: at('2026-09-30T00:00:30'), labels: ['vehicle'], plate: 'А001АА99' },
];
for (const s of specs) await nvr.ingestDetectionEvent(s.camera, 'end' as never, event(s) as never);

const call = (name: string, input: Record<string, unknown>) => nvr.callAssistantTool(name, input, ctx);
const content = <T = Record<string, unknown>>(r: { content?: unknown; error?: string }) => {
  assert.equal(r.error, undefined, `unexpected error: ${r.error}`);
  return r.content as T;
};
const ids = (list: { id: string }[]) => list.map((e) => e.id).sort();

// ------------------------------------------------------------------ declared to the host
assert.ok(contract.interfaces.includes('AssistantTools' as never), 'the contract must list AssistantTools or the host never asks for the tools');
const declared = nvr.assistantTools().map((t) => t.name);
// the server's skills and the daily recap call these names (server/src/assistant/skills.ts, recap.ts)
for (const name of ['query_events', 'summarize_day', 'search_events_by_text', 'list_plates', 'get_event_image']) assert.ok(declared.includes(name), `${name} missing`);
for (const t of nvr.assistantTools()) {
  assert.match(t.name, /^[a-z][a-z0-9_]{1,63}$/, 'the host drops names outside this pattern');
  assert.equal(t.inputSchema.type, 'object');
  assert.ok(t.description.trim().length > 20);
  // a tool that changes something asks in the chat and is an admin's; the rest only read and run unasked, and only
  // list_faces is an admin's read: the faces of every camera, as on the Faces page
  if (t.approval) assert.ok(t.adminOnly, `${t.name}: a change is an admin's`);
  else assert.equal(!!t.adminOnly, t.name === 'list_faces', `${t.name}: adminOnly`);
}
const reading = nvr
  .assistantTools()
  .filter((t) => !t.approval)
  .map((t) => t.name);
assert.deepEqual(reading.sort(), [
  'attribute_time',
  'get_event_image',
  'list_faces',
  'list_plates',
  'query_events',
  'recording_health',
  'search_events_by_text',
  'storage_forecast',
  'summarize_day',
]);

// ------------------------------------------------------------------ query_events
const day29 = { from: new Date(at('2026-09-29T00:00:00')).toISOString(), to: new Date(at('2026-09-29T23:59:59')).toISOString() };
type Brief = { id: string; camera: string; plates?: string[]; faces?: string[]; title?: string };
const all29 = content<{ events: Brief[]; count: number }>(await call('query_events', { ...day29, limit: 50 }));
assert.deepEqual(ids(all29.events), ['e-29-cat', 'e-29-early', 'e-29-motion', 'e-29-person', 'e-29-titled', 'e-29-unknown'], 'range: only the 29th');

const hall = content<{ events: Brief[] }>(await call('query_events', { ...day29, camera: 'входная дверь' }));
assert.deepEqual(ids(hall.events), ['e-29-person', 'e-29-titled', 'e-29-unknown'], 'camera by name, any case');
assert.ok(
  hall.events.every((e) => e.camera === 'Входная дверь'),
  'events carry the camera name, not its id',
);

const gate = content<{ events: Brief[] }>(await call('query_events', { ...day29, camera: 'ВЪЕЗД' }));
assert.deepEqual(ids(gate.events), ['e-29-cat', 'e-29-early', 'e-29-motion'], 'the exact name in any case wins over a longer name containing it');
assert.match((await call('query_events', { camera: 'дв' })).error ?? '', /Unknown camera/, 'a part of two names is not a guess');

const unknownCamera = await call('query_events', { camera: 'Гараж' });
assert.match(unknownCamera.error ?? '', /Гараж.*Въезд.*Входная дверь/, 'an unknown camera names the real ones so the model can retry');

assert.deepEqual(ids(content<{ events: Brief[] }>(await call('query_events', { ...day29, labels: ['animal'] })).events), ['e-29-cat']);
// plates compare without spaces and case: "К 178 УС 77" is the plate К178УС77
const byPlate = content<{ events: Brief[] }>(await call('query_events', { from: new Date(at('2026-09-28T00:00:00')).toISOString(), to: day29.to, plate: 'к178ус77' }));
assert.deepEqual(ids(byPlate.events), ['e-28-late', 'e-29-early']);
assert.deepEqual(ids(content<{ events: Brief[] }>(await call('query_events', { ...day29, face: 'анна' })).events), ['e-29-person']);
assert.equal(all29.events.find((e) => e.id === 'e-29-unknown')?.faces, undefined, '"unknown" is not a person');

const limited = content<{ events: Brief[]; more: boolean; count: number }>(await call('query_events', { ...day29, limit: 2 }));
assert.equal(limited.count, 2);
assert.equal(limited.more, true);
assert.deepEqual(
  limited.events.map((e) => e.id),
  ['e-29-motion', 'e-29-cat'],
  'newest first',
);
assert.match((await call('query_events', { from: 'вчера' })).error ?? '', /from/, 'a bad date is an error the model can fix');
const refs = (await call('query_events', { ...day29, limit: 50 })).references ?? [];
assert.ok(refs.length > 0 && refs.length <= 6, 'a handful of buttons');
assert.ok(
  refs.every((r) => r.kind === 'event' && r.cameraId && typeof r.timestamp === 'number'),
  'an event button needs its camera and time',
);

// ------------------------------------------------------------------ summarize_day
type Day = { date: string; total: number; byCamera: Record<string, number>; byLabel: Record<string, number>; plates: string[]; faces: string[]; events: Brief[] };
const summary = content<Day>(await call('summarize_day', { date: '2026-09-29' }));
assert.equal(summary.date, '2026-09-29');
assert.equal(summary.total, 6, 'local day in the user time zone: 00:10 in, 23:30 of the 28th and 00:00:30 of the 30th out');
assert.deepEqual(summary.byCamera, { Въезд: 3, 'Входная дверь': 3 });
assert.equal(summary.byLabel.person, 3);
assert.deepEqual(summary.faces, ['Анна']);
assert.deepEqual(summary.plates, ['К 178 УС 77']);
assert.ok(
  summary.events.some((e) => e.title === 'Курьер оставил коробку у двери'),
  'the AI title is the headline of its event',
);
const times = summary.events.map((e) => (e as unknown as { start: string }).start);
assert.deepEqual([...times].sort(), times, 'highlights in time order');

const two = content<{ from: string; to: string; days: Day[] }>(await call('summarize_day', { date: '2026-09-30', days: 2 }));
assert.deepEqual([two.from, two.to], ['2026-09-29', '2026-09-30']);
assert.deepEqual(
  two.days.map((d) => [d.date, d.total]),
  [
    ['2026-09-29', 6],
    ['2026-09-30', 1],
  ],
);
assert.match((await call('summarize_day', { date: '29.09.2026' })).error ?? '', /YYYY-MM-DD/);

// ------------------------------------------------------------------ list_plates
type Plate = { plate: string; events: number; cameras: string[] };
const plates = content<{ plates: Plate[] }>(
  await call('list_plates', { from: new Date(at('2026-09-28T00:00:00')).toISOString(), to: new Date(at('2026-09-30T23:00:00')).toISOString() }),
);
assert.deepEqual(
  plates.plates.map((p) => [p.plate, p.events]),
  [
    ['А001АА99', 1],
    ['К178УС77', 2],
  ],
  'spellings of one plate are one plate, newest seen first',
);
assert.deepEqual(plates.plates[1].cameras, ['Въезд']);

// ------------------------------------------------------------------ get_event_image
const picture = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
// where the NVR keeps an event picture
const thumbDir = (nvr as unknown as { thumbDir(cameraId: string, eventId: string): string }).thumbDir('cam-hall', 'e-29-titled');
mkdirSync(thumbDir, { recursive: true });
writeFileSync(join(thumbDir, 'event.jpg'), picture);
const image = await call('get_event_image', { eventId: 'e-29-titled' });
assert.equal(image.error, undefined);
assert.equal(image.images?.[0]?.mimeType, 'image/jpeg');
assert.deepEqual(Buffer.from(image.images![0].data, 'base64'), picture);
assert.equal(image.references?.[0]?.id, 'e-29-titled');
const noPicture = await call('get_event_image', { eventId: 'e-29-cat' });
assert.equal(noPicture.images, undefined);
assert.match(JSON.stringify(noPicture.content), /no saved picture/);
assert.match((await call('get_event_image', { eventId: 'nope' })).error ?? '', /nope/);

// ------------------------------------------------------------------ search_events_by_text
// no text encoder in this test: an empty search says why instead of pretending
const search = content<{ count: number; hint?: string }>(await call('search_events_by_text', { text: 'курьер с коробкой' }));
assert.equal(typeof search.count, 'number');
assert.match((await call('search_events_by_text', {})).error ?? '', /text/);

// ------------------------------------------------------------------ the acting tools through the real recorder
// an unknown face of e-29-unknown, as the recorder keeps it after detection
const faceStore = (nvr as unknown as { faces: { addUnknown(face: Record<string, unknown>): boolean } }).faces;
faceStore.addUnknown({ cameraId: 'cam-hall', eventId: 'e-29-unknown', seg: 0, attr: 0, ts: at('2026-09-29T09:00:00'), model: 'test', embedding: [1, 0, 0] });
const groups = content<{ unknownAlone?: { latest: { eventId: string }[] } }>(await call('list_faces', {}));
assert.equal(groups.unknownAlone?.latest[0]?.eventId, 'e-29-unknown', 'list_faces names the event of an unknown face');
assert.equal(content<{ done: boolean }>(await call('name_face', { eventId: 'e-29-unknown', name: 'Маша' })).done, true);
assert.deepEqual(ids(content<{ events: Brief[] }>(await call('query_events', { ...day29, face: 'маша' })).events), ['e-29-unknown'], 'the event now names Маша');
assert.equal(content<{ unknownAlone?: unknown }>(await call('list_faces', {})).unknownAlone, undefined, 'and the face is no longer unknown');
const nothingRecorded = content<{ preview: { segments: number } }>(
  await call('delete_recordings', { camera: 'Въезд', from: day29.from, to: new Date(at('2026-09-29T12:00:00')).toISOString(), __preview: true }),
);
assert.equal(nothingRecorded.preview.segments, 0, 'nothing recorded, nothing to delete');
assert.match((await call('manual_recording', { camera: 'Въезд', action: 'start' })).error ?? '', /Въезд: Recording is off/, 'the recorder says why');

// ------------------------------------------------------------------ helpers
assert.equal(startOfDay('2026-09-29', MSK), Date.parse('2026-09-28T21:00:00Z'));
assert.equal(startOfDay('2026-03-29', 'Europe/Berlin'), Date.parse('2026-03-28T23:00:00Z'), 'the DST day starts at its local midnight');
assert.equal(startOfDay('2026-03-30', 'Europe/Berlin'), Date.parse('2026-03-29T22:00:00Z'), 'after the switch the offset is +2');
assert.equal(dateIn(Date.parse('2026-09-28T21:30:00Z'), MSK), '2026-09-29');
assert.equal(startOfDay('2026-09-29', 'Not/AZone'), Date.parse('2026-09-29T00:00:00Z'), 'an unknown zone falls back to UTC');
assert.equal(normalizePlate(' a-123 bc '), 'A123BC');
assert.match((await call('no_such_tool', {})).error ?? '', /Unknown tool/);

console.log('assistant.spec: tools declared, query_events, summarize_day, list_plates, get_event_image OK');
process.exit(0);
