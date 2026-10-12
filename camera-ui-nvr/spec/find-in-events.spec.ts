// The words of a search found in the pictures of events (findInEvents): a call answers at once with the finds made and
// the events still `pending` (the bus ends a call after 30 s, the finder takes longer to load); the pictures go to the
// text finder of a detection plugin one at a time, in the order asked, a plugin without a finder passed over, the loading
// finder asked again; a find carries its crop, an event without a picture is not sent; the finds are kept by query, a
// few events a call; a failure ends the looking of its query and is said once. Run: npx tsx spec/find-in-events.spec.ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import VionNvr from '../src/index.js';

type Answer = {
  query: string;
  loading?: boolean;
  foundScore?: number;
  pictures: { boxes: { x: number; y: number; width: number; height: number; score: number }[]; crop?: Uint8Array }[];
};
const calls: { text: string; pictures: number[]; language?: string }[] = [];
const callTimes: number[] = [];
let running = 0;
let overlapped = false;
let failing: string | undefined;
let loading = 0;
let finders = ['openvino', 'onnx'];
/**
 * The finder sees a bag in a picture whose first byte is odd, scored by the byte, and crops it even when unsure (the
 * recorder keeps the crop of a find only); it loads for the first `loading` calls.
 */
const onnx = {
  findInPictures: async (text: string, images: Uint8Array[], config?: { language?: string }): Promise<Answer> => {
    running++;
    overlapped ||= running > 1;
    await new Promise((resolve) => setTimeout(resolve, 2));
    running--;
    if (failing) throw new Error(failing);
    calls.push({ text, pictures: images.map((image) => image[0]), ...(config?.language ? { language: config.language } : {}) });
    callTimes.push(Date.now());
    if (loading > 0) {
      loading--;
      return { query: text, loading: true, pictures: [] };
    }
    return {
      query: ({ сумка: 'bag', рюкзак: 'backpack' } as Record<string, string>)[text] ?? text,
      foundScore: 0.1,
      pictures: images.map((image) =>
        image[0] % 2 ? { boxes: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.4, score: image[0] / 100 }], crop: new Uint8Array([0xff, 0xd8, image[0]]) } : { boxes: [] },
      ),
    };
  },
};
const otherCalls: string[] = [];
const other = {
  findInPictures: async (text: string, images: Uint8Array[], config?: { language?: string }) => (otherCalls.push(text), onnx.findInPictures(text, images, config)),
};

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
  // OpenVINO has no finder: the call is not even a function there
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

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
/** Asks until nothing is pending, as the page does. */
async function settled(text: string, ids: string[], language?: string) {
  for (let i = 0; i < 2000; i++) {
    const answer = await nvr.findInEvents(text, ids, language);
    if (!answer.pending?.length) return answer;
    await tick();
  }
  throw new Error('still pending');
}
/** Asks until the answer says a problem. */
async function problem(text: string, ids: string[]) {
  for (let i = 0; i < 2000; i++) {
    const answer = await nvr.findInEvents(text, ids);
    if (answer.reason) return answer;
    await tick();
  }
  throw new Error('no problem said');
}

// ---- answered at once: what is known, the rest pending; then the finds, in the order asked, each with what it is
{
  const first = await nvr.findInEvents('сумка', ['bag', 'weak', 'empty', 'blind', 'bag', 'no-such']);
  assert.deepEqual(first.pending, ['bag', 'weak', 'empty'], 'an id asked twice is asked once');
  assert.deepEqual(first.results.map((r) => [r.eventId, r.found, r.boxes.length]), [['blind', false, 0], ['no-such', false, 0]]);
  assert.equal(first.english, undefined, 'the finder has said nothing yet');
  const result = await settled('сумка', ['bag', 'weak', 'empty', 'blind', 'bag', 'no-such']);
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
  );
  assert.deepEqual(result.results[0]!.boxes[0], { x: 0.1, y: 0.2, width: 0.3, height: 0.4, score: 0.41 });
  // a picture a call, in the order asked, only those that are there
  assert.deepEqual(calls, [41, 7, 2].map((byte) => ({ text: 'сумка', pictures: [byte] })));
}

// ---- asked again: kept, the finder not asked; another query is asked
{
  calls.length = 0;
  const again = await nvr.findInEvents('сумка', ['empty', 'bag']);
  assert.deepEqual(calls, []);
  assert.equal(again.pending, undefined);
  assert.deepEqual(again.results.map((r) => [r.eventId, r.found]), [['empty', false], ['bag', true]]);
  assert.deepEqual([again.english, again.foundScore], ['bag', 0.1], 'what the finder made of the query is said again');
  await settled('собака', ['bag']);
  assert.deepEqual(calls, [{ text: 'собака', pictures: [41] }]);
}

