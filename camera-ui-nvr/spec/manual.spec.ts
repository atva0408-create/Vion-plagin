// Manual recording ("record now", mode «По запросу»): the recorder writes a real MPEG-TS stream only inside the
// manual window, stopping it leaves a detection's recording alone; the plugin starts, extends, stops and times out
// a manual recording, refuses cameras it cannot record, and detections do not start an «По запросу» camera.
// Needs ffmpeg with libx264 on PATH (or CAMERAUI_FFMPEG_PATH). Run: npx tsx spec/manual.spec.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import VionNvr from '../src/index.js';
import { Recorder } from '../src/recorder.js';
import { Store } from '../src/store.js';

import type { ManualRecording, RecordedEvent } from '../src/types.js';

const dir = mkdtempSync(join(tmpdir(), 'nvr-manual-'));
const FFMPEG = process.env.CAMERAUI_FFMPEG_PATH ?? 'ffmpeg';
const noop = () => undefined;

// ------------------------------------------------------------------ recorder

const stream = join(dir, 'stream.ts');
const made = spawnSync(FFMPEG, [
  '-hide_banner',
  '-loglevel',
  'error',
  '-y',
  '-f',
  'lavfi',
  '-i',
  'testsrc=size=320x240:rate=10',
  '-t',
  '12',
  '-c:v',
  'libx264',
  '-g',
  '10',
  '-f',
  'mpegts',
  stream,
]);
assert.equal(made.status, 0, `ffmpeg could not make a stream: ${made.stderr?.toString()}`);
const bytes = readFileSync(stream);
const third = Math.floor(bytes.length / 188 / 3) * 188;
const parts = [bytes.subarray(0, third), bytes.subarray(third, 2 * third), bytes.subarray(2 * third)];

function recorder(name: string, states: boolean[]): { rec: Recorder; store: Store; feed(chunk: Buffer): void } {
  const store = new Store(join(dir, `${name}.db`));
  const rec = new Recorder({
    cameraId: name,
    role: 'high',
    rtspUrl: 'rtsp://unused',
    ffmpegPath: FFMPEG,
    dir: join(dir, name),
    store,
    mode: 'event',
    preBufferSec: 0,
    postBufferSec: 0,
    segmentSec: 60,
    log: noop,
    onStateChange: (recording) => states.push(recording),
    onSegment: noop,
  });
  return { rec, store, feed: (chunk) => (rec as unknown as { onData(c: Buffer): void }).onData(Buffer.from(chunk)) };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 200));
const far = () => (Date.now() + 3600_000) * 1000;

{
  const states: boolean[] = [];
  const { rec, store, feed } = recorder('cam-a', states);
  feed(parts[0]);
  assert.equal(rec.isRecording, false, 'an event recorder writes nothing without a reason');
  rec.setManual(far());
  feed(parts[1]);
  assert.equal(rec.isRecording, true, 'the manual window records');
  rec.setManual(0);
  feed(parts[2]);
  await settle();
  assert.equal(rec.isRecording, false, 'ending the manual window stops at the next keyframe');
  assert.deepEqual(states, [true, false]);
  const segments = store.segments('cam-a', 'high', 0, Number.MAX_SAFE_INTEGER);
  assert.equal(segments.length, 1, 'one file for the manual window');
  assert.ok(segments[0].bytes > 10_000, 'the file has the stream');
  await rec.stop();
  store.close();
}
{
  // a detection keeps its recording when the manual one is stopped
  const states: boolean[] = [];
  const { rec, store, feed } = recorder('cam-b', states);
  rec.trigger(far());
  rec.setManual(far());
  feed(parts[0]);
  rec.setManual(0);
  feed(parts[1]);
  // a segment is closed asynchronously: wait, or a stop that did cut it would still read as recording
  await settle();
  assert.equal(rec.isRecording, true, 'stopping by hand must not cut what a detection asked for');
  assert.deepEqual(states, [true], 'the file stays open');
  await rec.stop();
  store.close();
}
{
  // the disk guard stops the recorders and starts them when there is room again: the manual window is still theirs
  const states: boolean[] = [];
  const { rec, store, feed } = recorder('cam-c', states);
  rec.setManual(far());
  feed(parts[0]);
  assert.equal(rec.isRecording, true);
  await rec.stop();
  (rec as unknown as { onStreamEnd(reason: string, startedAt: number): void }).onStreamEnd('stopped', Date.now());
  assert.equal(rec.isRecording, false);
  // the stream of the recorder started again
  feed(parts[1]);
  assert.equal(rec.isRecording, true, 'a recorder stopped and started again goes on with the manual recording');
  assert.deepEqual(states, [true, false, true]);
  await rec.stop();
  assert.equal(store.segments('cam-c', 'high', 0, Number.MAX_SAFE_INTEGER).length, 2, 'a file before the pause and one after it');
  store.close();
}

