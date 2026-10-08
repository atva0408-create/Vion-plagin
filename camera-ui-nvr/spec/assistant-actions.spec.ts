// The assistant tools of the NVR that look at the recording and the disk, and the ones that act: name, ignore and
// forget a face, record by hand, delete recordings. A fake host stands in for the recorder, so each tool is checked
// on what it reads and on what it asks the recorder to do (and that a preview, or a refusal, asks for nothing).
// Run: npx tsx spec/assistant-actions.spec.ts
import assert from 'node:assert/strict';

import { callAssistantTool, forecast, gapsOf } from '../src/assistant.js';

import type { AssistantToolContext, AssistantToolResult } from '@camera.ui/sdk';
import type { AssistantHost, UnknownSighting } from '../src/assistant.js';
import type { FaceProfile } from '../src/faces.js';
import type { ManualRecording, RecordedEvent, RecordingSegment, StorageStats, SystemEvent } from '../src/types.js';

// The server's clock runs on UTC here, the person lives in Moscow: on a machine whose own zone is Moscow the old
// reading (by the server's zone) gave the same instants, and these tests could not fail.
process.env.TZ = 'UTC';

const admin: AssistantToolContext = { userId: 'u1', role: 'admin', language: 'ru', timezone: 'Europe/Moscow' };
const user: AssistantToolContext = { ...admin, role: 'user' };
const H = 3600_000;
const T0 = Date.parse('2026-10-07T00:00:00Z');

function event(id: string, cameraId: string, start: number, faces: string[] = [], favorite = false): RecordedEvent {
  return {
    id,
    cameraId,
    state: 'ended',
    startTime: start,
    endTime: start + 5000,
    types: ['person'],
    segments: [
      { firstSeen: start, lastSeen: start + 5000, detections: [{ label: 'person' }], attributes: faces.map((label) => ({ type: 'face', label, confidence: 0.9 })) },
    ],
    ...(favorite ? { favorite: true } : {}),
  } as unknown as RecordedEvent;
}

/** An event the camera lost someone in and found them again: a segment each time, with the faces seen in it. */
function segmented(id: string, cameraId: string, start: number, segments: string[][]): RecordedEvent {
  return {
    ...event(id, cameraId, start),
    segments: segments.map((faces, i) => ({
      firstSeen: start + i * 10_000,
      lastSeen: start + i * 10_000 + 5000,
      detections: [{ label: 'person' }],
      attributes: faces.map((label) => ({ type: 'face', label, confidence: 0.9 })),
    })),
  } as unknown as RecordedEvent;
}

/** A recorder in memory; `calls` lists what the tools asked it to do. */
function fakeHost(over: Partial<AssistantHost> = {}) {
  const calls: unknown[][] = [];
  const events = new Map<string, RecordedEvent>([
    ['ev-one', event('ev-one', 'cam-yard', T0 + 2 * H, ['unknown'])],
    ['ev-two', event('ev-two', 'cam-yard', T0 + 3 * H, ['unknown', 'Папа'])],
    ['ev-dad', event('ev-dad', 'cam-door', T0 + 4 * H, ['Папа'])],
    ['ev-none', event('ev-none', 'cam-door', T0 + 5 * H)],
    ['ev-fav', event('ev-fav', 'cam-yard', T0 + 26 * H, [], true)],
  ]);
  const unknown: UnknownSighting[] = [
    { id: 'u-1', eventId: 'ev-one', seg: 0, attr: 0, cameraId: 'cam-yard', timestamp: T0 + 2 * H, clusterId: 'c-1' },
    { id: 'u-2', eventId: 'ev-two', seg: 0, attr: 0, cameraId: 'cam-yard', timestamp: T0 + 3 * H, clusterId: 'c-1' },
    { id: 'u-3', eventId: 'ev-x', seg: 0, attr: 0, cameraId: 'cam-door', timestamp: T0 + 1 * H },
  ];
  const known: FaceProfile[] = [{ name: 'Папа', imageCount: 4, createdAt: 0, updatedAt: 0, thumbnail: new Uint8Array([1, 2, 3]) }];
  const host: AssistantHost = {
    events: (ids, opts) => ({
      events: [...events.values()].filter(
        (ev) =>
          (!ids || ids.includes(ev.cameraId)) &&
          (opts.startMs === undefined || ev.startTime >= opts.startMs) &&
          (opts.endMs === undefined || ev.startTime <= opts.endMs) &&
          (!opts.favoritesOnly || ev.favorite),
      ),
      hasMore: false,
    }),
    event: (id) => events.get(id),
    cameras: () => [
      { id: 'cam-yard', name: 'Двор' },
      { id: 'cam-door', name: 'Дверь' },
      { id: 'cam-door2', name: 'Дверь гаража' },
    ],
    search: async () => [],
    picture: async () => undefined,
    coverage: async () => [],
    systemEvents: async () => [],
    storage: async () => storage(),
    minFreePercent: () => 5,
    knownFaces: async () => known,
    unknownFaces: () => unknown,
    faceCrop: (eventId, seg, attr) => new Uint8Array([0xff, 0xd8, seg, attr, eventId.length]),
    nameFace: async (...args) => (calls.push(['nameFace', ...args]), 1),
    ignoreFaces: async (sighting) => void calls.push(['ignoreFaces', sighting.id, sighting.clusterId]),
    forgetFace: async (name) => void calls.push(['forgetFace', name]),
    manual: async (cameraId) => ({ cameraId, active: false }),
    startManual: async (cameraId, minutes): Promise<ManualRecording> => (
      calls.push(['startManual', cameraId, minutes]),
      { cameraId, active: true, untilMs: T0 + minutes * 60_000 }
    ),
    stopManual: async (cameraId): Promise<ManualRecording> => (calls.push(['stopManual', cameraId]), { cameraId, active: false }),
    recordingMode: (cameraId) => (cameraId === 'cam-door' ? 'continuous' : 'event'),
    deletable: () => ({ segments: 12, bytes: 1.5 * 1024 ** 3 }),
    deleteRange: async (cameraId, startMs, endMs) => (calls.push(['deleteRange', cameraId, startMs, endMs]), { startMs: startMs + 1000, endMs: endMs - 1000 }),
    ...over,
  };
  return { host, calls };
}

