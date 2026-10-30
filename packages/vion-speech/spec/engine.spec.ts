// The engine over a fake sherpa-onnx: a voice activity that outlives the int32 counters of the native one, a model
// kept loaded while it works. Run: npx tsx spec/engine.spec.ts
import assert from 'node:assert/strict';

import { SherpaEngine } from '../src/engine.js';
import { Hearing } from '../src/listen.js';
import { FakeClock, flush, runTests, test } from './helpers.js';

import type { ModelStore } from '../src/models.js';

const INT32_MAX = 2 ** 31 - 1;

/**
 * The native voice activity as far as the engine sees it. A window whose first sample is not 0 is speech; an utterance
 * comes out as one sample, the number of its speech windows (the real one would be gigabytes here). Like sherpa-onnx
 * 1.13.8 it counts what it was given in int32 that only reset() zeroes; past 2^31 the real one writes outside its
 * buffer and the process dies, this one throws.
 */
class FakeVad {
  static made: FakeVad[] = [];
  tail = 0;
  /** The most samples it held count of at once. */
  most = 0;
  resets = 0;
  private windows = 0;
  private segments: { samples: Float32Array }[] = [];

  constructor() {
    FakeVad.made.push(this);
  }

  acceptWaveform(window: Float32Array): void {
    if (this.tail + window.length > INT32_MAX) throw new Error(`int32 overflow at ${this.tail + window.length} samples: the native buffer is written outside`);
    this.tail += window.length;
    this.most = Math.max(this.most, this.tail);
    if (window[0] !== 0) this.windows++;
    else this.end();
  }

  isDetected(): boolean {
    return this.windows > 0;
  }

  isEmpty(): boolean {
    return this.segments.length === 0;
  }

  front(): { samples: Float32Array } {
    return this.segments[0];
  }

  pop(): void {
    this.segments.shift();
  }

  flush(): void {
    this.end();
  }

  reset(): void {
    this.segments = [];
    this.windows = 0;
    this.tail = 0;
    this.resets++;
  }

  private end(): void {
    if (!this.windows) return;
    this.segments.push({ samples: Float32Array.of(this.windows) });
    this.windows = 0;
  }
}

const store = { ensure: async () => 'models' } as unknown as ModelStore;

function vadEngine() {
  FakeVad.made = [];
  return new SherpaEngine(
    store,
    () => {},
    () => ({ Vad: FakeVad }),
  );
}

/** 2^20 samples, about a minute at 16 kHz; fed again and again, more than 2^31 samples go in within seconds. */
const BLOCK = 2 ** 20;
const BLOCKS = 2 ** 31 / BLOCK + 64;

test('listening for more than 2^31 samples: the voice activity is reset between phrases, none is cut', async () => {
  const hearing = new Hearing(await vadEngine().voiceActivity(), new FakeClock(0));
  const heard: number[] = [];
  hearing.onUtterance((samples) => heard.push(samples[0]));
  // speech in the first and the last five windows of every block: a phrase of ten windows goes across each joint of
  // two blocks, and the counters pass 2^30 at a joint, in the middle of one
  const block = new Float32Array(BLOCK);
  block.fill(0.5, 0, 5 * 512);
  block.fill(0.5, BLOCK - 5 * 512);
  for (let i = 0; i < BLOCKS; i++) hearing.feed(block);
  hearing.end();
  const vad = FakeVad.made[0];
  assert.equal(FakeVad.made.length, 1);
  assert.ok(vad.resets >= 2, `reset ${vad.resets} times`);
  assert.ok(vad.most <= 2 ** 30 + BLOCK, `held ${vad.most} samples`);
  assert.equal(heard.length, BLOCKS + 1, 'every phrase came out, the ones after the resets too');
  assert.deepEqual(heard, [5, ...new Array<number>(BLOCKS - 1).fill(10), 5], 'none cut by a reset');
});

test('speech that never ends (a TV) is cut and the voice activity reset all the same, before 2^31; nothing is lost', async () => {
  const hearing = new Hearing(await vadEngine().voiceActivity(), new FakeClock(0));
  const heard: number[] = [];
  hearing.onUtterance((samples) => heard.push(samples[0]));
  const block = new Float32Array(BLOCK).fill(0.5);
  for (let i = 0; i < BLOCKS; i++) hearing.feed(block);
  const vad = FakeVad.made[0];
  assert.equal(vad.resets, 1);
  assert.ok(vad.most < INT32_MAX - BLOCK, `held ${vad.most} samples`);
  assert.equal(heard.length, 1, 'the phrase cut by the reset came out at once');
  hearing.end();
  assert.equal(heard.length, 2);
  assert.equal(heard[0] + heard[1], (BLOCKS * BLOCK) / 512, 'every window of speech is in one of the two');
});

test('a phrase and the end of the window still come out as before: utterances in order, the cut one at flush', async () => {
  const vad = await vadEngine().voiceActivity();
  const speech = new Float32Array(3 * 512).fill(0.5);
  vad.accept(speech.subarray(0, 700));
  assert.equal(vad.speaking(), true);
  vad.accept(speech.subarray(700));
  vad.accept(new Float32Array(512));
  vad.accept(speech.subarray(0, 1024));
  assert.deepEqual([...(vad.utterance() ?? [])], [3]);
  assert.equal(vad.utterance(), undefined);
  vad.flush();
  assert.deepEqual([...(vad.utterance() ?? [])], [2]);
  assert.equal(FakeVad.made[0].resets, 0);
});

/** A recognizer whose decodings end when the spec says. */
function recognizerEngine(idleMs: number) {
  const decodings: (() => void)[] = [];
  const logs: string[] = [];
  let loads = 0;
  const sherpa = {
    OfflineRecognizer: {
      createAsync: async () => {
        loads++;
        return {
          createStream: () => ({ acceptWaveform: () => {} }),
          decodeAsync: () => new Promise<{ text: string }>((resolve) => decodings.push(() => resolve({ text: ' привет ' }))),
        };
      },
    },
  };
  const engine = new SherpaEngine(
    store,
    (message) => logs.push(message),
    () => sherpa,
    idleMs,
  );
  const unloaded = () => logs.some((line) => line.includes('speech model ru unloaded'));
  return { engine, decodings, logs, unloaded, loads: () => loads };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('a model is not let go while a recognition runs on it, and is once the last one ended and the idle time passed', async () => {
  const s = recognizerEngine(20);
  const first = s.engine.transcribe(new Float32Array(16), 'ru');
  await flush();
  assert.equal(s.decodings.length, 1);
  await sleep(80);
  assert.equal(s.unloaded(), false, 'not under the first recognition');
  const second = s.engine.transcribe(new Float32Array(16), 'ru');
  await flush();
  assert.equal(s.loads(), 1, 'the second recognition runs on the same model');
  s.decodings[0]();
  assert.equal(await first, 'привет');
  await sleep(80);
  assert.equal(s.unloaded(), false, 'not under the second, which still runs after the first ended');
  s.decodings[1]();
  assert.equal(await second, 'привет');
  await sleep(80);
  assert.equal(s.unloaded(), true, s.logs.join('; '));
  const third = s.engine.transcribe(new Float32Array(16), 'ru');
  await flush();
  assert.equal(s.loads(), 2, 'loaded again after it was let go');
  s.decodings[2]();
  assert.equal(await third, 'привет');
});

void runTests();
