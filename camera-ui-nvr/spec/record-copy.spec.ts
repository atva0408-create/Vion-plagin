// An H.265 camera has a source that is its own stream made H.264 for browsers; the server tells it as copyOf (the id
// of its original). Recorded beside the original it kept nothing new at 3.6 times the size: it is not recorded then.
// Recorded alone, or a stream of the camera's own, it is recorded as before. Run: npx tsx spec/record-copy.spec.ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import VionNvr from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'nvr-record-copy-'));
const noop = () => undefined;
const api = {
  storagePath: dir,
  on: noop,
  once: noop,
  emit: noop,
  notificationManager: { publish: async () => undefined },
  downloadManager: { createDownload: async () => ({ url: '' }) },
  coreManager: { assistantAccess: async () => ({ allowed: false }), getFFmpegPath: () => new Promise<string>(noop), getPluginsByInterface: async () => [] },
};
const storage = { values: {} as Record<string, unknown>, getValue: async () => undefined, setValue: async () => undefined };
const nvr = new VionNvr({ log: noop, warn: noop, error: console.error, debug: noop, attention: noop, trace: noop } as never, api as never, storage as never);

interface Internals {
  ready: Promise<void>;
  paused: boolean;
  cameras: Map<string, Managed>;
  syncRecorders(managed: Managed): void;
}
interface Managed {
  device: unknown;
  recorders: Map<string, { stop(): Promise<void> }>;
  subscriptions: unknown[];
}
const internals = nvr as unknown as Internals;

const source = (id: string, copyOf?: string) => ({
  _id: id,
  ...(copyOf ? { copyOf } : {}),
  urls: {},
  generateRTSPUrl: () => `rtsp://127.0.0.1:9/${id}`,
});

/** The roles a camera records with these sources and these roles asked for. */
function recordedRoles(id: string, sources: { high?: unknown; mid?: unknown; low?: unknown }, roles: string[]): string[] {
  const device = {
    id,
    name: id,
    recordingSettings: { enabled: true, mode: 'continuous', sources: roles },
    highResolutionSource: sources.high,
    midResolutionSource: sources.mid,
    lowResolutionSource: sources.low,
    streamSource: sources.high ?? sources.mid ?? sources.low,
  };
  const managed: Managed = { device, recorders: new Map(), subscriptions: [] };
  internals.cameras.set(id, managed);
  internals.syncRecorders(managed);
  return [...managed.recorders.keys()].sort();
}

async function main(): Promise<void> {
  await internals.ready;
  // the recorders are made, not started: nothing here connects anywhere
  internals.paused = true;

  assert.deepEqual(recordedRoles('copy', { high: source('h'), low: source('l', 'h') }, ['high', 'low']), ['high'], 'a copy of the recorded original is not recorded');
  assert.deepEqual(recordedRoles('alone', { high: source('h'), low: source('l', 'h') }, ['low']), ['low'], 'recorded alone, the copy is recorded');
  assert.deepEqual(recordedRoles('own', { high: source('h'), low: source('l') }, ['high', 'low']), ['high', 'low'], 'the camera’s own low stream is recorded');
  assert.deepEqual(
    recordedRoles('of-mid', { high: source('h'), mid: source('m'), low: source('l', 'm') }, ['high', 'low']),
    ['high', 'low'],
    'a copy of a stream that is not recorded is recorded',
  );
  assert.deepEqual(recordedRoles('of-mid-too', { high: source('h'), mid: source('m'), low: source('l', 'm') }, ['high', 'mid', 'low']), ['high', 'mid']);

  // the server tells the copy later (an update of the camera): the copy's recorder stops, the original's goes on
  const later = { high: source('h'), low: source('l') };
  assert.deepEqual(recordedRoles('later', later, ['high', 'low']), ['high', 'low']);
  const managed = internals.cameras.get('later')!;
  const original = managed.recorders.get('high');
  (managed.device as { lowResolutionSource: unknown }).lowResolutionSource = source('l', 'h');
  internals.syncRecorders(managed);
  assert.deepEqual([...managed.recorders.keys()], ['high']);
  assert.equal(managed.recorders.get('high'), original, 'the original goes on recording');

  for (const camera of internals.cameras.values()) await Promise.all([...camera.recorders.values()].map((r) => r.stop()));
  console.log('record-copy.spec: a copy of a recorded stream is not recorded, a copy alone and own streams are — ok');
  finished = true;
  process.exit(0);
}

// a wait nothing ends empties Node's loop and the process ended with 0 without its checks: that is a failure
let finished = false;
process.on('exit', (code) => {
  if (!finished && code === 0) {
    console.error('the spec ended before its last check: something waits for what never comes');
    process.exitCode = 1;
  }
});
main()
  .then(() => {
    finished = true;
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