function storage(over: Partial<StorageStats> = {}): StorageStats {
  return {
    diskTotalGB: 1000,
    diskUsedGB: 600,
    diskFreeGB: 400,
    diskFreePercent: 40,
    nvrUsedGB: 500,
    nvrQuotaGB: 0,
    retentionDays: 14,
    smallVolume: false,
    paused: false,
    cameras: {
      'cam-yard': {
        usedBytes: 300 * 1024 ** 3,
        segmentCount: 1,
        oldestDay: '2026-09-23',
        newestDay: '2026-10-07',
        daysCount: 15,
        bandwidthMBh: 1024,
        recordingMode: 'continuous',
        isRecording: true,
      },
      'cam-door': {
        usedBytes: 200 * 1024 ** 3,
        segmentCount: 1,
        oldestDay: '2026-09-23',
        newestDay: '2026-10-07',
        daysCount: 15,
        bandwidthMBh: 1024,
        recordingMode: 'continuous',
        isRecording: true,
      },
    },
    ...over,
  };
}

const call = (host: AssistantHost, name: string, input: Record<string, unknown>, ctx = admin) => callAssistantTool(host, name, input, ctx);
const content = <T>(result: AssistantToolResult) => {
  assert.equal(result.error, undefined, result.error);
  return result.content as T;
};

