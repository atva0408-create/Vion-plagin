import assert from 'node:assert/strict';

import { CameraSpeaker, PACKET_MS, PhraseQueue, sendPaced } from '@vionvision/speech';

import { DoorWatcher, FACE_WAIT_MS } from '../src/door.js';
import { ScreenTimeEngine, freshState } from '../src/screenTime.js';
import { checkScreenTime } from '../src/settings.js';
import { restoreScreenTime } from '../src/state.js';
import { MINUTE } from '../src/time.js';
import { Voice } from '../src/voice.js';
import { AT_DESK, FakeClock, FakeEngine, collector, fakeCamera, flush, msk, runTests, test } from './helpers.js';

import type { SpeakResult } from '@vionvision/speech';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function setup() {
  const clock = new FakeClock(msk('2026-10-08T15:00:00'));
  const engine = new FakeEngine();
  const camera = fakeCamera();
  const notifications = collector();
  const deps = {
    clock,
    engine,
    ...notifications,
    ask: async () => ({ ok: false as const, reason: 'unconfigured' as const, message: '' }),
    timeZone: () => 'Europe/Moscow',
    language: () => 'ru' as const,
    speed: () => 1,
    listenSeconds: () => 10,
    maxPerMinute: () => 6,
    quiet: () => [],
    saveState: async () => {},
    log: () => {},
  };
  const voice = new Voice(deps);
  voice.addCamera(camera);
  const checked = checkScreenTime({ childName: 'Артём', sessionMinutes: 5, answerQuestions: false, schoolFrom: '', schoolTo: '', freeFrom: '', freeTo: '' }, []);
  assert.ok(checked.value);
  voice.setScreenTime(camera.id, [checked.value]);
  const remind = async () => {
    for (let i = 0; i < 63; i++) {
      await voice.look(camera.id, AT_DESK);
      await clock.advance(5_000);
    }
  };
  return { clock, engine, camera, deps, voice, config: checked.value, remind };
}

test('removing and re-adding a camera during synthesis cancels old and queued phrases', async () => {
  const s = setup();
  const audio = deferred<{ samples: Float32Array; sampleRate: number }>();
  s.engine.synthesize = () => audio.promise;
  const first = s.voice.say(s.camera.id, 'first');
  const second = s.voice.say(s.camera.id, 'second');
  await flush();
  s.voice.removeCamera(s.camera.id);
  s.voice.addCamera(s.camera);
  audio.resolve({ samples: new Float32Array(160), sampleRate: 8000 });
  assert.equal((await first).status, 'failed');
  assert.equal((await second).status, 'failed');
  assert.equal(s.camera.spoken, 0);
});

for (const change of ['disable', 'grant', 'leave'] as const) {
  test(`a reminder delayed by the assistant is cancelled when the child/scenario changes: ${change}`, async () => {
    const s = setup();
    const answer = deferred<any>();
    s.deps.ask = () => answer.promise;
    await s.remind();
    if (change === 'disable') s.voice.setScreenTime(s.camera.id, [{ ...s.config, enabled: false }]);
    if (change === 'grant') s.voice.extend(`${s.camera.id}/${s.config.id}`, 30, false);
    if (change === 'leave') {
      for (let i = 0; i < 26; i++) {
        await s.clock.advance(5_000);
        await s.voice.look(s.camera.id, { detections: [], faces: [], attributes: {} });
      }
    }
    answer.resolve({ ok: false, reason: 'unconfigured', message: '' });
    await flush();
    assert.equal(s.camera.spoken, 0);
  });
}

test('literal phrases have the same length limit as assistant and notification phrases', async () => {
  const s = setup();
  assert.equal((await s.voice.say(s.camera.id, 'a'.repeat(301))).status, 'failed');
  assert.equal((await s.voice.say(s.camera.id, '   ')).status, 'failed');
  assert.equal(s.engine.said.length, 0);
});

test('an assistant RPC exception is a failed instructed phrase, not a rejected call', async () => {
  const s = setup();
  s.deps.ask = async () => {
    throw new Error('RPC disconnected');
  };
  assert.equal((await s.voice.sayInstructed(s.camera.id, 'say hello')).status, 'failed');
});

