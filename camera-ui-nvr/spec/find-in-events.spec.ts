// The words of a search found in the pictures of events (findInEvents): the stored picture of each event goes to the
// text finder of a detection plugin, a plugin without it is passed over, a find carries its crop, an event without a
// picture is not sent; the finds are kept by query, a few events a call, one call at a time; no finder and a failing
// one are said. Run: npx tsx spec/find-in-events.spec.ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import VionNvr from '../src/index.js';

type Answer = { query: string; foundScore?: number; pictures: { boxes: { x: number; y: number; width: number; height: number; score: number }[]; crop?: Uint8Array }[] };
const calls: { text: string; pictures: number[] }[] = [];
let running = 0;
let overlapped = false;
let failing: string | undefined;
let finders = ['openvino', 'onnx'];
/**
 * The finder sees a bag in a picture whose first byte is odd, scored by the byte, and crops it even when unsure (the
 * recorder shows the crop of a find only); slow enough for two calls to meet.
 */
const onnx = {
  findInPictures: async (text: string, images: Uint8Array[]): Promise<Answer> => {
    running++;
    overlapped ||= running > 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    running--;
    if (failing) throw new Error(failing);
    calls.push({ text, pictures: images.map((image) => image[0]) });
    return {
      query: ({ сумка: 'bag', рюкзак: 'backpack' } as Record<string, string>)[text] ?? text,
      foundScore: 0.1,
      pictures: images.map((image) =>
        image[0] % 2
          ? { boxes: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.4, score: image[0] / 100 }], crop: new Uint8Array([0xff, 0xd8, image[0]]) }
          : { boxes: [] },
      ),
    };
  },
};

const otherCalls: string[] = [];
const other = { findInPictures: async (text: string) => void otherCalls.push(text) ?? onnx.findInPictures(text, []) };

const noop = () => undefined;
const warned: string[] = [];
const logger = { log: noop, warn: (text: string) => void warned.push(text), error: console.error, debug: noop, attention: noop, trace: noop };
const api = {
  storagePath: mkdtempSync(join(tmpdir(), 'nvr-find-')),
  on: noop,
  once: noop,
  emit: noop,
  notificationManager: { publish: async () => undefined },
  coreManager: {
    assistantAccess: async () => ({ allowed: false }),
    getFFmpegPath: () => new Promise<string>(noop),
    getPluginsByInterface: async (iface: string) => (iface === 'ClipDetection' ? finders.map((id) => ({ id })) : []),
  },
  // OpenVINO has no finder: the call is not even a function there; a second finder must not be asked after one answered
  proxy: { createProxy: (ns: string) => (ns === 'plugin.onnx.child.rpc' ? onnx : ns === 'plugin.other.child.rpc' ? other : {}) },
};
const storage = { values: {} as Record<string, unknown>, getValue: async () => undefined, setValue: async () => undefined };
const nvr = new VionNvr(logger as never, api as never, storage as never);

const T0 = Date.now() - 3_600_000;
/** An event with a stored picture whose first byte is `byte`, or none. */
async function event(id: string, byte?: number) {
  const ev = { id, cameraId: 'hall', state: 'ended', startTime: T0, endTime: T0 + 5000, lastUpdate: T0 + 5000, types: ['object'], triggers: [], segmentIndex: 0, segments: [] };
  await nvr.ingestDetectionEvent('hall', 'end' as never, ev as never, byte === undefined ? undefined : ({ scene: new Uint8Array([byte, 0xff, 0xd8]) } as never));
}
await event('bag', 41); // a bag, sure
await event('weak', 7); // something like it, not sure enough
await event('empty', 2); // nothing like it
await event('blind'); // no picture
for (let i = 0; i < 30; i++) await event(`more-${i}`, 2);