// ------------------------------------------------------------------ recording_health
{
  const segs: RecordingSegment[] = [
    { startTime: T0, endTime: T0 + 2 * H },
    // 30 s: a reconnect, not a gap
    { startTime: T0 + 2 * H + 30_000, endTime: T0 + 5 * H },
    // 3 h gap, then recorded to the end
    { startTime: T0 + 8 * H, endTime: T0 + 24 * H },
  ];
  assert.deepEqual(gapsOf(segs, T0, T0 + 24 * H), [{ start: T0 + 5 * H, end: T0 + 8 * H }], 'a gap under a minute is no gap');
  assert.deepEqual(gapsOf([], T0, T0 + H), [{ start: T0, end: T0 + H }], 'nothing recorded is one gap over the whole range');

  const lost: SystemEvent = { id: 's1', type: 'stream', severity: 'error', cameraId: 'cam-yard', timestamp: T0 + 5 * H - 60_000, message: 'Поток потерян' };
  const { host } = fakeHost({
    coverage: async (cameraId) => (cameraId === 'cam-yard' ? segs : [{ startTime: T0, endTime: T0 + 24 * H }]),
    systemEvents: async () => [lost],
  });
  type Health = {
    cameras: {
      camera: string;
      recordedPercent: number;
      gaps: number;
      longestGaps?: { start: string; minutes: number; cause?: string }[];
      now: { mode: string; note?: string };
    }[];
  };
  const day = { from: new Date(T0).toISOString(), to: new Date(T0 + 24 * H).toISOString() };
  const health = content<Health>(await call(host, 'recording_health', { cameras: ['Двор', 'Дверь'], ...day }));
  const yard = health.cameras.find((c) => c.camera === 'Двор')!;
  assert.equal(yard.gaps, 1);
  assert.equal(yard.longestGaps![0].minutes, 180);
  assert.equal(yard.longestGaps![0].start, new Date(T0 + 5 * H).toISOString());
  assert.match(yard.longestGaps![0].cause ?? '', /Поток потерян/, 'the stream lost a minute before the gap is its cause');
  assert.equal(yard.recordedPercent, 87.5);
  assert.equal(yard.now.mode, 'event');
  assert.match(yard.now.note ?? '', /by design/, 'a camera on events: gaps between events are not a failure');
  const door = health.cameras.find((c) => c.camera === 'Дверь')!;
  assert.deepEqual([door.recordedPercent, door.gaps, door.now], [100, 0, { mode: 'continuous' }]);
  assert.match((await call(host, 'recording_health', { cameras: ['Сарай'] })).error ?? '', /Unknown camera/);

  // recorded the whole day, over the plan or paused only now: that is the state at this moment, not what the day was
  for (const [mode, why] of [['over_plan', /no free recording slot/], ['paused', /not enough free disk space/]] as const) {
    const now = fakeHost({ coverage: async () => [{ startTime: T0, endTime: T0 + 24 * H }], recordingMode: () => mode });
    const [row] = content<Health>(await call(now.host, 'recording_health', { cameras: ['Дверь'], ...day })).cameras;
    assert.deepEqual(Object.keys(row), ['camera', 'recordedPercent', 'gaps', 'now'], `${mode}: the period says only what was recorded`);
    assert.deepEqual([row.recordedPercent, row.gaps], [100, 0], mode);
    assert.equal(row.now.mode, mode);
    assert.match(row.now.note ?? '', why, mode);
    assert.match(row.now.note ?? '', /at this moment/i, `${mode}: the note says it is the state now`);
  }
}

// ------------------------------------------------------------------ storage_forecast
{
  // 2 cameras × 1 GB/h = 48 GB a day; room = 500 used + (400 free − 50 kept free) = 850 GB → 17 days; retention 14 is shorter
  const byRetention = forecast(storage(), 5);
  assert.deepEqual([byRetention.daysOfSpace, byRetention.limitedBy, byRetention.archiveDays], [17, 'retention', 14]);
  const longRetention = forecast(storage({ retentionDays: 30 }), 5);
  assert.deepEqual([longRetention.daysOfSpace, longRetention.limitedBy, longRetention.archiveDays], [17, 'disk', 17], 'the disk fills before 30 days');
  const quota = forecast(storage({ retentionDays: 30, nvrQuotaGB: 480 }), 5);
  assert.deepEqual([quota.daysOfSpace, quota.limitedBy], [10, 'quota'], 'a quota under the disk room is the limit');
  assert.equal(forecast(storage({ cameras: {} }), 5).writingMBPerDay, 0, 'nothing recording, nothing fills');
  // a camera on events is not recording between them and still fills the disk: by what it wrote, 150 GB in 15 days
  const base = storage();
  const onEvents = forecast(
    storage({ retentionDays: 30, cameras: { ...base.cameras, 'cam-gate': { ...base.cameras['cam-yard'], usedBytes: 150 * 1024 ** 3, recordingMode: 'event', isRecording: false } } }),
    5,
  );
  assert.deepEqual([onEvents.writingGBPerDay, onEvents.daysOfSpace], [58, 14], 'the event camera counts its 10 GB a day');

  const { host } = fakeHost({ storage: async () => storage({ paused: true }) });
  const answer = content<Record<string, unknown>>(await call(host, 'storage_forecast', {}));
  assert.equal(Object.keys(answer)[0], 'paused', 'paused recording is said first');
  assert.deepEqual(
    (answer.cameras as { camera: string }[]).map((c) => c.camera),
    ['Двор', 'Дверь'],
    'cameras by name',
  );
}

