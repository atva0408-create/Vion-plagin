// Listening: one answer in a window (ffmpeg faked), and a conversation heard, utterances as they end, nothing while the
// agent speaks. Run: npx tsx spec/listen.spec.ts
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { FfmpegListener, FloatChunks, Hearing, listenToCamera } from '../src/listen.js';
import { FakeClock, flush, runTests, test } from './helpers.js';

import type { SpeechEngine, VoiceActivity } from '../src/engine.js';

/** Voice activity that cuts an utterance at the first sample of value 0 after speech (any other value is speech). */
class FakeVad implements VoiceActivity {
  private current: number[] = [];
  private done: Float32Array[] = [];
  accept(samples: Float32Array): void {
    for (const sample of samples) {
      if (sample !== 0) this.current.push(sample);
      else if (this.current.length) {
        this.done.push(Float32Array.from(this.current));
        this.current = [];
      }
    }
  }
  utterance(): Float32Array | undefined {
    return this.done.shift();
  }
  speaking(): boolean {
    return this.current.length > 0;
  }
  flush(): void {
    if (this.current.length) this.done.push(Float32Array.from(this.current));
    this.current = [];
  }
}

test('each utterance comes out as it ends, several in one chunk too; the end of the sound gives the cut one', () => {
  const clock = new FakeClock(0);
  const hearing = new Hearing(new FakeVad(), clock);
  const heard: number[][] = [];
  hearing.onUtterance((samples) => heard.push([...samples]));
  hearing.feed(Float32Array.from([1, 1, 0, 2, 0, 3]));
  assert.deepEqual(heard, [[1, 1], [2]]);
  assert.equal(hearing.speaking(), true);
  hearing.end();
  assert.deepEqual(heard, [[1, 1], [2], [3]]);
});

test('deaf while the agent speaks: what comes then is dropped, and the phrase half heard when it began is thrown away', async () => {
  const clock = new FakeClock(0);
  const hearing = new Hearing(new FakeVad(), clock);
  const heard: number[][] = [];
  const audio: number[] = [];
  hearing.onUtterance((samples) => heard.push([...samples]));
  hearing.onAudio((samples) => audio.push(...samples));
  hearing.feed(Float32Array.from([5, 5]));
  hearing.deafUntil(1_000);
  hearing.feed(Float32Array.from([7, 0, 7, 0]));
  assert.deepEqual(heard, [], 'neither the cut phrase nor the echo');
  assert.equal(hearing.speaking(), false);
  await clock.advance(1_000);
  hearing.feed(Float32Array.from([9, 0]));
  assert.deepEqual(heard, [[9]]);
  assert.deepEqual(audio, [5, 5, 9, 0], 'the voice message keeps only what was heard');
});

test('a shorter deafness does not shorten a longer one', async () => {
  const clock = new FakeClock(0);
  const hearing = new Hearing(new FakeVad(), clock);
  hearing.deafUntil(2_000);
  hearing.deafUntil(500);
  await clock.advance(1_000);
  assert.equal(hearing.deaf(), true);
});

test('float chunks: a sample cut between chunks is joined', () => {
  const chunks = new FloatChunks();
  const bytes = Buffer.alloc(12);
  bytes.writeFloatLE(0.5, 0);
  bytes.writeFloatLE(-0.25, 4);
  bytes.writeFloatLE(1, 8);
  assert.deepEqual([...chunks.take(bytes.subarray(0, 6))], [0.5]);
  assert.deepEqual([...chunks.take(bytes.subarray(6))], [-0.25, 1]);
});

/** A listener whose ffmpeg is a fake process: the spec writes its output and closes it. */
function ffmpegSetup() {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let kills = 0;
  let spawned = 0;
  child.kill = () => {
    kills++;
    return true;
  };
  const vad = { accept: (_samples: Float32Array) => {}, utterance: (): Float32Array | undefined => undefined, speaking: () => false, flush: () => {} };
  const engine: SpeechEngine = {
    synthesize: async () => ({ samples: new Float32Array(0), sampleRate: 16_000 }),
    transcribe: async () => '',
    voiceActivity: async () => vad,
  };
  const logs: string[] = [];
  const listener = new FfmpegListener(
    async () => 'ffmpeg',
    engine,
    (message) => logs.push(message),
    (() => {
      spawned++;
      return child;
    }) as never,
  );
  const source = { audioCodecs: ['opus'], generateRTSPUrl: () => 'rtsp://127.0.0.1/test' };
  const camera = { name: 'test', sources: [source], streamSource: source };
  return { child, vad, engine, listener, camera, logs, kills: () => kills, spawned: () => spawned };
}

