// Storage and recorder wiring through the real plugin class with a fake host API and a disk whose free space the
// spec sets: the storage statistics name the mode the camera is set to, the quota guard drops the oldest files and
// sums the archive once, a manual recording is refused while the disk guard has paused recording and a running one
// is reported as paused until there is room again, the camera's recording state follows all its streams, and a new
// file length reaches the recorders when it is set.
// Run: npx tsx spec/storage.spec.ts
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import VionNvr from '../src/index.js';
import { Recorder } from '../src/recorder.js';

import type { Store } from '../src/store.js';
import type { ManualRecording, RecordedEvent, RecordingState } from '../src/types.js';

// the disk as the plugin sees it (it reads the free space with statfs)
const disk = { blocks: 1000, bavail: 500, bsize: 4096 };
fsp.statfs = (async () => disk) as unknown as typeof fsp.statfs;
syncBuiltinESMExports();

const dir = mkdtempSync(join(tmpdir(), 'nvr-storage-'));
const noop = () => undefined;
const api = {
  storagePath: dir,
  on: noop,
  once: noop,
  emit: noop,
  notificationManager: { publish: async () => undefined },
  coreManager: { assistantAccess: async () => ({ allowed: false }), getFFmpegPath: () => new Promise<string>(noop), getPluginsByInterface: async () => [] },
};
const storage = { values: { quotaGB: 1, minFreePercent: 3 } as Record<string, unknown>, getValue: async () => undefined, setValue: async () => undefined };
const nvr = new VionNvr({ log: noop, warn: noop, error: console.error, debug: noop, attention: noop, trace: noop } as never, api as never, storage as never);
const internals = nvr as unknown as { cameras: Map<string, unknown>; store: Store; enforceRetention(): Promise<void> };
const store = internals.store;

/** Stands in for a recorder: remembers what the plugin asked of it. */
function fakeRecorder() {
  return {
    isRecording: false,
    liveSegmentId: undefined,
    started: 0,
    stopped: 0,
    manual: [] as number[],
    triggers: [] as number[],
    updates: [] as Record<string, unknown>[],
    start() {
      this.started++;
    },
    async stop() {
      this.stopped++;
    },
    setManual(untilUs: number) {
      this.manual.push(untilUs);
    },
    trigger(untilUs: number) {
      this.triggers.push(untilUs);
    },
    update(opts: Record<string, unknown>) {
      this.updates.push(opts);
    },
  };
}
const source = { generateRTSPUrl: () => 'rtsp://127.0.0.1:9/none', urls: {} };
const device = (id: string, mode: string | undefined, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  recordingSettings: { enabled: true, mode, preBuffer: 0 },
  streamSource: source,
  onPropertyChange: () => ({ subscribe: () => ({ dispose: noop }) }),
  ...extra,
});
const recs = { ev: fakeRecorder(), ad: fakeRecorder(), co: fakeRecorder(), short: fakeRecorder() };
internals.cameras.set('ev', { device: device('ev', 'event'), recorders: new Map([['high', recs.ev]]), subscriptions: [] });
internals.cameras.set('short', { device: device('short', 'event'), recorders: new Map([['high', recs.short]]), subscriptions: [] });
internals.cameras.set('ad', { device: device('ad', 'adhoc'), recorders: new Map([['high', recs.ad]]), subscriptions: [] });
internals.cameras.set('co', { device: device('co', 'continuous'), recorders: new Map([['high', recs.co]]), subscriptions: [] });
// no stream source: these two never get a recorder
internals.cameras.set('ad-new', { device: device('ad-new', 'adhoc', { streamSource: undefined }), recorders: new Map(), subscriptions: [] });
internals.cameras.set('none', { device: device('none', undefined, { streamSource: undefined }), recorders: new Map(), subscriptions: [] });
// recording switched off with the mode kept, and a disabled camera: neither records
const switchedOff = { recordingSettings: { enabled: false, mode: 'continuous', preBuffer: 0 } };
internals.cameras.set('was-on', { device: device('was-on', 'continuous', switchedOff), recorders: new Map(), subscriptions: [] });
internals.cameras.set('never-on', { device: device('never-on', 'event', { recordingSettings: { enabled: false, mode: 'event' } }), recorders: new Map(), subscriptions: [] });
internals.cameras.set('disabled', { device: device('disabled', 'event', { disabled: true }), recorders: new Map(), subscriptions: [] });