// ------------------------------------------------------------------ list_faces
{
  const { host } = fakeHost();
  type Faces = { known: { name: string; pictures: number }[]; unknownGroups: { faces: number; cameras: string[]; eventId: string }[]; unknownAlone?: { faces: number } };
  const faces = content<Faces>(await call(host, 'list_faces', {}, user));
  assert.deepEqual(faces.known, [{ name: 'Папа', pictures: 4 }]);
  assert.deepEqual(
    faces.unknownGroups,
    [{ faces: 2, cameras: ['Двор'], lastSeen: new Date(T0 + 3 * H).toISOString(), eventId: 'ev-two' }],
    'a group names its latest event',
  );
  assert.equal(faces.unknownAlone?.faces, 1);
}

// ------------------------------------------------------------------ name_face
{
  const { host, calls } = fakeHost();
  const named = content<{ done: boolean; name: string }>(await call(host, 'name_face', { eventId: 'ev-one', name: 'Маша' }));
  assert.equal(named.done, true);
  assert.deepEqual(calls, [['nameFace', 'ev-one', 0, 0, 'unknown', 'Маша']], 'the unknown face of the event is learned under the name');

  calls.length = 0;
  const corrected = content<{ was: string }>(await call(host, 'name_face', { eventId: 'ev-dad', name: 'Иван' }));
  assert.equal(corrected.was, 'Папа');
  assert.deepEqual(calls, [['nameFace', 'ev-dad', 0, 0, 'Папа', 'Иван']], '"that is not dad": the known face is corrected');

  calls.length = 0;
  const several = await call(host, 'name_face', { eventId: 'ev-two', name: 'Маша' });
  assert.match(several.error ?? '', /2 faces: 1\. unknown; 2\. Папа/, 'several faces: the list, nothing named');
  assert.deepEqual(calls, []);
  await call(host, 'name_face', { eventId: 'ev-two', name: 'Маша', face: 1 });
  assert.deepEqual(calls, [['nameFace', 'ev-two', 0, 0, 'unknown', 'Маша']], '`face` picks one');

  calls.length = 0;
  assert.match((await call(host, 'name_face', { eventId: 'ev-none', name: 'Маша' })).error ?? '', /no face/);
  assert.match((await call(host, 'name_face', { eventId: 'nope', name: 'Маша' })).error ?? '', /No event/);
  assert.equal(content<{ done: boolean }>(await call(host, 'name_face', { eventId: 'ev-dad', name: 'папа' })).done, false, 'already that name');

  const preview = await call(host, 'name_face', { eventId: 'ev-one', name: 'Маша', __preview: true });
  assert.deepEqual((preview.content as { preview: Record<string, unknown> }).preview, {
    action: 'name_face',
    camera: 'Двор',
    at: new Date(T0 + 2 * H).toISOString(),
    name: 'Маша',
  });
  assert.equal(preview.images?.[0]?.mimeType, 'image/jpeg', 'the card shows the face');
  assert.deepEqual(calls, [], 'a preview names nobody');

  assert.match((await call(host, 'name_face', { eventId: 'ev-one', name: 'Маша' }, user)).error ?? '', /administrator/, 'a user cannot, even if a call gets here');
  assert.deepEqual(calls, []);
}