// ------------------------------------------------------------------ plugin

const api = {
  storagePath: dir,
  on: noop,
  once: noop,
  emit: noop,
  notificationManager: { publish: async () => undefined },
  coreManager: { assistantAccess: async () => ({ allowed: false }), getFFmpegPath: () => new Promise<string>(noop), getPluginsByInterface: async () => [] },
};
const storage = { values: {} as Record<string, unknown>, getValue: async () => undefined, setValue: async () => undefined };
const nvr = new VionNvr({ log: noop, warn: noop, error: console.error, debug: noop, attention: noop, trace: noop } as never, api as never, storage as never);

/** Stands in for the recorders of a camera: remembers what the plugin asked of it. */
function fakeRecorder() {
  return {
    manual: [] as number[],
    triggers: [] as number[],
    setManual(untilUs: number) {
      this.manual.push(untilUs);
    },
    trigger(untilUs: number) {
      this.triggers.push(untilUs);
    },
    stop: async () => undefined,
  };
}
const cams = (nvr as unknown as { cameras: Map<string, unknown> }).cameras;
const recs = { event: fakeRecorder(), adhoc: fakeRecorder(), continuous: fakeRecorder() };
cams.set('ev', {
  device: { id: 'ev', name: 'По событию', recordingSettings: { enabled: true, mode: 'event' } },
  recorders: new Map([['high', recs.event]]),
  subscriptions: [],
});
cams.set('ad', {
  device: { id: 'ad', name: 'По запросу', recordingSettings: { enabled: true, mode: 'adhoc' } },
  recorders: new Map([['high', recs.adhoc]]),
  subscriptions: [],
});
cams.set('co', {
  device: { id: 'co', name: 'Постоянно', recordingSettings: { enabled: true, mode: 'continuous' } },
  recorders: new Map([['high', recs.continuous]]),
  subscriptions: [],
});
cams.set('off', { device: { id: 'off', name: 'Выключена', recordingSettings: { enabled: false, mode: 'event' } }, recorders: new Map(), subscriptions: [] });
cams.set('limit', {
  device: { id: 'limit', name: 'Лимит', recordingSettings: { enabled: true, mode: 'event' } },
  recorders: new Map(),
  subscriptions: [],
  overLimit: true,
});

const heard: ManualRecording[] = [];
await nvr.onManualRecording((s) => heard.push(s));
assert.equal((await nvr.getNvrFeatures()).manualRecording, true);

// start: five minutes by default, the recorders get the window, listeners hear it
const t0 = Date.now();
const started = await nvr.nvrStartRecording('ad');
assert.equal(started.active, true);
assert.ok(Math.abs(started.untilMs! - (t0 + 5 * 60_000)) < 2000, 'five minutes by default');
assert.equal(recs.adhoc.manual.at(-1), started.untilMs! * 1000);
assert.deepEqual(heard.at(-1), started);
assert.deepEqual(await nvr.getManualRecording('ad'), started);