// ---- the finds of a page, in the order asked, each with what it is
{
  const result = await nvr.findInEvents('сумка', ['bag', 'weak', 'empty', 'blind', 'bag', 'no-such']);
  assert.equal(result.reason, undefined, JSON.stringify(result));
  assert.equal(result.english, 'bag');
  assert.equal(result.foundScore, 0.1);
  assert.deepEqual(
    result.results.map((r) => [r.eventId, r.found, r.boxes.length, r.crop ? [...r.crop] : undefined]),
    [
      ['bag', true, 1, [0xff, 0xd8, 41]],
      ['weak', false, 1, undefined],
      ['empty', false, 0, undefined],
      ['blind', false, 0, undefined],
      ['no-such', false, 0, undefined],
    ],
    'an id asked twice is answered once',
  );
  assert.deepEqual(result.results[0]!.boxes[0], { x: 0.1, y: 0.2, width: 0.3, height: 0.4, score: 0.41 });
  // the pictures went in one call, only those that are there
  assert.deepEqual(calls, [{ text: 'сумка', pictures: [41, 7, 2] }]);
}

// ---- asked again: kept, the finder not asked; another query is asked
{
  calls.length = 0;
  const again = await nvr.findInEvents('сумка', ['empty', 'bag']);
  assert.deepEqual(calls, []);
  assert.deepEqual(again.results.map((r) => [r.eventId, r.found]), [['empty', false], ['bag', true]]);
  assert.equal(again.english, 'bag', 'what the finder made of the query is said again');
  assert.equal(again.foundScore, 0.1);
  await nvr.findInEvents('собака', ['bag']);
  assert.deepEqual(calls, [{ text: 'собака', pictures: [41] }]);
}

// ---- what the finder made of the query is said when the first event asked was kept without it
{
  await nvr.findInEvents('рюкзак', ['blind']);
  const both = await nvr.findInEvents('рюкзак', ['blind', 'bag']);
  assert.deepEqual([both.english, both.foundScore], ['backpack', 0.1]);
}

// ---- the first finder that answers is the only one asked
{
  finders = ['onnx', 'other'];
  await nvr.findInEvents('ведро', ['bag']);
  assert.deepEqual(otherCalls, []);
  finders = ['openvino', 'onnx'];
}

// ---- a few events a call; nothing asked, nothing done
{
  calls.length = 0;
  const many = await nvr.findInEvents('коробка', Array.from({ length: 30 }, (_, i) => `more-${i}`));
  assert.equal(many.results.length, 12);
  assert.equal(calls[0]!.pictures.length, 12);
  assert.deepEqual(await nvr.findInEvents('  ', ['bag']), { query: '', results: [] });
  assert.deepEqual(await nvr.findInEvents('сумка', []), { query: 'сумка', results: [] });
  assert.deepEqual(await nvr.findInEvents('сумка', 'bag' as never), { query: 'сумка', results: [] });
}

// ---- one call at a time
{
  overlapped = false;
  await Promise.all([nvr.findInEvents('кот', ['bag']), nvr.findInEvents('кошка', ['bag']), nvr.findInEvents('пёс', ['weak'])]);
  assert.equal(overlapped, false);
}

// ---- the finds kept are bounded, the oldest go first
{
  calls.length = 0;
  for (let i = 0; i < 420; i++) await nvr.findInEvents(`слово ${i}`, ['empty']);
  await nvr.findInEvents('слово 0', ['empty']);
  await nvr.findInEvents('слово 419', ['empty']);
  assert.equal(calls.length, 421, 'the first was dropped, the last kept');
}

// ---- no finder, a failing finder: said, nothing kept
{
  finders = ['openvino'];
  const none = await nvr.findInEvents('лестница', ['bag']);
  assert.equal(none.reason, 'failed');
  finders = [];
  assert.equal((await nvr.findInEvents('лестница', ['bag'])).reason, 'no-finder');
  finders = ['onnx'];
  failing = 'model download failed';
  const failed = await nvr.findInEvents('лестница', ['bag']);
  assert.deepEqual([failed.reason, failed.error, failed.results], ['failed', 'model download failed', []]);
  assert.ok(warned.some((text) => text.includes('model download failed')));
  failing = undefined;
  calls.length = 0;
  assert.equal((await nvr.findInEvents('лестница', ['bag'])).results[0]!.found, true);
  assert.equal(calls.length, 1, 'a failure is not kept: asked again it is found anew');
  // events without pictures need no finder at all
  finders = [];
  assert.deepEqual((await nvr.findInEvents('лестница', ['blind'])).results.map((r) => r.found), [false]);
}

console.log('find-in-events.spec: finds with crops, the plugin without a finder passed over, kept by query, a few a call, one at a time, bounded, failures said OK');
process.exit(0);