// ------------------------------------------------------------------ name_face: one person over several segments
{
  const events = new Map<string, RecordedEvent>([
    ['ev-back', segmented('ev-back', 'cam-yard', T0 + 6 * H, [['unknown'], ['unknown']])],
    ['ev-dad-back', segmented('ev-dad-back', 'cam-door', T0 + 7 * H, [['Папа'], ['Папа']])],
    ['ev-loose', segmented('ev-loose', 'cam-yard', T0 + 8 * H, [['unknown'], ['unknown']])],
    ['ev-half', segmented('ev-half', 'cam-yard', T0 + 9 * H, [['unknown'], ['unknown']])],
    ['ev-groups', segmented('ev-groups', 'cam-yard', T0 + 10 * H, [['unknown'], ['unknown']])],
    ['ev-pair', segmented('ev-pair', 'cam-yard', T0 + 11 * H, [['unknown', 'unknown']])],
  ]);
  const at = (eventId: string, seg: number, clusterId?: string): UnknownSighting => ({
    id: `u-${eventId}-${seg}`,
    eventId,
    seg,
    attr: 0,
    cameraId: 'cam-yard',
    timestamp: T0,
    ...(clusterId ? { clusterId } : {}),
  });
  // ev-loose and ev-pair have no sighting in the list (older than it, or no vector): nothing identifies their faces
  const unknown = [at('ev-back', 0, 'c-9'), at('ev-back', 1, 'c-9'), at('ev-half', 0, 'c-7'), at('ev-groups', 0, 'c-7'), at('ev-groups', 1, 'c-8')];
  const { host, calls } = fakeHost({ event: (id) => events.get(id), unknownFaces: () => unknown });

  const named = await call(host, 'name_face', { eventId: 'ev-back', name: 'Маша' });
  assert.equal(named.error, undefined, 'one person seen twice is one face, not "2 faces: 1. unknown; 2. unknown"');
  assert.deepEqual(
    calls,
    [
      ['nameFace', 'ev-back', 0, 0, 'unknown', 'Маша'],
      ['nameFace', 'ev-back', 1, 0, 'unknown', 'Маша'],
    ],
    'the same group of unknown faces: both sightings get the name',
  );

  calls.length = 0;
  const corrected = content<{ was: string }>(await call(host, 'name_face', { eventId: 'ev-dad-back', name: 'Иван' }));
  assert.equal(corrected.was, 'Папа');
  assert.deepEqual(
    calls,
    [
      ['nameFace', 'ev-dad-back', 0, 0, 'Папа', 'Иван'],
      ['nameFace', 'ev-dad-back', 1, 0, 'Папа', 'Иван'],
    ],
    'one known name twice is one person, corrected in both',
  );

  calls.length = 0;
  for (const id of ['ev-loose', 'ev-half']) {
    const loose = await call(host, 'name_face', { eventId: id, name: 'Маша' });
    assert.match(loose.error ?? '', /2 faces: 1\. unknown; 2\. unknown/, `${id}: unknown faces nothing identifies are still asked about`);
    assert.match(loose.error ?? '', /may be the same person/, `${id}: and said to be maybe one`);
  }
  const groups = await call(host, 'name_face', { eventId: 'ev-groups', name: 'Маша' });
  assert.match(groups.error ?? '', /2 faces/);
  assert.doesNotMatch(groups.error ?? '', /same person/, 'two groups of unknown faces are two people');
  const pair = await call(host, 'name_face', { eventId: 'ev-pair', name: 'Маша' });
  assert.match(pair.error ?? '', /2 faces/);
  assert.doesNotMatch(pair.error ?? '', /same person/, 'two faces at the same moment are two people');
  assert.deepEqual(calls, [], 'nothing named while asking');

  const ignored = content<{ ignored: number }>(await call(host, 'ignore_face', { eventId: 'ev-back' }));
  assert.equal(ignored.ignored, 2, 'ignore_face takes the person seen twice too');
  assert.deepEqual(calls, [['ignoreFaces', 'u-ev-back-0', 'c-9']]);
}

// ------------------------------------------------------------------ ignore_face, forget_face
{
  const { host, calls } = fakeHost();
  const ignored = content<{ ignored: number }>(await call(host, 'ignore_face', { eventId: 'ev-one' }));
  assert.equal(ignored.ignored, 2, 'the whole group of the face');
  assert.deepEqual(calls, [['ignoreFaces', 'u-1', 'c-1']]);
  assert.match((await call(host, 'ignore_face', { eventId: 'ev-dad' })).error ?? '', /recognized as Папа/, 'a known face is not ignored');

  calls.length = 0;
  const preview = await call(host, 'forget_face', { name: 'папа', __preview: true });
  assert.deepEqual((preview.content as { preview: unknown }).preview, { action: 'forget_face', name: 'Папа', pictures: 4 });
  assert.equal(preview.images?.length, 1);
  assert.deepEqual(calls, []);
  const forgotten = content<{ forgotten: string; note: string }>(await call(host, 'forget_face', { name: 'папа' }));
  assert.equal(forgotten.forgotten, 'Папа');
  assert.match(forgotten.note, /Past events keep the name/);
  assert.deepEqual(calls, [['forgetFace', 'Папа']]);
  assert.match((await call(host, 'forget_face', { name: 'Маша' })).error ?? '', /Known: Папа/);
}