// extending keeps when it started; the length is clamped to 1..120 minutes
await new Promise((resolve) => setTimeout(resolve, 20));
const extended = await nvr.nvrStartRecording('ad', 500);
assert.equal(extended.startedAt, started.startedAt, 'an extension is the same recording');
assert.ok(Math.abs(extended.untilMs! - (Date.now() + 120 * 60_000)) < 2000, 'at most two hours');
assert.ok(Math.abs((await nvr.nvrStartRecording('ev', 0)).untilMs! - (Date.now() + 5 * 60_000)) < 2000, '0 means the default');
assert.ok(Math.abs((await nvr.nvrStartRecording('ev', 1)).untilMs! - (Date.now() + 60_000)) < 2000);

// stop: the window is closed on the recorders and everyone hears it
const stopped = await nvr.nvrStopRecording('ad');
assert.deepEqual(stopped, { cameraId: 'ad', active: false });
assert.equal(recs.adhoc.manual.at(-1), 0);
assert.deepEqual(heard.at(-1), stopped);
assert.deepEqual(await nvr.nvrStopRecording('ad'), stopped, 'stopping twice is harmless');

// a continuous camera already records; a camera without recording or over the plan is refused
assert.deepEqual(await nvr.nvrStartRecording('co'), { cameraId: 'co', active: false });
assert.equal(recs.continuous.manual.length, 0);
await assert.rejects(nvr.nvrStartRecording('off'), /Recording is off/);
await assert.rejects(nvr.nvrStartRecording('limit'), /No free recording slot/);
await assert.rejects(nvr.nvrStartRecording('nope'), /not recorded by ViON NVR/);

// what the assistant hears of a camera is what it does: one set to continuous but over the plan or paused writes
// nothing, and "records all the time" was the answer to a manual recording of it
cams.set('co-limit', {
  device: { id: 'co-limit', name: 'Постоянно сверх тарифа', recordingSettings: { enabled: true, mode: 'continuous' } },
  recorders: new Map(),
  subscriptions: [],
  overLimit: true,
});
const host = (nvr as unknown as { assistantHost(): { recordingMode(id: string): string } }).assistantHost();
assert.equal(host.recordingMode('co'), 'continuous');
assert.equal(host.recordingMode('co-limit'), 'over_plan');
assert.equal(host.recordingMode('off'), 'off');
(nvr as unknown as { paused: boolean }).paused = true;
assert.equal(host.recordingMode('co'), 'paused');
(nvr as unknown as { paused: boolean }).paused = false;
cams.delete('co-limit');

// time up: the recording ends by itself
const realSetTimeout = globalThis.setTimeout;
let fire: (() => void) | undefined;
globalThis.setTimeout = ((fn: () => void) => {
  fire = fn;
  return { unref: noop } as unknown as NodeJS.Timeout;
}) as typeof setTimeout;
await nvr.nvrStartRecording('ad', 1);
globalThis.setTimeout = realSetTimeout;
assert.ok(fire, 'a timer ends the recording');
fire();
assert.deepEqual(await nvr.getManualRecording('ad'), { cameraId: 'ad', active: false });
assert.equal(recs.adhoc.manual.at(-1), 0);
assert.deepEqual(heard.at(-1), { cameraId: 'ad', active: false });

// detections record an «По событию» camera but not an «По запросу» one
const event = (id: string, cameraId: string) =>
  ({ id, cameraId, state: 'active', startTime: Date.now(), lastUpdate: Date.now(), types: ['person'], triggers: [], segments: [] }) as unknown as RecordedEvent;
await nvr.ingestDetectionEvent('ev', 'start', event('d-ev', 'ev'));
await nvr.ingestDetectionEvent('ad', 'start', event('d-ad', 'ad'));
assert.equal(recs.event.triggers.length, 1, 'a detection starts an event camera');
assert.equal(recs.adhoc.triggers.length, 0, 'a detection must not start an «По запросу» camera');

console.log('manual.spec: recorder window, stop keeps detections, start/extend/clamp/stop/time-up, refusals, «По запросу» vs detections — ok');
process.exit(0);
