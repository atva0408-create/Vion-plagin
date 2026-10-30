// The adds and releases of one camera run one after the other (src/index.ts, onCameraAdded/onCameraReleased). Two adds
// of a camera in a row both released what was there before either had set its own, and the second replaced the first:
// the recorders of the first went on recording beside it with nothing left to stop them, two files of every minute.
// A release right after an add came before it, and the camera recorded though it was gone.
// Run: npx tsx spec/camera-add.spec.ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import VionNvr from '../src/index.js';
import { Recorder } from '../src/recorder.js';

// the recorders that run: started and not stopped (no stream is opened here)
const running = new Set<Recorder>();
Recorder.prototype.start = function (this: Recorder) {
  running.add(this);
};
Recorder.prototype.stop = async function (this: Recorder) {
  // a stop takes a moment: the file being written is closed
  await new Promise((resolve) => setTimeout(resolve, 20));
  running.delete(this);
};

const noop = () => undefined;
const api = {
  storagePath: mkdtempSync(join(tmpdir(), 'nvr-camera-add-')),
  on: noop,
  once: noop,
  emit: noop,
  notificationManager: { publish: async () => undefined },
  coreManager: { assistantAccess: async () => ({ allowed: false }), getFFmpegPath: () => new Promise<string>(noop), getPluginsByInterface: async () => [] },
  proxy: { createProxy: () => ({}) },
};
const storage = { values: {} as Record<string, unknown>, getValue: async () => undefined, setValue: async () => undefined };
const nvr = new VionNvr({ log: noop, warn: noop, error: console.error, debug: noop, attention: noop, trace: noop } as never, api as never, storage as never);
const internals = nvr as unknown as { cameras: Map<string, { recorders: Map<string, Recorder> }> };

const source = { generateRTSPUrl: () => 'rtsp://127.0.0.1:9/none', urls: {} };
const disposed: string[] = [];
const device = (id: string) =>
  ({
    id,
    name: id,
    recordingSettings: { enabled: true, mode: 'continuous', preBuffer: 0 },
    streamSource: source,
    onPropertyChange: () => ({ subscribe: () => ({ dispose: () => disposed.push(id) }) }),
  }) as never;
const runningOf = () => [...running];

// ------------------------------------------------------------------ two adds in a row

await Promise.all([nvr.onCameraAdded(device('gate')), nvr.onCameraAdded(device('gate'))]);
assert.equal(running.size, 1, `one recorder for the stream of the camera, not one of each add: ${running.size}`);
assert.deepEqual(runningOf(), [...internals.cameras.get('gate')!.recorders.values()], 'and it is the one the plugin knows');

// the same over a camera that records: the first add stops the old recorder, the second waits for it
await Promise.all([nvr.onCameraAdded(device('gate')), nvr.onCameraAdded(device('gate')), nvr.onCameraAdded(device('gate'))]);
assert.equal(running.size, 1, `three adds over a recording camera: ${running.size}`);
assert.deepEqual(runningOf(), [...internals.cameras.get('gate')!.recorders.values()]);
assert.equal(disposed.filter((id) => id === 'gate').length, 4, 'five adds: the subscriptions of the four replaced ones are let go');

// ------------------------------------------------------------------ a release right after an add

{
  const added = nvr.onCameraAdded(device('door'));
  const released = nvr.onCameraReleased('door');
  await Promise.all([added, released]);
  assert.equal(internals.cameras.has('door'), false, 'the camera released last is gone');
  assert.equal(runningOf().filter((r) => (r as unknown as { opts: { cameraId: string } }).opts.cameraId === 'door').length, 0, 'and records nothing');
}

// ------------------------------------------------------------------ an add that fails does not hold the next one

{
  const broken = {
    ...(device('yard') as object),
    onPropertyChange: () => {
      throw new Error('no properties');
    },
  } as never;
  // the next one asked while the failing one still runs
  const failing = nvr.onCameraAdded(broken);
  const next = nvr.onCameraAdded(device('yard'));
  await assert.rejects(failing, /no properties/);
  await next;
  assert.equal(runningOf().filter((r) => (r as unknown as { opts: { cameraId: string } }).opts.cameraId === 'yard').length, 1, 'the next add of the camera runs');
}

console.log('camera-add.spec: adds and releases of a camera one after the other: no second recorder, a release after an add is the last word — ok');
process.exit(0);
