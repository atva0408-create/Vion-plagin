// The first limit of the host: configureCameras comes before the first answer of getEntitlements (the host's child
// awaits it before FINISH_LAUNCHING), and the recorder took «no answer yet» for the free level: at every restart the
// cameras from the third on did not record and «tariff limit» events poured out. Until the first answer, or the time
// it is waited for, nothing is cut; then the host's limit holds (the free level when it never answered).
// Run: npx tsx spec/first-limit.spec.ts
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import VionNvr from '../src/index.js';
import { Recorder } from '../src/recorder.js';

Recorder.prototype.start = function () {};
Recorder.prototype.stop = async function () {};

const noop = () => undefined;
const BUSINESS = { source: 'cloud', plan: { id: 'business', name: 'Business' }, nvr: { maxCameras: 256, retentionDays: 90 } };
const source = { generateRTSPUrl: () => 'rtsp://127.0.0.1:9/none', urls: {} };
const device = (id: string) =>
  ({
    id,
    name: id,
    recordingSettings: { enabled: true, mode: 'continuous', preBuffer: 0 },
    streamSource: source,
    onPropertyChange: () => ({ subscribe: () => ({ dispose: noop }) }),
  }) as never;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function recorder(getEntitlements: () => Promise<unknown>) {
  const api = {
    storagePath: mkdtempSync(join(tmpdir(), 'nvr-first-limit-')),
    on: noop,
    once: noop,
    emit: noop,
    notificationManager: { publish: async () => undefined },
    coreManager: { assistantAccess: async () => ({ allowed: false }), getFFmpegPath: () => new Promise<string>(noop), getPluginsByInterface: async () => [], getEntitlements },
    proxy: { createProxy: () => ({}) },
  };
  const storage = { values: {} as Record<string, unknown>, getValue: async () => undefined, setValue: async () => undefined };
  return new VionNvr({ log: noop, warn: noop, error: console.error, debug: noop, attention: noop, trace: noop } as never, api as never, storage as never);
}
const limitEvents = async (nvr: VionNvr) => (await nvr.getSystemEvents(undefined as never, {} as never)).events.filter((e) => e.type === 'license');

VionNvr.firstLimitWaitMs = 300;

// ------------------------------------------------------------------ the answer comes after the cameras

{
  let answer: (value: unknown) => void = noop;
  const nvr = recorder(() => new Promise((resolve) => (answer = resolve)));
  await nvr.configureCameras(['a', 'b', 'c', 'd'].map(device));
  const before = await nvr.getRecordingPlan();
  assert.deepEqual(before.overLimit, [], 'no answer yet: nothing is cut');
  assert.equal(before.recording.length, 4);
  assert.equal((await limitEvents(nvr)).length, 0, 'and no «tariff limit» event');
  answer(BUSINESS);
  await sleep(50);
  const after = await nvr.getRecordingPlan();
  assert.deepEqual([after.recording.length, after.overLimit.length, after.maxCameras], [4, 0, 256]);
  assert.equal((await limitEvents(nvr)).length, 0);
}

// ------------------------------------------------------------------ the host never answers: the free level after the wait

{
  const nvr = recorder(() => new Promise(noop));
  await nvr.configureCameras(['a', 'b', 'c'].map(device));
  assert.deepEqual((await nvr.getRecordingPlan()).overLimit, [], 'waiting: nothing is cut');
  await sleep(400);
  const plan = await nvr.getRecordingPlan();
  assert.deepEqual([plan.recording.length, plan.overLimit.length], [2, 1], 'the wait is over: the free level');
}

// ------------------------------------------------------------------ installed on a server older than the licences anyway

{
  // the store installs a plugin whatever its engines say (a warning to accept, «update all» does not read it): on a
  // server before 2.7.0, which says 0 for «no limit of cameras», 0 stays «no limit»
  const root = mkdtempSync(join(tmpdir(), 'nvr-first-limit-server-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@vionvision/server', version: '2.6.49' }));
  const runner = process.argv[1];
  process.argv[1] = join(root, 'dist', 'server', 'plugins', 'runtime', 'node', 'child.js');
  let nvr: VionNvr;
  try {
    nvr = recorder(async () => ({ source: 'cloud', plan: { id: 'business', name: 'Business' }, nvr: { maxCameras: 0, retentionDays: 90 } }));
  } finally {
    process.argv[1] = runner;
  }
  await nvr.configureCameras(['a', 'b', 'c'].map(device));
  await sleep(50);
  const plan = await nvr.getRecordingPlan();
  assert.deepEqual([plan.maxCameras, plan.recording.length, plan.overLimit.length], [256, 3, 0], 'an old server’s 0 is «no limit»');
}

console.log('first-limit.spec: nothing is cut until the first limit of the host, or the wait for it; an older server’s 0 is no limit — ok');
process.exit(0);
