// Events other extensions report in their own words (VOICE: «Сыночка за компьютером во время сна»), through the real
// NVR plugin class with a fake host API. Run: npx tsx spec/external.spec.ts
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import VionNvr from '../src/index.js';
import { checkExternalEvent, DEFAULT_RECORD_SECONDS } from '../src/external.js';

const dir = mkdtempSync(join(tmpdir(), 'nvr-external-'));
const noop = () => undefined;
const warnings: string[] = [];
const logger = { log: noop, warn: (...a: unknown[]) => void warnings.push(a.join(' ')), error: console.error, debug: noop, attention: noop, trace: noop };
const asked: string[] = [];
const api = {
  storagePath: dir,
  on: noop,
  once: noop,
  emit: noop,
  notificationManager: { publish: async () => undefined },
  coreManager: {
    assistantAccess: async () => ({ allowed: true, model: 'qwen2.5-vl', vision: true, language: 'ru' }),
    assistantAsk: async (req: { prompt: string }) => {
      asked.push(req.prompt);
      return { ok: true, text: '', json: { title: 'x', description: 'x', tags: [] }, usage: { promptTokens: 1, completionTokens: 1 } };
    },
    getFFmpegPath: () => new Promise<string>(noop),
    getPluginsByInterface: async () => [],
  },
  proxy: { createProxy: () => ({}) },
};
const storage = { values: { aiDescriptions: true } as Record<string, unknown>, getValue: async () => undefined, setValue: async () => undefined };
const nvr = new VionNvr(logger as never, api as never, storage as never);

// a camera that records by events: what the event asks of its recorder
const triggered: number[] = [];
(nvr as unknown as { cameras: Map<string, unknown> }).cameras.set('kids', {
  device: { id: 'kids', name: 'Детская', recordingSettings: { mode: 'events' } },
  recorders: new Map([['high', { trigger: (untilUs: number) => void triggered.push(untilUs) }]]),
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
let failures = 0;
async function check(name: string, run: () => Promise<void> | void): Promise<void> {
  try {
    await run();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures++;
    console.log(`not ok - ${name}`);
    console.log(error);
  }
}

await check('the event is kept with its words, starts the recording of a camera that records by events, and closes by itself', async () => {
  const began = Date.now() - 6 * 60_000;
  const before = Date.now();
  const result = await nvr.addExternalEvent('kids', {
    source: 'voice',
    title: 'Сыночка за компьютером во время сна',
    description: 'Три напоминания без ответа: 22:30, 22:33, 22:36. VOICE сообщил родителям.',
    tags: ['время за компьютером', 'сон'],
    startTime: began,
    recordSeconds: 1,
    snapshot: jpeg,
  });
  assert.match(result.eventId, /^voice-/);
  assert.equal(result.startTime, began);
  assert.ok(result.endTime >= before + 1000);

  const open = await nvr.getEvent(result.eventId);
  assert.ok(open, 'stored');
  assert.equal(open.state, 'active');
  assert.deepEqual(open.types, ['voice']);
  assert.equal(open.startTime, began);
  assert.equal(open.ai?.title, 'Сыночка за компьютером во время сна');
  assert.ok(existsSync(join(dir, 'thumbs', 'kids', result.eventId.replace(/[^\w-]/g, '_'), 'event.jpg')), 'the snapshot is the event picture');
  assert.equal(triggered.length, 1, 'the recorder was asked to record');
  assert.ok(triggered[0]! >= (before + 30_000) * 1000, 'while the event is open, and its post-buffer');

  await sleep(1300);
  const closed = await nvr.getEvent(result.eventId);
  assert.equal(closed?.state, 'ended');
  assert.ok(closed?.endTime && closed.endTime >= before + 1000);
  assert.equal(closed?.ai?.description, 'Три напоминания без ответа: 22:30, 22:33, 22:36. VOICE сообщил родителям.', 'the end keeps the words');
  assert.equal(triggered.length, 2, 'the end sets the post-buffer');
  assert.equal(asked.length, 0, 'the AI describer leaves it alone');
});

await check('the search finds it by its words, the type filter by its source', async () => {
  const words = await nvr.getEvents({ search: 'напоминания без ответа', limit: 10 } as never);
  assert.equal(words.events.length, 1);
  const byType = await nvr.getEvents({ types: ['voice'], limit: 10 } as never);
  assert.equal(byType.events.length, 1);
});

await check('what does not make an event is refused with the reason', async () => {
  const now = 1_000_000_000_000;
  const good = { source: 'voice', title: 'T', description: 'D' };
  for (const [camera, input, reason] of [
    ['', good, /cameraId/],
    ['kids', { ...good, source: 'Voice!' }, /source/],
    ['kids', { ...good, title: '  ' }, /title/],
    ['kids', { ...good, title: 'x'.repeat(121) }, /title/],
    ['kids', { ...good, description: 'x'.repeat(2001) }, /description/],
    ['kids', { ...good, tags: ['a', 7] }, /tags/],
    ['kids', { ...good, recordSeconds: 301 }, /recordSeconds/],
    ['kids', { ...good, recordSeconds: -1 }, /recordSeconds/],
    ['kids', { ...good, startTime: Number.NaN }, /startTime/],
    ['kids', { ...good, snapshot: new Uint8Array(5 * 1024 * 1024 + 1) }, /snapshot/],
    ['kids', { ...good, snapshot: 'jpeg' }, /snapshot/],
    ['kids', null, /object/],
  ] as const) {
    assert.throws(() => checkExternalEvent(camera, input, now), reason as RegExp, JSON.stringify(input)?.slice(0, 60));
  }
  assert.equal(checkExternalEvent('kids', { ...good, startTime: now + 60_000 }, now).startTime, now, 'not in the future');
  assert.equal(checkExternalEvent('kids', { ...good, startTime: now - 3 * 24 * 3600_000 }, now).startTime, now - 24 * 3600_000, 'a day back at most');
  assert.equal(checkExternalEvent('kids', good, now).recordSeconds, DEFAULT_RECORD_SECONDS);
  await assert.rejects(nvr.addExternalEvent('kids', { ...good, source: 'BAD' }), /source/);
});

await check('a stop clears the timers of open external events (the next start closes what stayed open)', async () => {
  const result = await nvr.addExternalEvent('kids', { source: 'voice', title: 'T', description: 'D', recordSeconds: 300 });
  assert.equal((nvr as unknown as { externalTimers: Set<unknown> }).externalTimers.size, 1);
  // the fake camera has no subscriptions to release
  (nvr as unknown as { cameras: Map<string, unknown> }).cameras.delete('kids');
  await (nvr as unknown as { stop(): Promise<void> }).stop();
  assert.equal((nvr as unknown as { externalTimers: Set<unknown> }).externalTimers.size, 0, 'no timer left to fire into a closed store');
  void result;
});

console.log(failures ? `${failures} failed` : 'all passed');
if (warnings.length) console.log('warnings:', warnings.join(' | '));
process.exit(failures ? 1 : 0);
