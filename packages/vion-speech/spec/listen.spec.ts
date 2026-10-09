// Hearing a conversation: utterances as they end, nothing while the agent speaks. Run: npx tsx spec/listen.spec.ts
import assert from 'node:assert/strict';

import { FloatChunks, Hearing } from '../src/listen.js';
import { FakeClock, runTests, test } from './helpers.js';

import type { VoiceActivity } from '../src/engine.js';

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

void runTests();