test('granting time validates the runtime input even when form validation is bypassed', () => {
  const s = setup();
  for (const minutes of [-10, 241, Infinity, NaN]) {
    assert.throws(() => s.voice.extend(`${s.camera.id}/${s.config.id}`, minutes, false), /minutes/);
  }
  assert.equal(s.voice.scenariosOf(s.camera.id)[0].engine.state.grantUntil, undefined);
});

test('a synchronous phrase failure does not poison the camera queue', async () => {
  const queue = new PhraseQueue(
    new FakeClock(0),
    () => 6,
    () => {},
  );
  const first = queue.add({
    text: 'first',
    run: () => {
      throw new Error('bad source');
    },
  });
  const second = queue.add({ text: 'second', run: async () => ({ status: 'spoken' }) });
  // Observe both before awaiting: a rejected first otherwise leaves the second rejection unhandled.
  const results = await Promise.allSettled([first, second]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'fulfilled');
  if (results[1].status === 'fulfilled') assert.equal(results[1].value.status, 'spoken');
});

test('after a one-second timer stall RTP is paced rather than sent in a burst', async () => {
  const clock = new FakeClock(0);
  let timers = 0;
  const times: number[] = [];
  const pacedClock = {
    now: () => clock.now(),
    clearTimeout: (id: unknown) => clock.clearTimeout(id),
    setTimeout: (fn: () => void, ms: number) => clock.setTimeout(fn, ms + (++timers === 1 ? 1000 : 0)),
  };
  const done = sendPaced(
    Array.from({ length: 60 }, () => Buffer.alloc(172)),
    () => {
      times.push(clock.now());
    },
    pacedClock,
  );
  await clock.advance(3000);
  await done;
  assert.equal(times.length, 60);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= PACKET_MS);
});

test('closing a speaker while its stream opens cannot reopen it and send a late phrase', async () => {
  const clock = new FakeClock(0);
  const opening = deferred<void>();
  let packets = 0;
  let stops = 0;
  const session = {
    hasBackchannel: true,
    onError: { subscribe: () => ({ unsubscribe() {} }) },
    onEnded: { subscribe: () => ({ unsubscribe() {} }) },
    startStream: () => opening.promise,
    startBackchannel: async () => {},
    sendAudioPacket: async () => {
      packets++;
    },
    stop: async () => {
      stops++;
    },
  };
  const source = { backchannelAudioCodec: 'opus', createRtpSession: () => session };
  const speaker = new CameraSpeaker({ name: 'test', connected: true, sources: [source] } as never, clock, () => {});
  const result = speaker.speak(new Float32Array(160), 8000);
  await flush();
  await speaker.close();
  opening.resolve();
  await clock.advance(2000);
  assert.equal((await result).status, 'failed');
  assert.equal(packets, 0);
  assert.ok(stops >= 1);
  await speaker.close();
});

test('stopping the door watcher during a description suppresses the late announcement', async () => {
  const clock = new FakeClock(0);
  const description = deferred<string>();
  let said = 0;
  const watcher = new DoorWatcher({
    clock,
    timeZone: () => 'Europe/Moscow',
    language: () => 'ru',
    people: () => [],
    quiet: () => [],
    rules: () => [{ doorCameras: ['door'], speakers: ['kids'], labels: ['person'], describe: true, cooldownSeconds: 120, quiet: [] }],
    describe: () => description.promise,
    say: async () => {
      said++;
      return { status: 'spoken' };
    },
    log: () => {},
  });
  watcher.onEvent('start', { id: 'e', cameraId: 'door', triggers: [{ label: 'person' }] } as never);
  await clock.advance(FACE_WAIT_MS);
  watcher.stop();
  description.resolve('A courier');
  await flush();
  assert.equal(said, 0);
});

test('a partial break has one consistent end time in reminders, status and answers', () => {
  const at = msk('2026-10-08T15:00:00');
  const s = setup();
  const state = { ...freshState('2026-10-08'), workMs: 46 * MINUTE, present: true, leftAt: at };
  const engine = new ScreenTimeEngine(s.config, state);
  const facts = engine.facts(at + 4 * MINUTE, { timeZone: 'Europe/Moscow', language: 'ru' });
  assert.equal(facts.breakMinutesLeft, 6);
  assert.equal(facts.breakEndsAt, '15:10');
  assert.equal(facts.nextAllowedAt, '15:10');
});

