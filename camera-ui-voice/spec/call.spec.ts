// VOICE called by name: what counts as «ВиОН» and the microphone kept open for it. Run: npx tsx spec/call.spec.ts
import assert from 'node:assert/strict';

import { CallListener, MAX_CALL_MS, QUESTION_WAIT_MS, calledWith } from '../src/call.js';
import { FakeClock, FakeEngine, fakeCamera, runTests, test } from './helpers.js';

import type { CallDeps } from '../src/call.js';

test('the name as the Russian recognizer wrote it for «ВиОН» (bench, VOICE voice): the words after it are the question', () => {
  const heard: [string, string][] = [
    ['вион сколько мне ещё отдыхать', 'сколько мне еще отдыхать'],
    ['леон когда можно играть', 'когда можно играть'],
    ['лион когда можно играть', 'когда можно играть'],
    ['реон когда можно играть', 'когда можно играть'],
    ['рион', ''],
    ['прион', ''],
    ['верон дай ещё поиграть', 'дай еще поиграть'],
    ['рейон', ''],
    ['вион', ''],
    ['ви он сколько времени осталось', 'сколько времени осталось'],
    ['эй вион сколько мне ещё', 'сколько мне еще'],
    ['Вион, сколько мне ещё отдыхать?', 'сколько мне еще отдыхать'],
  ];
  for (const [text, question] of heard) assert.equal(calledWith(text, 'ru'), question, text);
});

test('ordinary phrases of a room do not call VOICE, nor what the recognizer also wrote for the name', () => {
  const phrases = [
    'вот он идёт',
    'вон там лежит',
    'блин опять проиграл',
    'лена иди есть',
    'вино в холодильнике',
    'видео посмотри',
    'вин код машины',
    'вин когда можно играть',
    'лен дай ещё поиграть',
    'район',
    'вы он',
    'ведь он прав',
    'в июне поедем',
    'ну и вот он сказал',
    'а он',
    'и он',
    'леонид пришёл',
    'галеты иди сюда',
    '',
  ];
  for (const text of phrases) assert.equal(calledWith(text, 'ru'), undefined, text);
  assert.equal(calledWith('вион сколько', 'en'), undefined, 'the name is known in Russian only');
});

function setup() {
  const clock = new FakeClock(0);
  const engine = new FakeEngine();
  const camera = fakeCamera('kids', undefined, clock);
  const calls: [string, string][] = [];
  const logs: string[] = [];
  let transcribed = 0;
  const transcribe = engine.transcribe.bind(engine);
  engine.transcribe = async () => {
    transcribed++;
    return transcribe();
  };
  const deps: CallDeps & { isBusy: boolean; opened: number } = {
    clock,
    engine,
    isBusy: false,
    opened: 0,
    open: async () => {
      deps.opened++;
      return camera.hear();
    },
    busy: () => deps.isBusy,
    language: () => 'ru',
    onCall: (_cameraId, question, heard) => void calls.push([question, heard]),
    name: () => camera.name,
    log: (message) => logs.push(message),
  };
  const listener = new CallListener(deps);
  return { clock, engine, camera, calls, logs, deps, listener, transcribed: () => transcribed };
}

test('a call is recognized and answered; a phrase without the name goes nowhere, not even to the log', async () => {
  const s = setup();
  s.listener.want('kids', true);
  s.listener.want('kids', true);
  await s.clock.advance(0);
  assert.equal(s.deps.opened, 1, 'one microphone however often it is wanted');
  s.engine.heard.push('мама я поел', 'вион сколько мне ещё отдыхать');
  s.camera.utter(2);
  await s.clock.advance(0);
  s.camera.utter(3);
  await s.clock.advance(0);
  assert.deepEqual(s.calls, [['сколько мне еще отдыхать', 'вион сколько мне ещё отдыхать']]);
  assert.equal(s.logs.length, 0, s.logs.join(' | '));
  assert.equal(s.listener.stateOf('kids').state, 'listening');
});

test('while VOICE speaks the microphone hears VOICE: nothing is recognized; long sound is not recognized either', async () => {
  const s = setup();
  s.listener.want('kids', true);
  await s.clock.advance(0);
  s.engine.heard.push('вион сколько');
  s.deps.isBusy = true;
  s.camera.utter(2);
  await s.clock.advance(0);
  s.deps.isBusy = false;
  s.camera.utter(MAX_CALL_MS / 1000 + 1);
  await s.clock.advance(0);
  assert.equal(s.transcribed(), 0);
  assert.deepEqual(s.calls, []);
});

