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

  constructor(
    private clock: Clock,
    private perMinute: () => number,
    private log: (message: string) => void,
  ) {}

  /** Resolves when the phrase was said, or at once with `busy` when it is over the limit. */
  add(item: QueueItem): Promise<SpeakResult> {
    const now = this.clock.now();
    this.accepted = this.accepted.filter((at) => now - at < 60_000);
    const limit = this.perMinute();
    if (this.accepted.length >= limit) {
      this.log(`dropped (more than ${limit} phrases a minute): ${item.text}`);
      return Promise.resolve({ status: 'busy', reason: `more than ${limit} phrases a minute on this camera` });
    }
    this.accepted.push(now);
    const run = this.tail.then(() => item.run().catch((error: Error): SpeakResult => ({ status: 'failed', reason: error.message })));
    this.tail = run;
    return run;
  }
}