// ---- the platform's language goes to the finder; the same words in another language are another search
{
  calls.length = 0;
  await settled('Tasche', ['bag'], 'de');
  assert.deepEqual(calls, [{ text: 'Tasche', pictures: [41], language: 'de' }]);
  await settled('Tasche', ['bag'], 'de');
  assert.equal(calls.length, 1, 'kept with its language');
  await settled('Tasche', ['bag'], 'en');
  await settled('Tasche', ['bag']);
  assert.deepEqual(calls.map((c) => c.language), ['de', 'en', undefined]);
  // pending in two languages at once: each is looked at
  calls.length = 0;
  await nvr.findInEvents('Eimer', ['weak'], 'de');
  await nvr.findInEvents('Eimer', ['weak'], 'en');
  await Promise.all([settled('Eimer', ['weak'], 'de'), settled('Eimer', ['weak'], 'en')]);
  assert.deepEqual(calls.map((c) => c.language).sort(), ['de', 'en']);
}

// ---- asked again while pending: queued once
{
  calls.length = 0;
  await nvr.findInEvents('кот', ['bag', 'weak']);
  await nvr.findInEvents('кот', ['bag', 'weak']);
  await settled('кот', ['bag', 'weak']);
  assert.deepEqual(calls.map((c) => c.pictures[0]), [41, 7]);
}

// ---- the finder that loads is asked again until it has loaded (every 2 s)
{
  calls.length = 0;
  callTimes.length = 0;
  loading = 1;
  const answer = await settled('ведро', ['bag']);
  assert.equal(answer.results[0]!.found, true);
  assert.equal(calls.length, 2);
  assert.ok(callTimes[1]! - callTimes[0]! >= 1900, 'a loading finder is not asked again at once');
}

// ---- the first finder that answers is the only one asked, and first again
{
  finders = ['onnx', 'other'];
  await settled('лопата', ['bag']);
  finders = ['other', 'onnx'];
  await settled('лопата', ['weak']);
  assert.deepEqual(otherCalls, [], 'the one that answered before is asked first');
  finders = ['openvino', 'onnx'];
}

// ---- a few events a call; nothing asked, nothing done
{
  calls.length = 0;
  const many = await settled('коробка', Array.from({ length: 30 }, (_, i) => `more-${i}`));
  assert.equal(many.results.length, 12);
  assert.equal(calls.length, 12);
  assert.deepEqual(await nvr.findInEvents('  ', ['bag']), { query: '', results: [] });
  assert.deepEqual(await nvr.findInEvents('сумка', []), { query: 'сумка', results: [] });
  assert.deepEqual(await nvr.findInEvents('сумка', 'bag' as never), { query: 'сумка', results: [] });
}

// ---- one picture at a time, whatever the queries
{
  overlapped = false;
  await Promise.all([settled('кот2', ['bag']), settled('кошка', ['bag']), settled('пёс', ['weak'])]);
  assert.equal(overlapped, false);
}

// ---- the finds kept are bounded, the oldest go first
{
  calls.length = 0;
  for (let i = 0; i < 420; i++) await settled(`слово ${i}`, ['empty']);
  await settled('слово 0', ['empty']);
  await settled('слово 419', ['empty']);
  assert.equal(calls.length, 421, 'the first was dropped, the last kept');
}

// ---- a failure: said to the next call, once, the rest of its query not looked at; asked again, tried again
{
  calls.length = 0;
  failing = 'model download failed';
  const first = await nvr.findInEvents('лестница', ['bag', 'weak']);
  assert.deepEqual(first.pending, ['bag', 'weak']);
  const failed = await problem('лестница', ['bag', 'weak']);
  assert.deepEqual([failed.reason, failed.error, failed.results], ['failed', 'model download failed', []]);
  assert.ok(warned.some((text) => text.includes('model download failed')));
  failing = undefined;
  const retried = await settled('лестница', ['bag', 'weak']);
  assert.deepEqual(retried.results.map((r) => r.found), [true, false], 'a failure is not kept: asked again it is found anew');
  assert.deepEqual(calls.map((c) => c.pictures[0]), [41, 7], 'the weak one was not looked at in the failed round');
}

// ---- no plugin with a finder: said as no finder, not as a failure
{
  finders = ['openvino'];
  assert.equal((await problem('лестница2', ['bag'])).reason, 'no-finder');
  finders = [];
  assert.equal((await problem('лестница3', ['bag'])).reason, 'no-finder');
  // events without pictures need no finder at all
  assert.deepEqual((await nvr.findInEvents('лестница4', ['blind'])).results.map((r) => r.found), [false]);
}

console.log('find-in-events.spec: answered at once, pending asked again, a picture at a time, the loading finder waited for, kept by query, failures said once OK');
process.exit(0);