// eight files of a quarter GiB, a minute apart, the oldest first; two cameras
const GB = 1024 ** 3;
const now = Date.now();
const files = Array.from({ length: 8 }, (_, i) => {
  const path = join(dir, `seg-${i}.ts`);
  writeFileSync(path, 'x');
  const startUs = (now - (20 - i) * 60_000) * 1000;
  store.addSegment({
    camera_id: i % 2 ? 'ad' : 'ev',
    role: 'high',
    start_us: startUs,
    end_us: startUs + 60_000_000,
    path,
    bytes: GB / 4,
    codec: 'h264',
    codec_string: 'avc1.640028',
    width: 1920,
    height: 1080,
    video_pid: 256,
    audio_pid: -1,
    keyframes: '[[0,0]]',
  });
  return path;
});
// what the switched-off camera recorded while it was on: the newest file, of no size to the quota
writeFileSync(join(dir, 'seg-was-on.ts'), 'x');
store.addSegment({
  camera_id: 'was-on',
  role: 'high',
  start_us: now * 1000 - 120_000_000,
  end_us: now * 1000 - 60_000_000,
  path: join(dir, 'seg-was-on.ts'),
  bytes: 0,
  codec: 'h264',
  codec_string: 'avc1.640028',
  width: 1920,
  height: 1080,
  video_pid: 256,
  audio_pid: -1,
  keyframes: '[[0,0]]',
});

// ------------------------------------------------------------------ the mode in the storage statistics

{
  const { cameras } = await nvr.getStorageStats();
  assert.equal(cameras.ad.recordingMode, 'adhoc', 'a camera recording on request is not reported as recording on events');
  assert.equal(cameras['ad-new'].recordingMode, 'adhoc', 'also before it has recorded anything');
  assert.equal(cameras.ev.recordingMode, 'event');
  assert.equal(cameras.co.recordingMode, 'continuous');
  assert.equal(cameras.none.recordingMode, 'off');
  assert.equal(cameras['was-on'].recordingMode, 'off', 'recording switched off: the camera has an archive and is not reported as recording continuously');
  assert.equal(cameras['was-on'].segmentCount, 1);
  assert.equal(cameras['never-on'].recordingMode, 'off', 'also a camera that never recorded');
  assert.equal(cameras.disabled.recordingMode, 'off', 'a disabled camera does not record whatever its mode');
  assert.equal(cameras.ad.segmentCount, 4);
}

// ------------------------------------------------------------------ the quota guard

{
  let sums = 0;
  const totalBytes = store.totalBytes.bind(store);
  store.totalBytes = () => (sums++, totalBytes());
  // 2 GiB recorded, 1 GiB allowed, plenty of free space
  await internals.enforceRetention();
  store.totalBytes = totalBytes;
  assert.deepEqual(
    files.map((path) => existsSync(path)),
    [false, false, false, false, true, true, true, true],
    'the oldest files go until the archive fits the limit',
  );
  assert.equal(store.totalBytes(), GB);
  assert.equal(store.segments('ev', 'high', 0, Number.MAX_SAFE_INTEGER).length + store.segments('ad', 'high', 0, Number.MAX_SAFE_INTEGER).length, 4);
  assert.equal(sums, 1, 'the archive is summed once for a cleanup, not again for every deleted file');
  assert.equal((await nvr.getStorageStats()).paused, false);
}

// ------------------------------------------------------------------ folders of expired exports

{
  // what the host leaves of an export whose download expired, and an export that is still offered
  const expired = join(dir, 'exports', 'expired');
  const offered = join(dir, 'exports', 'offered');
  mkdirSync(expired, { recursive: true });
  mkdirSync(offered);
  writeFileSync(join(offered, 'clip.mp4'), 'x');
  await internals.enforceRetention();
  assert.equal(existsSync(expired), false, 'the periodic cleanup removes the empty folder of an expired export');
  assert.equal(existsSync(join(offered, 'clip.mp4')), true, 'an export that is still offered is not touched');
}

// ------------------------------------------------------------------ paused by the disk guard

const heard: ManualRecording[] = [];
await nvr.onManualRecording((s) => heard.push(s));
// two manual recordings run when the disk fills up: one for ten minutes, the timer of the other is in the spec's hand
let running: ManualRecording;
let timeUp: (() => void) | undefined;
{
  assert.equal((await nvr.nvrStartRecording('ad', 1)).active, true, 'with room on the disk a manual recording starts');
  await nvr.nvrStopRecording('ad');
  running = await nvr.nvrStartRecording('ev', 10);
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void) => {
    timeUp = fn;
    return { unref: noop } as unknown as NodeJS.Timeout;
  }) as typeof setTimeout;
  const short = await nvr.nvrStartRecording('short', 1);
  globalThis.setTimeout = realSetTimeout;
  assert.deepEqual(await nvr.getManualRecording('ev'), { cameraId: 'ev', active: true, startedAt: running.startedAt, untilMs: running.untilMs });

  // the disk fills up with something else: 0.5 % free, and nothing of the archive is left to delete
  disk.bavail = 5;
  await internals.enforceRetention();
  assert.equal(store.totalBytes(), 0, 'everything that could be deleted was');
  assert.equal((await nvr.getStorageStats()).paused, true);
  assert.equal(recs.ad.stopped, 1, 'the recorders are stopped');

  // nothing is written now: the running recordings are not active, say why, and keep their times
  const paused = (state: ManualRecording): ManualRecording => ({ cameraId: state.cameraId, active: false, startedAt: state.startedAt, untilMs: state.untilMs, reason: 'paused' });
  assert.deepEqual(await nvr.getManualRecording('ev'), paused(running), 'a manual recording is not reported as running while recording is paused');
  assert.deepEqual(heard.slice(-2), [paused(running), paused(short)], 'the listeners hear it for every manual recording');
  // the time of the second one runs out during the pause: it is over, not paused
  timeUp!();
  assert.deepEqual(await nvr.getManualRecording('short'), { cameraId: 'short', active: false });
  assert.deepEqual(heard.at(-1), { cameraId: 'short', active: false });
  const before = { manual: recs.ad.manual.length, heard: heard.length };

  await assert.rejects(nvr.nvrStartRecording('ad'), /paused.*disk space/, 'pressing «Record» while nothing can be written is refused, with the reason');
  await assert.rejects(nvr.nvrStartRecording('ev', 10), /paused/);
  assert.deepEqual(await nvr.getManualRecording('ad'), { cameraId: 'ad', active: false }, 'no manual recording is claimed');
  assert.deepEqual({ manual: recs.ad.manual.length, heard: heard.length }, before, 'the recorders and the listeners hear nothing of it');
  assert.deepEqual(await nvr.getManualRecording('ev'), paused(running), 'a refused extension changes nothing');
}

