// Fakes for the specs: a clock moved by hand, a speech engine, cameras, the LLM. Run a spec with: npx tsx spec/<name>.spec.ts
import type { AssistantAskRequest, AssistantAskResult, Notification } from '@camera.ui/sdk';
import type { Audio, SpeechEngine, VoiceActivity } from '../src/engine.js';
import type { Sighting } from '../src/presence.js';
import type { SpeakResult } from '../src/speaker.js';
import type { Clock } from '../src/time.js';
import type { CameraPort } from '../src/voice.js';

export const tests: [string, () => Promise<void> | void][] = [];
export function test(name: string, run: () => Promise<void> | void): void {
  tests.push([name, run]);
}

export async function runTests(): Promise<void> {
  setTimeout(() => {
    console.error('not ok - the specs hang');
    process.exit(1);
  }, 120_000).unref();
  // a test waiting on a promise nothing will resolve lets Node exit quietly with 0: count that as a failure
  let finished = false;
  let current = '';
  process.on('exit', () => {
    if (finished) return;
    console.log(`not ok - ${current} (never finished)`);
    process.exitCode = 1;
  });
  let passed = 0;
  for (const [name, run] of tests) {
    current = name;
    try {
      await run();
      passed++;
      console.log(`ok - ${name}`);
    } catch (error) {
      console.log(`not ok - ${name}`);
      console.log(error);
    }
  }
  finished = true;
  console.log(`${passed}/${tests.length} passed`);
  if (passed !== tests.length) process.exit(1);
}

export const flush = async (rounds = 5) => {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
};

export class FakeClock implements Clock {
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private seq = 0;
  constructor(public t: number) {}
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.push({ at: this.t + Math.max(0, ms), fn, id });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  }
  /** Moves time forward, running every timer that falls due on the way, in order. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      await flush();
      const due = this.timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((timer) => timer !== due);
      this.t = Math.max(this.t, due.at);
      due.fn();
    }
    this.t = end;
    await flush();
  }
}

export class FakeEngine implements SpeechEngine {
  said: string[] = [];
  heard: string[] = [];
  async synthesize(text: string): Promise<Audio> {
    this.said.push(text);
    return { samples: new Float32Array(1600), sampleRate: 16_000 };
  }
  async transcribe(): Promise<string> {
    return this.heard.shift() ?? '';
  }
  async voiceActivity(): Promise<VoiceActivity> {
    throw new Error('not used: the fake camera listens');
  }
}

export interface FakeCamera extends CameraPort {
  spoken: number;
  problemText?: string;
  answers: (Float32Array | undefined)[];
  snapshots: number;
}

export function fakeCamera(
  id = 'kids',
  zone: [number, number][] = [
    [0, 0],
    [50, 0],
    [50, 100],
    [0, 100],
  ],
): FakeCamera {
  const camera: FakeCamera = {
    id,
    name: id === 'kids' ? 'Детская' : id,
    spoken: 0,
    answers: [],
    snapshots: 0,
    speaker: {
      problem: () => camera.problemText,
      speak: async (): Promise<SpeakResult> => {
        camera.spoken++;
        return { status: 'spoken' };
      },
    },
    zone: (name) => (name === 'desk' ? zone : undefined),
    snapshot: async () => {
      camera.snapshots++;
      return new Uint8Array([0xff, 0xd8, 0xff]);
    },
    listen: async () => camera.answers.shift(),
  };
  return camera;
}

export const AT_DESK: Sighting = { detections: [{ label: 'person', box: { x: 0.1, y: 0.2, width: 0.2, height: 0.5 } }], faces: [], attributes: {} };
export const NOBODY: Sighting = { detections: [], faces: [], attributes: {} };

export type AskScript = (request: AssistantAskRequest) => AssistantAskResult | Promise<AssistantAskResult>;

export function fakeAsk(script: AskScript): { ask: (request: AssistantAskRequest) => Promise<AssistantAskResult>; requests: AssistantAskRequest[] } {
  const requests: AssistantAskRequest[] = [];
  return {
    requests,
    ask: async (request) => {
      requests.push(request);
      return script(request);
    },
  };
}

export const unconfigured: AskScript = () => ({ ok: false, reason: 'unconfigured', message: 'no model' });

export function collector(): { published: Notification[]; publish: (n: Notification) => Promise<void> } {
  const published: Notification[] = [];
  return { published, publish: async (n) => void published.push(n) };
}

/** Local time of Moscow (no daylight saving) as an instant. */
export function msk(isoLocal: string): number {
  return Date.parse(`${isoLocal}+03:00`);
}
