// Fakes for the specs: a test runner and a clock moved by hand. Run a spec with: npx tsx spec/<name>.spec.ts
import type { Clock } from '../src/clock.js';

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
