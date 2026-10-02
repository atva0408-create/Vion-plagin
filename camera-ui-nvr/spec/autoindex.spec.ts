// The search by description must find an event without anybody running the re-index: events of motion alone
// carry no vector from the detection plugin, so the NVR embeds their stored picture by itself, a portion at a
// time. Through the real NVR plugin class with a fake host and a fake CLIP plugin.
// Run: npx tsx spec/autoindex.spec.ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { API_EVENT } from '@camera.ui/sdk';

import VionNvr from '../src/index.js';

const dim = 16;
const vec = (concept: number): number[] => Array.from({ length: dim }, (_, i) => (i === concept ? 1 : 0));
/** The fake plugin tells a picture's content by its first byte. */
const CONTENT: Record<number, number> = { 3: 2, 4: 6, 5: 7 };
const TEXT: Record<string, number> = { dog: 2, courier: 6, parcel: 7, 'a photo': 3 };

let failing: Error | undefined;
let unreadable = new Set<number>();
const embedCalls: number[][] = [];
const clip = {
  getTextEmbedding: async (text: string) => ({ embedding: vec(TEXT[text] ?? 5), embeddingModel: 'clip-test', scoreBand: [0.1, 0.9] as [number, number] }),
  getTextEmbeddings: async (text: string) => [{ embedding: vec(TEXT[text] ?? 5), embeddingModel: 'clip-test', scoreBand: [0.1, 0.9] as [number, number] }],
  embedImages: async (images: Uint8Array[]) => {
    embedCalls.push(images.map((image) => image[0]!));
    if (failing) throw failing;
    return images.map((image) => (unreadable.has(image[0]!) ? undefined : { embeddings: [{ embedding: vec(CONTENT[image[0]!] ?? 9) }], embeddingModel: 'clip-test', scoreBand: [0.1, 0.9] }));
  },
};

let clipPlugins = [{ id: 'onnx' }];
const log: string[] = [];
const noop = () => undefined;
const hostEvents = new Map<string, () => void>();
const logger = {
  log: (message: string) => log.push(`log: ${message}`),
  warn: (message: string) => log.push(`warn: ${message}`),
  error: (message: string) => log.push(`error: ${message}`),
  debug: noop,
  attention: noop,
  trace: noop,
};
const api = {
  storagePath: mkdtempSync(join(tmpdir(), 'nvr-autoindex-')),
  on: (event: string, handler: () => void) => void hostEvents.set(event, handler),
  once: noop,
  emit: noop,
  notificationManager: { publish: async () => undefined },
  coreManager: {
    assistantAccess: async () => ({ allowed: false }),
    getFFmpegPath: () => new Promise<string>(noop),
    getPluginsByInterface: async (iface: string) => (iface === 'ClipDetection' ? clipPlugins : []),
  },
  proxy: { createProxy: () => clip },
};
const storage = { values: {} as Record<string, unknown>, getValue: async () => undefined, setValue: async () => undefined };
const nvr = new VionNvr(logger as never, api as never, storage as never);
// started as the host starts it: the pass that follows a full portion is asked for by the plugin's own timer.
// Before anything is stored, because the start also clears the archive of what is older than the retention
hostEvents.get(API_EVENT.FINISH_LAUNCHING)!();
/** One pass of the automatic indexing, as its timer makes it. */
const pass = (): Promise<void> => (nvr as unknown as { indexPending(): Promise<void> }).indexPending();
/** Lets a pass started by a timer of the plugin run to its end. */
const idle = async (): Promise<void> => {
  for (let i = 0; i < 1000 && (nvr as unknown as { clipAutoBusy: boolean }).clipAutoBusy; i++) await new Promise((resolve) => setImmediate(resolve));
};

const jpeg = (content: number) => new Uint8Array([content, 0xff, 0xd8, 1, 2, 3]);
function motion(id: string, startTime: number, state = 'ended') {
  return { id, cameraId: 'cam1', state, startTime, endTime: startTime + 5000, lastUpdate: startTime + 5000, types: ['motion'], triggers: [], segmentIndex: 0, segments: [{ firstSeen: startTime, lastSeen: startTime + 5000, zones: [], detections: [], attributes: [] }] };
}
const found = async (text: string) => (await nvr.searchEventsByText(text, 10, 0.5)).map((result) => result.eventId);

// ------------------------------------------------- an event of motion alone is found without a re-index
await nvr.ingestDetectionEvent('cam1', 'end' as never, motion('ev-dog', 1_000) as never, { scene: jpeg(3) } as never);
assert.deepEqual(await found('dog'), [], 'before the indexing ran, the event has no vector: this is the reported state');
await pass();
assert.deepEqual(await found('dog'), ['ev-dog'], 'the event of motion alone is found by what its picture shows');
assert.deepEqual(embedCalls, [[3]]);

// nothing left: the next pass asks the plugin for no picture, and says once that the index is complete
await pass();
assert.deepEqual(embedCalls, [[3]], 'an indexed event is not embedded again');
assert.deepEqual(
  log.filter((line) => line.startsWith('log: Search index')),
  ['log: Search index: 1 event(s) added, every event with a picture can be found now'],
);