// ------------------------------------------------------------------ manual_recording
{
  const { host, calls } = fakeHost();
  const started = content<{ done: boolean; until: string }>(await call(host, 'manual_recording', { camera: 'двор', action: 'start', minutes: 10 }));
  assert.equal(started.done, true);
  assert.equal(started.until, new Date(T0 + 10 * 60_000).toISOString());
  assert.deepEqual(calls, [['startManual', 'cam-yard', 10]]);

  calls.length = 0;
  const always = content<{ done: boolean; reason: string }>(await call(host, 'manual_recording', { camera: 'Дверь', action: 'start' }));
  assert.match(always.reason, /records all the time/, 'continuous recording: nothing to start');
  assert.deepEqual(calls, []);
  assert.match((await call(host, 'manual_recording', { camera: 'Двер', action: 'start' })).error ?? '', /exact name/, 'an action takes the exact name, not a part');
  await call(host, 'manual_recording', { camera: 'Двор', action: 'stop' });
  assert.deepEqual(calls, [['stopManual', 'cam-yard']]);

  const off = fakeHost({
    startManual: async () => {
      throw new Error('Recording is off for this camera');
    },
  });
  assert.match((await call(off.host, 'manual_recording', { camera: 'Двор', action: 'start' })).error ?? '', /Двор: Recording is off/, 'the recorder says why');

  // set to record all the time, but over the plan or paused: it writes nothing, and the answer says why
  for (const [mode, why] of [['over_plan', /no free recording slot/], ['paused', /paused/]] as const) {
    const stuck = fakeHost({ recordingMode: () => mode });
    const answer = content<{ done: boolean; reason: string }>(await call(stuck.host, 'manual_recording', { camera: 'Дверь', action: 'start' }));
    assert.equal(answer.done, false);
    assert.match(answer.reason, why, mode);
    assert.doesNotMatch(answer.reason, /all the time/, mode);
  }
}

// ------------------------------------------------------------------ delete_recordings
{
  const { host, calls } = fakeHost();
  const from = new Date(T0 + 2 * H).toISOString();
  const to = new Date(T0 + 3 * H).toISOString();

  const preview = await call(host, 'delete_recordings', { camera: 'Двор', from, to, __preview: true });
  assert.deepEqual((preview.content as { preview: unknown }).preview, {
    action: 'delete_recordings',
    camera: 'Двор',
    from,
    to,
    segments: 12,
    bytes: 1.5 * 1024 ** 3,
    favorites: 0,
  });
  assert.deepEqual(calls, [], 'a preview deletes nothing');

  const done = content<{ deleted: boolean; from: string; to: string }>(await call(host, 'delete_recordings', { camera: 'Двор', from, to }));
  assert.equal(done.deleted, true);
  assert.deepEqual([done.from, done.to], [new Date(T0 + 2 * H + 1000).toISOString(), new Date(T0 + 3 * H - 1000).toISOString()], 'what was deleted in fact');
  assert.deepEqual(calls, [['deleteRange', 'cam-yard', T0 + 2 * H, T0 + 3 * H]]);

  calls.length = 0;
  assert.match((await call(host, 'delete_recordings', { camera: 'Двор', from, to: new Date(T0 + 26 * H + 1).toISOString() })).error ?? '', /24 hours/, 'more than a day');
  const favorites = { camera: 'Двор', from: new Date(T0 + 25 * H).toISOString(), to: new Date(T0 + 27 * H).toISOString() };
  assert.match((await call(host, 'delete_recordings', favorites)).error ?? '', /Favorite events/, 'a favorite in the range: refused');
  assert.deepEqual(calls, [], 'nothing deleted on a refusal');
  await call(host, 'delete_recordings', { ...favorites, includeFavorites: true });
  assert.equal(calls.length, 1, 'only when the user said favorites go too');

  calls.length = 0;
  assert.match((await call(host, 'delete_recordings', { camera: 'Двор', from, to }, user)).error ?? '', /administrator/);
  const nothing = fakeHost({ deletable: () => ({ segments: 0, bytes: 0 }) });
  assert.match(JSON.stringify(content(await call(nothing.host, 'delete_recordings', { camera: 'Двор', from, to }))), /Nothing recorded/);
  assert.deepEqual(nothing.calls, [], 'nothing to delete: the recorder is not asked');
  assert.deepEqual(calls, []);

  // "delete from 2 to 3" without an offset is 2 to 3 in Moscow, whatever the clock of the server says
  const local = fakeHost();
  await call(local.host, 'delete_recordings', { camera: 'Двор', from: '2026-10-07T05:00', to: '2026-10-07T06:00' });
  assert.deepEqual(local.calls, [['deleteRange', 'cam-yard', T0 + 2 * H, T0 + 3 * H]], 'local time of the person');
  assert.match((await call(local.host, 'delete_recordings', { camera: 'Двор', from: '7 октября 5:00', to: '2026-10-07T06:00' })).error ?? '', /ISO/);
}

console.log('assistant-actions.spec: recording_health, storage_forecast, faces, manual_recording, delete_recordings OK');
process.exit(0);