// ------------------------------------------------------------------ the recording state of a camera with two streams

{
  // added while recording is paused: its recorders are built but not started, the spec plays their state
  await nvr.onCameraAdded(
    device('two', 'continuous', { recordingSettings: { enabled: true, mode: 'continuous', sources: ['high', 'low'] }, highResolutionSource: source, lowResolutionSource: source }) as never,
  );
  const managed = internals.cameras.get('two') as { recorders: Map<string, Recorder> };
  assert.deepEqual([...managed.recorders.keys()], ['high', 'low']);
  const play = (role: string, recording: boolean) => (managed.recorders.get(role) as unknown as { setRecording(r: boolean): void }).setRecording(recording);
  const states: RecordingState['state'][] = [];
  await nvr.onRecordingState('two', (s) => states.push(s.state));
  play('high', true);
  play('low', true);
  play('low', false);
  assert.equal(states.at(-1), 'recording', 'the low stream dropped, the high one still records: the camera records');
  play('high', false);
  assert.deepEqual(states, ['stopped', 'recording', 'recording', 'recording', 'stopped']);
  await nvr.onCameraReleased('two');
}

// ------------------------------------------------------------------ settings reach the running recorders

{
  const field = nvr.storageSchema.find((s) => s.key === 'segmentSeconds') as { onSet?: (value: number, old: number) => Promise<void> };
  assert.equal(typeof field.onSet, 'function', 'the file length is applied when it is set');
  storage.values.segmentSeconds = 30;
  await field.onSet!(30, 60);
  assert.equal(recs.ev.updates.at(-1)?.segmentSec, 30, 'the running recorder cuts files by the new length');
  assert.equal(recs.co.updates.at(-1)?.segmentSec, 30);

  // the post-buffer needs no such hook: it is read from the settings at every detection
  storage.values.postBufferSeconds = 120;
  const event = { id: 'd', cameraId: 'ev', state: 'ended', startTime: Date.now(), endTime: Date.now(), lastUpdate: Date.now(), types: [], triggers: [], segments: [] };
  const at = Date.now();
  await nvr.ingestDetectionEvent('ev', 'end' as never, event as unknown as RecordedEvent);
  assert.ok(Math.abs(recs.ev.triggers.at(-1)! / 1000 - (at + 120_000)) < 2000, 'a detection records for the post-buffer set a moment ago');
}

// ------------------------------------------------------------------ room again: recording resumes

{
  disk.bavail = 500;
  const before = heard.length;
  await internals.enforceRetention();
  assert.equal((await nvr.getStorageStats()).paused, false);
  assert.equal(recs.ad.started, 1, 'the recorders are started again');
  // the manual recording whose time is not up goes on: same recording, same end, and its recorder still has the window
  const resumed = { cameraId: 'ev', active: true, startedAt: running.startedAt, untilMs: running.untilMs };
  assert.deepEqual(await nvr.getManualRecording('ev'), resumed, 'a manual recording paused by the disk guard is active again');
  assert.deepEqual(heard.slice(before), [resumed], 'the listeners hear it, and nothing of the one whose time ran out');
  assert.equal(recs.ev.manual.at(-1), running.untilMs! * 1000);
  assert.deepEqual(await nvr.getManualRecording('short'), { cameraId: 'short', active: false });
  await nvr.nvrStopRecording('ev');
  assert.deepEqual(await nvr.getManualRecording('ev'), { cameraId: 'ev', active: false });
  const started = await nvr.nvrStartRecording('ad');
  assert.equal(started.active, true, 'and a manual recording starts');
  assert.equal(recs.ad.manual.at(-1), started.untilMs! * 1000);
  await nvr.nvrStopRecording('ad');
}

console.log('storage.spec: mode in the statistics, quota guard, export folders, manual recording paused and resumed by the disk guard, state of two streams, file length applied — ok');
process.exit(0);