// ------------------------------------------------- what happens later is picked up by the passes that follow
await nvr.ingestDetectionEvent('cam1', 'end' as never, motion('ev-courier', 2_000) as never, { scene: jpeg(4) } as never);
// an event still going on has no final picture yet, and one without a picture has nothing to embed
await nvr.ingestDetectionEvent('cam1', 'start' as never, motion('ev-running', 3_000, 'active') as never, { scene: jpeg(5) } as never);
await nvr.ingestDetectionEvent('cam1', 'end' as never, motion('ev-blind', 2_500) as never);
await pass();
assert.deepEqual(await found('courier'), ['ev-courier']);
assert.deepEqual(await found('parcel'), [], 'an event that has not ended is left alone');
assert.deepEqual(embedCalls.at(-1), [4], 'only the ended event with a picture went to the plugin');

// ------------------------------------------------- more events than one portion: several passes, newest first
let soon: (() => void) | undefined;
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((fn: () => void, ms?: number, ...args: unknown[]) => {
  if (ms !== 20_000) return realSetTimeout(fn, ms, ...args);
  soon = fn;
  return { unref: noop } as unknown as NodeJS.Timeout;
}) as typeof setTimeout;
embedCalls.length = 0;
// older than the event without a picture above: the events passed over stay the newest without a vector, as on
// the recorder, and take places in what the index is asked for
for (let i = 0; i < 30; i++) await nvr.ingestDetectionEvent('cam1', 'end' as never, motion(`ev-many-${i}`, 100 + i) as never, { scene: jpeg(3) } as never);
await pass();
assert.equal(embedCalls.flat().length, 24, 'one pass embeds one portion, the plugin also detects on this processor');
assert.ok(embedCalls.every((batch) => batch.length <= 8), 'in batches the plugin answers in time');
assert.ok((await found('dog')).includes('ev-many-29'), 'the newest events come first');
// on the recorder a full portion asked for nothing, and an archive of 500 events was filled 24 events in two minutes
assert.ok(soon, 'events are left behind a full portion: the next one follows in 20 seconds, not at the next interval');
const next = soon;
soon = undefined;
next();
await idle();
assert.equal(embedCalls.flat().length, 30, 'the next pass takes the rest');
assert.equal(soon, undefined, 'nothing is left: no pass is asked for before the interval');
await pass();
await pass();
assert.equal(embedCalls.flat().length, 30, 'and nothing is embedded twice');
globalThis.setTimeout = realSetTimeout;

// ------------------------------------------------- a picture the plugin cannot embed is not sent again
unreadable = new Set([5]);
await nvr.ingestDetectionEvent('cam1', 'end' as never, motion('ev-broken', 50_000) as never, { scene: jpeg(5) } as never);
embedCalls.length = 0;
for (let i = 0; i < 4; i++) await pass();
assert.deepEqual(embedCalls, [[5]], 'sent once, then passed over: every round would spend the plugin on the same picture');
unreadable = new Set();

// ------------------------------------------------- a failing plugin: said once, tried again, caught up after
log.length = 0;
failing = new Error('plugin call timed out');
await nvr.ingestDetectionEvent('cam1', 'end' as never, motion('ev-late', 60_000) as never, { scene: jpeg(4) } as never);
await pass();
await pass();
await pass();
assert.deepEqual(log, ['warn: Search index: new events are not being added: plugin call timed out'], 'the reason is in the log, once');
failing = undefined;
await pass();
assert.ok((await found('courier')).includes('ev-late'), 'the event that could not be indexed is indexed once the plugin answers');

// ------------------------------------------------- without a plugin that embeds pictures nothing is done or said
clipPlugins = [];
log.length = 0;
embedCalls.length = 0;
await nvr.ingestDetectionEvent('cam1', 'end' as never, motion('ev-alone', 70_000) as never, { scene: jpeg(3) } as never);
await pass();
assert.deepEqual([embedCalls, log], [[], []]);
clipPlugins = [{ id: 'onnx' }];

// ------------------------------------------------- the re-index by hand still works, and its failure is logged
failing = new Error('out of memory');
const failed = new Promise<void>((resolve) => void nvr.onClipReindex((status) => !status.running && status.error !== undefined && resolve()));
await nvr.startClipReindex();
await failed;
assert.equal((await nvr.getClipReindexStatus()).error, 'out of memory');
assert.ok(log.includes('warn: Search index: the re-index stopped: out of memory'), `the reason of a failed re-index is in the log: ${log.join(' | ')}`);
failing = undefined;
const done = new Promise<void>((resolve) => void nvr.onClipReindex((status) => !status.running && status.error === undefined && resolve()));
await nvr.startClipReindex();
await done;
assert.ok((await found('dog')).includes('ev-alone'));

console.log('autoindex.spec: events of motion alone are indexed by themselves, in portions, newest first; failures said once — ok');
process.exit(0);
