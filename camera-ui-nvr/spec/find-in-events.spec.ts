// The words of a search found in the pictures of events (findInEvents): a call answers at once with the finds made and
// the events still `pending` (the bus ends a call after 30 s, the finder takes longer to load); the pictures go to the
// text finder of a detection plugin one at a time, in the order asked, a plugin without a finder passed over, the loading
// finder asked again; a find carries its crop, an event without a picture is not sent; the finds are kept by query, a
// few events a call; a failure ends the looking of its query and is said once; the query asked last goes first, one
// nobody asks for any more is left. Run: npx tsx spec/find-in-events.spec.ts
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
/** how long the finder takes a picture, ms */
let slow = 2;
let finders = ['openvino', 'onnx'];
/** The bus not answering the question of which plugins find (a call cut after 30 s, NATS reconnecting). */
let pluginsFail: string | undefined;
// a promise of the recorder nobody awaits that fails ends the recorder's process: the plugin runtime has no handler
const unhandled: unknown[] = [];
process.on('unhandledRejection', (reason) => void unhandled.push(reason));
/**
 * The finder sees a bag in a picture whose first byte is odd, scored by the byte, and crops it even when unsure (the
 * recorder keeps the crop of a find only); it loads for the first `loading` calls.
 */
const onnx = {
  findInPictures: async (text: string, images: Uint8Array[], config?: { language?: string }): Promise<Answer> => {
    running++;
    overlapped ||= running > 1;
    await new Promise((resolve) => setTimeout(resolve, slow));
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

const silent = {
  findInPictures: async () => {
    throw new Error('No responders available');
  },
};
const made: Record<string, number> = {};

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
    getPluginsByInterface: async (iface: string) => {
      if (pluginsFail) throw new Error(pluginsFail);
      return iface === 'ClipDetection' ? finders.map((id) => ({ id, name: `@vionvision/camera-ui-${id}` })) : [];
    },
  },
  // OpenVINO has no finder: the call is not even a function there. A proxy knows the methods its plugin had when it
  // first answered: the first made for `updated` is of the plugin before an update that brought the finder; `silent`
  // has no finder and was never asked before: the call goes out, nobody answers it.
  proxy: {
    createProxy: (ns: string) => {
      made[ns] = (made[ns] ?? 0) + 1;
      if (ns === 'plugin.updated.child.rpc') return made[ns] === 1 ? {} : onnx;
      if (ns === 'plugin.silent.child.rpc') return silent;
      return ns === 'plugin.onnx.child.rpc' ? onnx : ns === 'plugin.other.child.rpc' ? other : {};
    },
  },
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

// ---- the engine chosen in the settings is asked first; one not installed leaves the search as it was
{
  finders = ['onnx', 'other'];
  storage.values.pictureSearchEngine = '@vionvision/camera-ui-other';
  await settled('грабли', ['bag']);
  assert.deepEqual(otherCalls, ['грабли'], 'the chosen one, though another answered before');
  const field = nvr.storageSchema.find((s) => s.key === 'pictureSearchEngine') as { enum: string[]; enumLabels: Record<string, string> };
  assert.deepEqual(field.enum, ['', '@vionvision/camera-ui-onnx', '@vionvision/camera-ui-other']);
  assert.equal(field.enumLabels['@vionvision/camera-ui-other'], 'other');
  storage.values.pictureSearchEngine = '@vionvision/camera-ui-gone';
  otherCalls.length = 0;
  const kept = await settled('вилы', ['bag']);
  assert.equal(kept.results[0]!.found, true, 'found by another engine');
  // the choice of an engine no longer here stays to be seen and changed
  const again = nvr.storageSchema.find((s) => s.key === 'pictureSearchEngine') as { enum: string[]; enumLabels: Record<string, string> };
  assert.ok(again.enum.includes('@vionvision/camera-ui-gone'));
  assert.match(again.enumLabels['@vionvision/camera-ui-gone']!, /не установлен/);
  delete storage.values.pictureSearchEngine;
  otherCalls.length = 0;
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

// ---- an engine updated while the recorder ran (ONNX 1.7.0 brought the finder): its proxy, made before, knew no finder,
// and the search said there was none until the recorder restarted. A plugin without the method answers no call.
{
  finders = ['updated'];
  const found = await settled('гиря', ['bag']);
  assert.equal(found.reason, undefined, JSON.stringify(found));
  assert.equal(found.results[0]?.found, true);
  assert.equal(made['plugin.updated.child.rpc'], 2, 'made anew once');
  await settled('гиря', ['weak']);
  assert.equal(made['plugin.updated.child.rpc'], 2, 'the new one kept');
  finders = ['silent'];
  const none = await problem('гиря2', ['bag']);
  assert.equal(none.reason, 'no-finder', JSON.stringify(none));
  finders = ['openvino', 'onnx'];
}

// ---- the bus failing while a picture waits: said to the next call, the recorder goes on, asked again it is found
{
  finders = ['openvino', 'onnx'];
  pluginsFail = 'RPC call to "rpc.coreManager.rpc.getPluginsByInterface" timed out after 30000ms';
  const failed = await problem('стремянка', ['bag']);
  assert.deepEqual([failed.reason, failed.error], ['failed', pluginsFail]);
  await tick();
  assert.deepEqual(unhandled, [], 'nothing left failing unawaited');
  pluginsFail = undefined;
  const again = await settled('стремянка', ['bag']);
  assert.equal(again.results[0]?.found, true, JSON.stringify(again));
}

// ---- an empty picture file (an empty attachment, a write cut short at a stop or on a full disk) is no picture: the
// next picture of the event is looked at, else it has none. Sent to the finder, it failed the call, and the whole search.
{
  calls.length = 0;
  const ev = (id: string) => ({ id, cameraId: 'hall', state: 'ended', startTime: T0, endTime: T0 + 5000, lastUpdate: T0 + 5000, types: ['object'], triggers: [], segmentIndex: 0, segments: [] });
  await nvr.ingestDetectionEvent('hall', 'end' as never, ev('hollow') as never, { card: new Uint8Array(0), scene: new Uint8Array([41, 0xff, 0xd8]) } as never);
  await nvr.ingestDetectionEvent('hall', 'end' as never, ev('void') as never, { scene: new Uint8Array(0) } as never);
  const answer = await settled('чемодан', ['hollow', 'void']);
  assert.deepEqual(answer.results.map((r) => [r.eventId, r.found]), [['hollow', true], ['void', false]]);
  assert.deepEqual(calls.map((c) => c.pictures), [[41]], 'the scene of the first, nothing of the second');
}

// ---- the page asks every 2 s while it looks. The query asked last goes first: the pictures of one typed before it (the
// page gone on to another) hold up none of it. A query nobody asked for in 30 s is left: its pictures are not looked
// at, its failure is not told to a search of the same words another day.
{
  const realNow = Date.now;
  let later = 0;
  Date.now = () => realNow() + later;
  const stool = () => calls.filter((c) => c.text === 'табуретка').length;
  try {
    calls.length = 0;
    slow = 30;
    const twelve = Array.from({ length: 12 }, (_, i) => `more-${i}`);
    await nvr.findInEvents('табуретка', twelve);
    await tick();
    later += 20_000;
    const next = await settled('ящик', ['bag']);
    assert.equal(next.results[0]?.found, true);
    const first = calls.findIndex((c) => c.text === 'ящик');
    assert.ok(first <= 1, `the pictures of the query typed before went first: ${first}`);

    // left: what is looked at stops after the picture in hand
    later += 30_001;
    const was = stool();
    for (let i = 0; i < 30; i++) await tick();
    assert.ok(stool() - was <= 1, `a left query looked at on: ${stool() - was} more`);
    assert.ok(stool() < 12);
    // asked again, it is looked at again from where it was left
    slow = 2;
    const back = await settled('табуретка', twelve);
    assert.equal(back.results.length, 12);
    assert.equal(stool(), 12, 'each picture looked at once');

    // the finder loading (minutes: ≈720 MB downloaded): a left query is not waited for, the finder not asked for it again
    loading = 1000;
    const loads = calls.length;
    await nvr.findInEvents('гвоздь', ['bag']);
    for (let i = 0; i < 100 && calls.length === loads; i++) await tick();
    later += 30_001;
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    assert.equal(calls.filter((c) => c.text === 'гвоздь').length, 1, 'asked once, while asked for');
    loading = 0;
    assert.equal((await settled('гвоздь', ['bag'])).results[0]?.found, true, 'asked again, looked at');

    // a failure nobody was told of is not told to a search another day
    failing = 'model download failed';
    const warnings = warned.length;
    await nvr.findInEvents('табурет', ['bag', 'weak']);
    for (let i = 0; i < 100 && warned.length === warnings; i++) await tick();
    assert.ok(warned.slice(warnings).some((text) => text.includes('model download failed')), 'it failed');
    failing = undefined;
    later += 86_400_000;
    calls.length = 0;
    const again = await settled('табурет', ['bag', 'weak']);
    assert.equal(again.reason, undefined, JSON.stringify(again));
    assert.deepEqual(again.results.map((r) => r.found), [true, false]);
    assert.equal(calls.length, 2, 'looked at anew');
  } finally {
    Date.now = realNow;
    slow = 2;
    loading = 0;
    failing = undefined;
  }
}

// ---- the engines are listed for the choice at the start, before anyone searched
{
  // the host's copy of the settings is told the new choices
  const changed: { key: string; enum: string[] }[] = [];
  const hosted = { ...storage, values: {}, hasSchema: (key: string) => key === 'pictureSearchEngine', changeSchema: async (key: string, schema: { enum: string[] }) => void changed.push({ key, enum: schema.enum }) };
  const fresh = new VionNvr(logger as never, { ...api, storagePath: mkdtempSync(join(tmpdir(), 'nvr-find-start-')) } as never, hosted as never);
  await (fresh as unknown as { start(): Promise<void> }).start();
  for (let i = 0; i < 100 && (fresh.storageSchema.find((s) => s.key === 'pictureSearchEngine') as { enum: string[] }).enum.length < 2; i++) await tick();
  assert.deepEqual((fresh.storageSchema.find((s) => s.key === 'pictureSearchEngine') as { enum: string[] }).enum, ['', '@vionvision/camera-ui-onnx', '@vionvision/camera-ui-openvino']);
  assert.deepEqual(changed, [{ key: 'pictureSearchEngine', enum: ['', '@vionvision/camera-ui-onnx', '@vionvision/camera-ui-openvino'] }]);
  await (fresh as unknown as { stop(): Promise<void> }).stop();
}

assert.deepEqual(unhandled, []);
console.log('find-in-events.spec: answered at once, pending asked again, a picture at a time, the loading finder waited for, kept by query, failures said once, the newest query first, a left one dropped, the engine chosen in the settings OK');
process.exit(0);