test('the name alone: the next phrase is the question; with none, the child is answered after a pause', async () => {
  const s = setup();
  s.listener.want('kids', true);
  await s.clock.advance(0);
  s.engine.heard.push('вион', 'сколько мне ещё отдыхать');
  s.camera.utter(1);
  await s.clock.advance(1_000);
  assert.deepEqual(s.calls, [], 'waits for the question');
  s.camera.utter(2);
  await s.clock.advance(0);
  assert.deepEqual(s.calls, [['сколько мне ещё отдыхать', 'сколько мне ещё отдыхать']]);
  await s.clock.advance(QUESTION_WAIT_MS * 2);
  assert.equal(s.calls.length, 1, 'answered once');

  s.engine.heard.push('леон');
  s.camera.utter(1);
  await s.clock.advance(QUESTION_WAIT_MS - 100);
  assert.equal(s.calls.length, 1);
  await s.clock.advance(200);
  assert.deepEqual(s.calls[1], ['', 'леон']);
});

test('the name alone and the child still talking: the answer waits for the question', async () => {
  const s = setup();
  s.listener.want('kids', true);
  await s.clock.advance(0);
  s.engine.heard.push('вион', 'а когда можно играть');
  s.camera.utter(1);
  await s.clock.advance(0);
  s.camera.sounds[0].vad.saying = true;
  await s.clock.advance(QUESTION_WAIT_MS + 1_500);
  assert.deepEqual(s.calls, []);
  s.camera.sounds[0].vad.saying = false;
  s.camera.utter(2);
  await s.clock.advance(0);
  assert.deepEqual(s.calls, [['а когда можно играть', 'а когда можно играть']]);
});

test('VOICE speaking after the name alone drops the wait: its phrase is no question', async () => {
  const s = setup();
  s.listener.want('kids', true);
  await s.clock.advance(0);
  s.engine.heard.push('вион');
  s.camera.utter(1);
  await s.clock.advance(0);
  s.listener.deafen('kids', 1_500);
  await s.clock.advance(QUESTION_WAIT_MS * 2);
  assert.deepEqual(s.calls, []);
  s.engine.heard.push('мама я поел');
  s.camera.utter(2);
  await s.clock.advance(0);
  assert.deepEqual(s.calls, [], 'a phrase of the room later is no question');
});

test('sound that cannot open is tried again later and later, logged once; working sound starts the delays over', async () => {
  const s = setup();
  s.camera.soundError = 'Output file #0 does not contain any stream';
  s.listener.want('kids', true);
  await s.clock.advance(0);
  assert.equal(s.deps.opened, 1);
  assert.equal(s.listener.stateOf('kids').state, 'failing');
  await s.clock.advance(5_000);
  assert.equal(s.deps.opened, 2);
  await s.clock.advance(14_000);
  assert.equal(s.deps.opened, 2, 'the second wait is longer');
  await s.clock.advance(1_000);
  assert.equal(s.deps.opened, 3);
  assert.equal(s.logs.length, 1, s.logs.join(' | '));
  assert.match(s.logs[0], /Детская: listening for a call failed/);

  s.camera.soundError = undefined;
  await s.clock.advance(60_000);
  assert.equal(s.deps.opened, 4);
  assert.equal(s.listener.stateOf('kids').state, 'listening');
  await s.clock.advance(120_000);
  s.camera.sounds[0].end('ffmpeg exit 1');
  await s.clock.advance(5_000);
  assert.equal(s.deps.opened, 5, 'sound that had worked is opened again after the first delay');
});

test('closed: the sound stops and is not opened again; closed while it opened, it is stopped at once', async () => {
  const s = setup();
  s.listener.want('kids', true);
  await s.clock.advance(0);
  s.listener.want('kids', false);
  assert.equal(s.camera.sounds[0].stopped, true);
  await s.clock.advance(10 * 60_000);
  assert.equal(s.deps.opened, 1);
  assert.equal(s.listener.stateOf('kids').state, 'off');

  s.listener.want('kids', true);
  s.listener.want('kids', false);
  await s.clock.advance(0);
  assert.equal(s.deps.opened, 2);
  assert.equal(s.camera.sounds[1].stopped, true, 'the microphone does not stay open after all');
});

void runTests();
