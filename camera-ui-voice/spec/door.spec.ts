// "Who is at the door": names, strangers, the cooldown, quiet hours, a slow description. Run: npx tsx spec/door.spec.ts
import assert from 'node:assert/strict';

import { DESCRIBE_TIMEOUT_MS, DoorWatcher, FACE_WAIT_MS } from '../src/door.js';
import { checkDoorRule } from '../src/settings.js';
import { FakeClock, msk, runTests, test } from './helpers.js';

import type { DetectionEvent } from '@camera.ui/sdk';
import type { DoorRuleValues, PersonValues } from '../src/settings.js';
import type { WeeklyInterval } from '../src/time.js';

function setup(
  rule: DoorRuleValues = {},
  people: PersonValues[] = [],
  describe?: (timeoutMs: number, clock: FakeClock) => Promise<string | undefined>,
  quiet: WeeklyInterval[] = [],
) {
  const clock = new FakeClock(msk('2026-10-07T18:00:00'));
  const said: { speaker: string; text: string }[] = [];
  const logs: string[] = [];
  const checked = checkDoorRule({ doorCameras: ['door'], speakers: ['kids'], ...rule }, ['door', 'kids'], ['kids']);
  assert.ok(checked.value, checked.errors.join('; '));
  const watcher = new DoorWatcher({
    clock,
    timeZone: () => 'Europe/Moscow',
    language: () => 'ru',
    people: () => people,
    rules: () => [checked.value!],
    quiet: () => quiet,
    say: async (speaker, text) => {
      said.push({ speaker, text });
      return { status: 'spoken' };
    },
    describe: async (_camera, _language, timeoutMs) => (describe ? describe(timeoutMs, clock) : undefined),
    log: (message) => logs.push(message),
  });
  return { clock, said, logs, watcher };
}

let seq = 0;
function event(face?: string, label = 'person', cameraId = 'door'): DetectionEvent {
  return {
    id: `e${++seq}`,
    cameraId,
    state: 'active',
    startTime: 0,
    lastUpdate: 0,
    types: [label],
    triggers: [{ type: 'object' as never, label, firstSeen: 0, lastSeen: 0 }],
    segments: [{ firstSeen: 0, lastSeen: 0, detections: [{ label, score: 0.9, maxCount: 1 }], attributes: face ? [{ type: 'face', label: face }] : [] }],
  };
}

test('11. a known face: "Пришёл папа"; she: "Пришла мама"; no gender given: "У двери Оля"', async () => {
  const s = setup({}, [
    { name: 'папа', gender: 'male' },
    { name: 'мама', gender: 'female' },
  ]);
  for (const face of ['папа', 'мама', 'Оля']) {
    s.watcher.onEvent('start', event(face));
    await s.clock.advance(FACE_WAIT_MS + 10);
  }
  assert.deepEqual(
    s.said.map((x) => x.text),
    ['Пришёл папа.', 'Пришла мама.', 'У двери Оля.'],
  );
  assert.deepEqual([...new Set(s.said.map((x) => x.speaker))], ['kids']);
});

test('11b. an unknown face: "У двери незнакомый человек"; the face recognized a moment after the start still counts', async () => {
  const s = setup();
  s.watcher.onEvent('start', event('unknown'));
  await s.clock.advance(FACE_WAIT_MS + 10);
  assert.deepEqual(
    s.said.map((x) => x.text),
    ['У двери незнакомый человек.'],
  );

  const late = event();
  s.watcher.onEvent('start', late);
  await s.clock.advance(1_000);
  s.watcher.onEvent('update', { ...late, segments: [{ ...late.segments[0], attributes: [{ type: 'face', label: 'Оля' }] }] });
  await s.clock.advance(FACE_WAIT_MS);
  assert.equal(s.said[1].text, 'У двери Оля.');
});

test('11c. the same person again within the cooldown is not said; after it, it is', async () => {
  const s = setup({ cooldownSeconds: 120 });
  s.watcher.onEvent('start', event('Оля'));
  await s.clock.advance(FACE_WAIT_MS + 10);
  s.watcher.onEvent('start', event('Оля'));
  await s.clock.advance(60_000);
  assert.equal(s.said.length, 1);
  // 130 s after the first phrase
  await s.clock.advance(65_000);
  s.watcher.onEvent('start', event('Оля'));
  await s.clock.advance(FACE_WAIT_MS + 10);
  assert.equal(s.said.length, 2);
});

test('11d. only the start of an event speaks, not its updates', async () => {
  const s = setup({ cooldownSeconds: 0 });
  const e = event('Оля');
  s.watcher.onEvent('start', e);
  await s.clock.advance(FACE_WAIT_MS + 10);
  for (let i = 0; i < 5; i++) s.watcher.onEvent('update', e);
  s.watcher.onEvent('end', e);
  await s.clock.advance(10_000);
  assert.equal(s.said.length, 1);
});

test('11e. in the quiet hours of the rule nothing is said', async () => {
  const s = setup({ quietFrom: '17:00', quietTo: '19:00' });
  s.watcher.onEvent('start', event('Оля'));
  await s.clock.advance(FACE_WAIT_MS + 10);
  assert.equal(s.said.length, 0);
  assert.match(s.logs[0], /quiet hours/);
});

test('11f. a description that does not come within 5 s: the phrase without it', async () => {
  const s = setup({ describe: true }, [], (timeoutMs, clock) => {
    assert.equal(timeoutMs, DESCRIBE_TIMEOUT_MS);
    // the assistant gives up at its timeout, as assistantAsk does
    return new Promise((resolve) => clock.setTimeout(() => resolve(undefined), timeoutMs));
  });
  s.watcher.onEvent('start', event('unknown'));
  await s.clock.advance(FACE_WAIT_MS + DESCRIBE_TIMEOUT_MS + 10);
  assert.deepEqual(
    s.said.map((x) => x.text),
    ['У двери незнакомый человек.'],
  );

  const quick = setup({ describe: true }, [], async () => 'У двери курьер с коробкой');
  quick.watcher.onEvent('start', event('unknown'));
  await quick.clock.advance(FACE_WAIT_MS + 10);
  assert.deepEqual(
    quick.said.map((x) => x.text),
    ['У двери курьер с коробкой'],
  );
});

test('11g. other cameras and other labels do not speak', async () => {
  const s = setup();
  s.watcher.onEvent('start', event('Оля', 'person', 'garden'));
  s.watcher.onEvent('start', event(undefined, 'vehicle'));
  await s.clock.advance(FACE_WAIT_MS + 10);
  assert.equal(s.said.length, 0);
});

test('11h. the quiet hours of VOICE silence the door too', async () => {
  const s = setup({}, [], undefined, [{ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], from: '17:00', to: '19:00' }]);
  s.watcher.onEvent('start', event('Оля'));
  await s.clock.advance(FACE_WAIT_MS + 10);
  assert.equal(s.said.length, 0);
});

void runTests();
