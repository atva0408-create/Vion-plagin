// The AI describer alone (src/describer.ts) with a fake assistant model: the hourly limit is spent only by events
// that reach the model, an event pushed out of a full queue is named in the log, and the missing permission is
// said once instead of with every event.
// Run: npx tsx spec/describer.spec.ts
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { EventDescriber } from '../src/describer.js';

import type { AskResult } from '../src/describer.js';
import type { RecordedEvent } from '../src/types.js';

interface Setup {
  allowed?: () => boolean;
  /** Resolves when the model may be asked about its permission: holds the queue while pending. */
  gate?: () => Promise<void>;
  pictures?: (event: RecordedEvent) => Uint8Array[];
  maxPerHour?: number;
  answer?: (prompt: string) => AskResult;
}

const picture = new Uint8Array([0xff, 0xd8, 1, 2, 3]);

function make(setup: Setup = {}) {
  const logs: { level: string; message: string }[] = [];
  const asked: string[] = [];
  const saved: string[] = [];
  const describer = new EventDescriber(new DatabaseSync(':memory:'), {
    ask: async (request) => {
      asked.push(request.prompt);
      return setup.answer?.(request.prompt) ?? { ok: true, json: { title: 'A person at the door', description: 'A person walked up to the door.', tags: ['person'] } };
    },
    access: async () => {
      await setup.gate?.();
      return { allowed: setup.allowed?.() ?? true, model: 'test-model', vision: true, language: 'en' };
    },
    pictures: (event) => setup.pictures?.(event) ?? [picture],
    cameraName: (cameraId) => cameraId,
    settings: () => ({ enabled: true, notify: false, maxPerHour: setup.maxPerHour ?? 0 }),
    save: (eventId) => void saved.push(eventId),
    notify: async () => undefined,
    log: (level, message) => void logs.push({ level, message }),
  });
  /** Waits until the queue has been worked through. */
  const idle = async () => {
    const state = describer as unknown as { running: boolean };
    do await new Promise((resolve) => setTimeout(resolve, 5));
    while (state.running);
  };
  return { describer, logs, asked, saved, idle };
}

const event = (id: string) =>
  ({
    id,
    cameraId: 'door',
    state: 'ended',
    startTime: 1_700_000_000_000,
    endTime: 1_700_000_005_000,
    types: ['person'],
    triggers: [],
    segments: [{ firstSeen: 1, lastSeen: 2, detections: [{ label: 'person', score: 0.9 }], attributes: [] }],
  }) as unknown as RecordedEvent;

// ------------------------------------------------------------------ the hourly limit

{
  // three events without a picture never reach the model: the two calls of the hour go to the events after them
  const { describer, asked, saved, idle } = make({ maxPerHour: 2, pictures: (e) => (e.id.startsWith('blank') ? [] : [picture]) });
  for (const id of ['blank-1', 'blank-2', 'blank-3', 'seen-1', 'seen-2', 'seen-3']) describer.offer(event(id));
  await idle();
  assert.deepEqual(saved, ['seen-1', 'seen-2'], 'events that never reached the model did not use the limit up');
  assert.equal(asked.length, 2, 'the limit itself holds');
}
{
  // the same for events that came while the permission was missing
  let allowed = false;
  const { describer, saved, idle } = make({ maxPerHour: 1, allowed: () => allowed });
  describer.offer(event('denied-1'));
  describer.offer(event('denied-2'));
  await idle();
  allowed = true;
  describer.offer(event('granted'));
  await idle();
  assert.deepEqual(saved, ['granted']);
}
{
  // a call the model failed is still a call
  const { describer, asked, saved, idle } = make({ maxPerHour: 1, answer: () => ({ ok: false, reason: 'timeout' }) });
  describer.offer(event('failed'));
  describer.offer(event('next'));
  await idle();
  assert.equal(asked.length, 1);
  assert.deepEqual(saved, []);
}
{
  // «Описать ИИ» by hand is not limited and takes nothing from the automatic descriptions
  const { describer, asked, saved, idle } = make({ maxPerHour: 1 });
  for (const id of ['by-hand-1', 'by-hand-2', 'by-hand-3']) assert.ok(await describer.describe(event(id)), id);
  describer.offer(event('automatic'));
  await idle();
  assert.equal(asked.length, 4);
  assert.equal(saved.at(-1), 'automatic');
}

// ------------------------------------------------------------------ a full queue

{
  const open = gate();
  const { describer, logs, saved, idle } = make({ gate: () => open.promise });
  // the first event is being described (held at the model), fifty more fill the queue, the next one pushes the oldest out
  for (let i = 0; i <= 50; i++) describer.offer(event(`e${i}`));
  assert.equal(logs.length, 0, 'a queue that just fits drops nothing');
  describer.offer(event('e51'));
  const drops = logs.filter((l) => l.level === 'warn');
  assert.equal(drops.length, 1, 'the event pushed out of the queue is in the log');
  assert.match(drops[0].message, /\be1\b/, 'by its id');
  open.release();
  await idle();
  assert.equal(saved.length, 51);
  assert.equal(saved.includes('e1'), false, 'and it is the oldest waiting one');
  assert.equal(saved[0], 'e0');
  assert.equal(saved.at(-1), 'e51');
}

/** A promise the spec resolves when it wants the queue to move. */
function gate(): { promise: Promise<void>; release: () => void } {
  let release = () => undefined as void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

// ------------------------------------------------------------------ the missing permission

{
  let allowed = false;
  const { describer, logs, saved, idle } = make({ allowed: () => allowed });
  const warnings = () => logs.filter((l) => l.level === 'warn' && l.message.includes('not allowed')).length;
  for (let i = 0; i < 5; i++) describer.offer(event(`denied-${i}`));
  await idle();
  assert.equal(warnings(), 1, 'said once, not with every event');
  assert.deepEqual(saved, []);
  allowed = true;
  describer.offer(event('granted'));
  await idle();
  assert.deepEqual(saved, ['granted']);
  // taken away again: that is news, said once more
  allowed = false;
  describer.offer(event('denied-again-1'));
  describer.offer(event('denied-again-2'));
  await idle();
  assert.equal(warnings(), 2);
}

console.log('describer.spec: hourly limit counts model calls, full queue, permission warning — ok');
process.exit(0);