test('shutdown aborts pending synthesis, queued phrases and future speaking', async () => {
  const s = setup();
  const audio = deferred<any>();
  s.engine.synthesize = () => audio.promise;
  const first = s.voice.say(s.camera.id, 'first');
  const second = s.voice.say(s.camera.id, 'second');
  await flush();
  s.voice.stop();
  assert.equal((await first).status, 'failed');
  assert.equal((await second).status, 'failed');
  assert.equal((await s.voice.say(s.camera.id, 'after shutdown')).status, 'failed');
  audio.resolve({ samples: new Float32Array(160), sampleRate: 8000 });
  await flush();
  assert.equal(s.camera.spoken, 0);
  s.voice.start();
  assert.equal((await s.voice.say(s.camera.id, 'after restart')).status, 'spoken');
});

test('removing the camera during listening cancels the conversation and a waiting outside phrase', async () => {
  const s = setup();
  s.voice.setScreenTime(s.camera.id, [{ ...s.config, answerQuestions: true }]);
  const audio = deferred<Float32Array>();
  let signal: AbortSignal | undefined;
  s.camera.listen = (_ms, cancel) => {
    signal = cancel;
    return audio.promise;
  };
  await s.remind();
  assert.ok(signal && !signal.aborted);
  const phrase = s.voice.say(s.camera.id, 'outside');
  await flush();
  s.voice.removeCamera(s.camera.id);
  assert.equal((await phrase).status, 'failed');
  assert.equal(signal.aborted, true);
  s.engine.heard.push('мама разрешила ещё час');
  audio.resolve(new Float32Array(160));
  await flush();
  assert.equal(s.camera.spoken, 1);
  assert.equal(s.deps.published.length, 0);
});

test('the pending phrase count stays bounded when a camera is blocked for several minutes', async () => {
  const clock = new FakeClock(0);
  const blocked = deferred<SpeakResult>();
  const queue = new PhraseQueue(
    clock,
    () => 2,
    () => {},
  );
  const first = queue.add({ text: 'first', run: () => blocked.promise });
  const second = queue.add({ text: 'second', run: async () => ({ status: 'spoken' }) });
  await clock.advance(60_001);
  assert.equal((await queue.add({ text: 'third', run: async () => ({ status: 'spoken' }) })).status, 'busy');
  queue.stop();
  blocked.resolve({ status: 'spoken' });
  await first;
  assert.equal((await second).status, 'failed');
});

test('a channel that ends during startup fails instead of reporting a silent phrase as spoken', async () => {
  const clock = new FakeClock(0);
  let ended = () => {};
  let stops = 0;
  let packets = 0;
  const session = {
    hasBackchannel: true,
    onError: { subscribe: () => ({ unsubscribe() {} }) },
    onEnded: {
      subscribe: (callback: () => void) => {
        ended = callback;
        return { unsubscribe() {} };
      },
    },
    startStream: async () => {
      ended();
    },
    startBackchannel: async () => {},
    sendAudioPacket: async () => {
      packets++;
    },
    stop: async () => {
      stops++;
    },
  };
  const source = { backchannelAudioCodec: 'opus', createRtpSession: () => session };
  const speaker = new CameraSpeaker({ name: 'test', connected: true, sources: [source] } as never, clock, () => {});
  const result = await speaker.speak(new Float32Array(160), 8000);
  assert.equal(result.status, 'failed');
  assert.equal(packets, 0);
  assert.equal(stops, 1);
});

test('malformed persisted state is discarded while valid children keep their counters', () => {
  const good = { ...freshState('2026-10-08'), present: true, todayMs: 1234 };
  for (const raw of [null, [], {}, { screenTime: null }, { screenTime: [] }]) assert.deepEqual(restoreScreenTime(raw), {});
  const screenTime = {
    good,
    null: null,
    missing: {},
    string: { ...good, todayMs: '100' },
    infinite: { ...good, workMs: Infinity },
    badHistory: { ...good, history: null },
    badEscalation: { ...good, escalation: { reason: 'break', level: 0 } },
  };
  assert.deepEqual(restoreScreenTime({ screenTime }), { good });
});

void runTests();