test('cancelling listening closes ffmpeg immediately and ignores late output/close events', async () => {
  const s = ffmpegSetup();
  const controller = new AbortController();
  const result = s.listener.listen(s.camera, 30_000, controller.signal);
  await flush();
  controller.abort();
  // the window would end the listening too, 30 s later: ffmpeg must be gone at the abort itself
  assert.equal(s.kills(), 1);
  assert.equal(await result, undefined);
  s.vad.accept = () => {
    throw new Error('late accept');
  };
  s.vad.flush = () => {
    throw new Error('late flush');
  };
  assert.doesNotThrow(() => s.child.stdout.write(Buffer.alloc(16)));
  assert.doesNotThrow(() => s.child.emit('close', 1));
  await flush();
  assert.equal(s.logs.length, 0);
});

test('cancelling during model preparation does not open a microphone afterwards', async () => {
  const s = ffmpegSetup();
  let ready!: () => void;
  s.engine.voiceActivity = async () => {
    await new Promise<void>((resolve) => (ready = resolve));
    return s.vad;
  };
  const controller = new AbortController();
  const result = s.listener.listen(s.camera, 30_000, controller.signal);
  await flush();
  controller.abort();
  ready();
  assert.equal(await result, undefined);
  assert.equal(s.spawned(), 0);
});

for (const where of ['accept', 'utterance', 'flush'] as const) {
  test(`a VAD exception in ${where} ends listening without crashing the plugin`, async () => {
    const s = ffmpegSetup();
    s.vad[where] = () => {
      throw new Error('invalid VAD state');
    };
    const result = s.listener.listen(s.camera, 30_000);
    await flush();
    assert.doesNotThrow(() => (where === 'flush' ? s.child.emit('close', 0) : s.child.stdout.write(Buffer.alloc(16))));
    assert.equal(await result, undefined);
    assert.equal(s.kills(), 1);
    assert.match(s.logs[0], /invalid VAD state/);
  });
}

test('partial float32 samples across ffmpeg chunks are assembled correctly', async () => {
  const s = ffmpegSetup();
  const accepted: number[] = [];
  s.vad.accept = (samples) => {
    accepted.push(...samples);
  };
  const result = s.listener.listen(s.camera, 30_000);
  await flush();
  const bytes = Buffer.alloc(12);
  [0.25, -0.5, 1].forEach((v, i) => bytes.writeFloatLE(v, i * 4));
  s.child.stdout.write(bytes.subarray(0, 3));
  s.child.stdout.write(bytes.subarray(3, 9));
  s.child.stdout.write(bytes.subarray(9));
  await flush();
  s.child.emit('close', 0);
  assert.equal(await result, undefined);
  assert.deepEqual(accepted, [0.25, -0.5, 1]);
});

test('the first complete utterance stops the stream and is returned for recognition', async () => {
  const s = ffmpegSetup();
  const samples = new Float32Array([0.2, 0.4]);
  s.vad.utterance = () => samples;
  const result = s.listener.listen(s.camera, 30_000);
  await flush();
  s.child.stdout.write(Buffer.alloc(16));
  await flush();
  // stopped at the utterance, not by the end of the window (which would return the same samples 30 s later)
  assert.equal(s.kills(), 1);
  assert.deepEqual(await result, samples);
});

test('open sound: voice activity that throws ends the sound with the reason instead of taking the plugin down', async () => {
  const s = ffmpegSetup();
  const open = await listenToCamera(async () => 'ffmpeg', s.engine, s.camera, new FakeClock(0), (() => s.child) as never);
  s.vad.accept = () => {
    throw new Error('vad state');
  };
  assert.doesNotThrow(() => s.child.stdout.write(Buffer.alloc(16)));
  await flush();
  assert.equal(s.kills(), 1, 'ffmpeg is closed');
  assert.doesNotThrow(() => s.child.stdout.write(Buffer.alloc(16)), 'later output is not fed again');
  s.child.emit('close', null);
  assert.equal(await open.ended, 'vad state');
});

test('open sound: stopped by its owner, the end carries no reason', async () => {
  const s = ffmpegSetup();
  const open = await listenToCamera(async () => 'ffmpeg', s.engine, s.camera, new FakeClock(0), (() => s.child) as never);
  open.stop();
  s.child.emit('close', null);
  assert.equal(await open.ended, undefined);
});

void runTests();
