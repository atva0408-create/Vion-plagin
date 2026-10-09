/**
 * Phrases of one camera, one at a time: the second waits for the first, and more than the limit a minute are dropped,
 * so a storm of events cannot make the camera talk without a pause.
 */
import type { SpeakResult } from './speaker.js';
import type { Clock } from './clock.js';

export interface QueueItem {
  text: string;
  /** Says it; the queue calls it when the camera is free. */
  run: () => Promise<SpeakResult>;
}

export class PhraseQueue {
  private accepted: number[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private pending = 0;

  constructor(
    private clock: Clock,
    private perMinute: () => number,
    private log: (message: string) => void,
  ) {}

  /** Resolves when the phrase was said, or at once with `busy` when it is over the limit. */
  add(item: QueueItem): Promise<SpeakResult> {
    if (this.stopped) return Promise.resolve({ status: 'failed', reason: 'the phrase queue was stopped' });
    const now = this.clock.now();
    this.accepted = this.accepted.filter((at) => now - at < 60_000);
    const limit = this.perMinute();
    // phrases still waiting count too: behind a camera blocked for minutes the per-minute window empties, and the
    // queue would grow without end
    if (this.accepted.length >= limit || this.pending >= limit) {
      this.log(`dropped (more than ${limit} phrases a minute): ${item.text}`);
      return Promise.resolve({ status: 'busy', reason: `more than ${limit} phrases a minute on this camera` });
    }
    this.accepted.push(now);
    this.pending++;
    const run = this.tail.then(async (): Promise<SpeakResult> => {
      try {
        if (this.stopped) return { status: 'failed', reason: 'the phrase queue was stopped' };
        return await item.run();
      } catch (error) {
        // a `run` that throws before its promise (a bad source) must not leave the phrases behind it rejected
        return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
      } finally {
        this.pending--;
      }
    });
    this.tail = run;
    return run;
  }

  /** The camera is gone or the plugin stops: the phrases still waiting are not said, new ones are refused. */
  stop(): void {
    this.stopped = true;
  }
}
