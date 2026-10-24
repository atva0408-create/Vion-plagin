// Events recorded before VION 2.6.1 kept a module's question among their types when it was answered only «нет»: the
// plugin takes it out once at its start, a batch at a time, and says how many events it changed.
// Run: npx tsx spec/no-answer-types.spec.ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import VionNvr from '../src/index.js';

import type { RecordedEvent } from '../src/types.js';

const dir = mkdtempSync(join(tmpdir(), 'nvr-no-answers-'));
const noop = () => undefined;
const said: string[] = [];
const logger = { log: (...a: unknown[]) => said.push(a.join(' ')), warn: (...a: unknown[]) => said.push(a.join(' ')), error: console.error, debug: noop, attention: noop, trace: noop };
const api = {
  storagePath: dir,
  on: noop,
  once: noop,
  emit: noop,
  notificationManager: { publish: async () => undefined },
  coreManager: { assistantAccess: async () => ({ allowed: false }), getFFmpegPath: () => new Promise<string>(noop), getPluginsByInterface: async () => [] },
};
const storage = { values: {} as Record<string, unknown>, getValue: async () => undefined, setValue: async () => undefined };

interface Inside {
  store: { upsertEvent(event: RecordedEvent): void; event(id: string): { data: string } | undefined; meta(key: string): string | undefined };
  start(): Promise<void>;
  stop(): Promise<void>;
}
const plugin = () => new VionNvr(logger as never, api as never, storage as never) as unknown as Inside;
const event = (id: string, label: string) =>
  ({
    id,
    cameraId: 'kids',
    state: 'ended',
    // now: the retention at the start clears what is older than the days kept
    startTime: Date.now() - 60_000,
    endTime: Date.now() - 50_000,
    lastUpdate: Date.now() - 50_000,
    types: ['motion', 'person', 'играет в компьютер'],
    triggers: [{ type: 'motion' }],
    segments: [{ firstSeen: 1, lastSeen: 2, detections: [{ label: 'person', score: 0.9 }], attributes: [{ type: 'играет в компьютер', label, confidence: 0.9 }] }],
  }) as unknown as RecordedEvent;
const typesOf = (nvr: Inside, id: string) => (JSON.parse(nvr.store.event(id)!.data) as RecordedEvent).types;
const settle = async (nvr: Inside) => {
  for (let i = 0; i < 50 && nvr.store.meta('types_without_no_answers') !== 'done'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
};

{
  const nvr = plugin();
  nvr.store.upsertEvent(event('no', 'играет в компьютер: нет'));
  nvr.store.upsertEvent(event('yes', 'играет в компьютер: да'));
  await nvr.start();
  await settle(nvr);
  assert.equal(nvr.store.meta('types_without_no_answers'), 'done');
  assert.deepEqual(typesOf(nvr, 'no'), ['motion', 'person']);
  assert.deepEqual(typesOf(nvr, 'yes'), ['motion', 'person', 'играет в компьютер']);
  assert.ok(said.some((line) => /out of the types of 1 older events/.test(line)), said.join('\n'));
  await nvr.stop();
}
{
  // the next start does not go through the events again: an event stored like an old one stays as it is
  said.length = 0;
  const nvr = plugin();
  nvr.store.upsertEvent(event('no-2', 'играет в компьютер: нет'));
  await nvr.start();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(typesOf(nvr, 'no-2'), ['motion', 'person', 'играет в компьютер']);
  assert.ok(!said.some((line) => /older events/.test(line)));
  await nvr.stop();
}

console.log('no-answer-types.spec: «нет» out of the types of older events once at the start — ok');
process.exit(0);
